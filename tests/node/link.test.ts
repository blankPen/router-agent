import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createNodeApi } from '../../src/node/api.js'
import { DirectNodeAgentLink, RelayCenterLink, RelayNodeAgentLink } from '../../src/node/link.js'
import { NodeRegistry } from '../../src/node/registry.js'
import { createRelayServer } from '../../src/node/relay.js'
import type { NodeToCenterMessage } from '#core/node.js'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

function registry(): NodeRegistry {
  return new NodeRegistry({ devices: [{ id: 'macbook-air', name: 'MacBook Air', token: 'secret-air' }] })
}

async function startNodeApi(reg: NodeRegistry, received: NodeToCenterMessage[]): Promise<string> {
  const api = createNodeApi({
    registry: reg,
    onMessage: async (nodeId, message) => {
      received.push(message)
      return { status: 200, body: { ok: true } }
    },
    pollTimeoutMs: 2_000,
  })
  const server = createServer((req, res) => {
    api.handle(req, res).then(handled => {
      if (!handled) {
        res.writeHead(404).end()
      }
    })
  })
  return listen(server)
}

describe('节点链路', () => {
  it('直连：节点上报的消息到达中心，中心投递的任务被节点取到', async () => {
    const reg = registry()
    const received: NodeToCenterMessage[] = []
    const baseUrl = await startNodeApi(reg, received)
    const link = new DirectNodeAgentLink({ baseUrl, nodeId: 'macbook-air', token: 'secret-air' })

    await link.send({ kind: 'register', payload: { nodeId: 'macbook-air', name: 'MacBook Air', runtimes: ['claude-code'], projects: [] } })
    expect(received[0]!.kind).toBe('register')

    reg.enqueue('macbook-air', {
      kind: 'task',
      payload: {
        assignmentId: 'as_1',
        ticketId: 'tk-1',
        title: '标题',
        scope: '范围',
        project: 'router-agent',
        branch: 'main',
        workBranch: 'ra/tk-1',
      },
    })
    const messages = await link.receive(2_000)
    expect(messages[0]!.kind).toBe('task')
  })

  it('直连：密钥不对的节点被拒绝', async () => {
    const reg = registry()
    const received: NodeToCenterMessage[] = []
    const baseUrl = await startNodeApi(reg, received)
    const link = new DirectNodeAgentLink({ baseUrl, nodeId: 'macbook-air', token: 'wrong' })
    const result = await link.send({ kind: 'register', payload: { nodeId: 'macbook-air', name: '', runtimes: [], projects: [] } })
    expect(result.status).toBe(401)
    expect(received).toHaveLength(0)
  })

  it('中继：中心投递的任务经中继转发给节点，节点消息也经中继回到中心', async () => {
    const relay = createRelayServer({ port: 0, token: 'relay-secret', pollTimeoutMs: 2_000 })
    const relayUrl = await listen(relay.server)
    const nodeLink = new RelayNodeAgentLink({
      baseUrl: relayUrl,
      routerId: 'home',
      nodeId: 'macbook-air',
      relayToken: 'relay-secret',
    })
    const centerLink = new RelayCenterLink({ baseUrl: relayUrl, routerId: 'home', relayToken: 'relay-secret' })

    const task = {
      kind: 'task' as const,
      payload: {
        assignmentId: 'as_1',
        ticketId: 'tk-1',
        title: '标题',
        scope: '范围',
        project: 'router-agent',
        branch: 'main',
        workBranch: 'ra/tk-1',
      },
    }
    await centerLink.deliver('macbook-air', task)
    const received = await nodeLink.receive(2_000)
    expect(received[0]).toEqual(task)

    await nodeLink.send({ kind: 'register', payload: { nodeId: 'macbook-air', name: 'MacBook Air', runtimes: [], projects: [] } })
    const back = await centerLink.poll(2_000)
    expect(back[0]!.nodeId).toBe('macbook-air')
    expect(back[0]!.message.kind).toBe('register')
  })

  it('中继：中心正在轮询时，节点消息能立刻唤醒它', async () => {
    const relay = createRelayServer({ port: 0, token: 'relay-secret', pollTimeoutMs: 1_000 })
    const relayUrl = await listen(relay.server)
    const nodeLink = new RelayNodeAgentLink({ baseUrl: relayUrl, routerId: 'home', nodeId: 'macbook-air', relayToken: 'relay-secret' })
    const centerLink = new RelayCenterLink({ baseUrl: relayUrl, routerId: 'home', relayToken: 'relay-secret' })

    const polling = centerLink.poll(1_000)
    await nodeLink.send({ kind: 'register', payload: { nodeId: 'macbook-air', name: 'MacBook Air', runtimes: [], projects: [] } })
    const back = await polling
    expect(back[0]!.message.kind).toBe('register')
    // 同一条消息不能被处理两次：唤醒后它已经出队。
    const again = await centerLink.poll(300)
    expect(again).toEqual([])
  })

  it('中继：接入密钥不对的请求被拒绝', async () => {
    const relay = createRelayServer({ port: 0, token: 'relay-secret', pollTimeoutMs: 500 })
    const relayUrl = await listen(relay.server)
    const link = new RelayNodeAgentLink({ baseUrl: relayUrl, routerId: 'home', nodeId: 'macbook-air', relayToken: 'wrong' })
    const result = await link.send({ kind: 'register', payload: { nodeId: 'macbook-air', name: '', runtimes: [], projects: [] } })
    expect(result.status).toBe(401)
  })
})
