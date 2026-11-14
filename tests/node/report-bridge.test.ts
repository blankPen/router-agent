import { createServer, type Server } from 'node:http'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeAgent } from '../../src/node/agent.js'
import { createNodeApi } from '../../src/node/api.js'
import { NodeCenter } from '../../src/node/center.js'
import { DirectCenterLink, DirectNodeAgentLink } from '../../src/node/link.js'
import { NodeRegistry } from '../../src/node/registry.js'
import { Store } from '../../src/store/db.js'
import { defaultConfig, policyOf } from '../../src/config.js'
import { RuntimeRegistry } from '#runtime/registry.js'
import type { WorkerRuntime, StartResult, WorkerContext } from '#runtime/port.js'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

class NoopRuntime implements WorkerRuntime {
  readonly id = 'claude-code'
  readonly capabilities = {
    agent: { liveStatus: false, processExit: false, output: false, activity: false, structuredInput: true, nudge: false },
    workspace: { cleanup: false, prLink: false, discovery: false },
  }
  async start(_ctx: WorkerContext): Promise<StartResult> {
    return { handle: 'x', workdir: '' }
  }
  async deliver() {
    return { status: 'accepted' as const, inputIds: [] }
  }
  async stop() {}
}

function post(url: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = request({ host: '127.0.0.1', port: new URL(url).port, path: new URL(url).pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => {
      let data = ''
      res.on('data', chunk => { data += String(chunk) })
      res.on('end', () => {
        let json: any = null
        try { json = data ? JSON.parse(data) : null } catch { json = data }
        resolve({ status: res.statusCode ?? 0, json })
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

describe('节点本机上报通道', () => {
  it('worker 的 ra reply 打到节点本机端口，节点转给中心并把中心的判定回传', async () => {
    const config = { ...defaultConfig(), server: { port: 0 } }
    const store = new Store(':memory:')
    const registry = new NodeRegistry({ devices: [{ id: 'macbook-air', name: 'MacBook Air', token: 'secret-air' }] })
    const received: unknown[] = []
    const center = new NodeCenter({
      config,
      store,
      registry,
      link: new DirectCenterLink(registry),
      onReport: async state => {
        received.push(state)
      },
    })
    const api = createNodeApi({ registry, onMessage: (nodeId, message) => center.handleMessage(nodeId, message) })
    const centerServer = createServer((req, res) => {
      api.handle(req, res).then(handled => {
        if (!handled) res.writeHead(404).end()
      })
    })
    servers.push(centerServer)
    await new Promise<void>(resolve => centerServer.listen(0, '127.0.0.1', resolve))
    const centerUrl = `http://127.0.0.1:${(centerServer.address() as AddressInfo).port}`

    const runtime = new NoopRuntime()
    const agent = new NodeAgent({
      home: '/tmp/ra-node-report',
      config,
      link: new DirectNodeAgentLink({ baseUrl: centerUrl, nodeId: 'macbook-air', token: 'secret-air' }),
      runtimes: new RuntimeRegistry(new Map([[runtime.id, runtime]]), runtime.id),
      reportPort: 0,
    })
    // 节点本机监听 worker 上报端口。
    const port = await agent.listenForReports()

    // 中心不认识这张工单：节点应把中心的 404 原样回给 worker。
    const res = await post(`http://127.0.0.1:${port}/api/reports`, { ticketId: 'tk-unknown', state: 'ready', summary: '完成' })
    expect(res.status).toBe(404)
    expect(received).toHaveLength(0)
  })
})
