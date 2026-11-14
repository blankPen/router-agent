import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { defaultConfig, policyOf, type AppConfig } from '../../src/config.js'
import { NodeAgent } from '../../src/node/agent.js'
import { createNodeApi } from '../../src/node/api.js'
import { NodeCenter } from '../../src/node/center.js'
import { DirectCenterLink, DirectNodeAgentLink } from '../../src/node/link.js'
import { NodeRegistry } from '../../src/node/registry.js'
import { RemoteWorkerRuntime } from '../../src/node/remote-runtime.js'
import { RuntimeRegistry } from '#runtime/registry.js'
import type { WorkerContext, WorkerRuntime, StartResult } from '#runtime/port.js'

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

/** 记录本机收到的启动请求，代替真实的 claude-code / orca。 */
class FakeLocalRuntime implements WorkerRuntime {
  readonly id = 'claude-code'
  readonly capabilities = {
    agent: { liveStatus: false, processExit: false, output: false, activity: false, structuredInput: true, nudge: false },
    workspace: { cleanup: false, prLink: false, discovery: false },
  }
  starts: WorkerContext[] = []
  async start(ctx: WorkerContext): Promise<StartResult> {
    this.starts.push(ctx)
    return { handle: 'local-1', workdir: '/tmp/worktree-1' }
  }
  async deliver() {
    return { status: 'accepted' as const, inputIds: [] }
  }
  async stop() {}
}

function nodeConfig(): AppConfig {
  const config = defaultConfig()
  return {
    ...config,
    nodes: {
      ...config.nodes,
      enabled: true,
      mode: 'direct',
      routerId: 'home',
      nodeId: 'macbook-air',
      name: 'MacBook Air',
      server: 'http://127.0.0.1:1',
      token: 'secret-air',
      devices: [
        {
          id: 'macbook-air',
          name: 'MacBook Air',
          token: 'secret-air',
          projects: [{ name: 'router-agent', key: 'router-agent', defaultBranch: 'main' }],
        },
      ],
    },
  }
}

describe('多设备派工闭环', () => {
  it('中心把工单派到目标设备，设备用本机 runtime 执行并把结果回传', async () => {
    const centerConfig = nodeConfig()
    const store = new Store(':memory:')
    const engine = new Engine({
      store,
      policy: policyOf(centerConfig),
      clock: { now: () => '2026-11-15T00:00:00.000Z' },
      ids: { next: prefix => `${prefix}_1` },
    })
    const registry = new NodeRegistry({
      devices: [{ id: 'macbook-air', name: 'MacBook Air', token: 'secret-air' }],
      clock: () => '2026-11-15T00:00:00.000Z',
    })
    const reports: string[] = []
    const center = new NodeCenter({
      config: centerConfig,
      store,
      registry,
      link: new DirectCenterLink(registry),
      onReport: async state => {
        reports.push(state.summary)
      },
      clock: () => '2026-11-15T00:00:00.000Z',
    })
    const api = createNodeApi({
      registry,
      onMessage: (nodeId, message) => center.handleMessage(nodeId, message),
    })
    const server = createServer((req, res) => {
      api.handle(req, res).then(handled => {
        if (!handled) res.writeHead(404).end()
      })
    })
    const baseUrl = await listen(server)

    // 设备侧：本机项目清单映射到本地绝对路径。
    const localRuntime = new FakeLocalRuntime()
    const deviceConfig = {
      ...centerConfig,
      runtime: {
        default: 'claude-code',
        projects: { 'claude-code': [{ name: 'router-agent', repo: '/Users/pz/dev/router-agent', defaultBranch: 'main' }] },
      },
    }
    const link = new DirectNodeAgentLink({ baseUrl, nodeId: 'macbook-air', token: 'secret-air' })
    const home = mkdtempSync(join(tmpdir(), 'ra-node-'))
    const agent = new NodeAgent({
      home,
      config: deviceConfig,
      link,
      runtimes: new RuntimeRegistry(new Map([[localRuntime.id, localRuntime]]), localRuntime.id),
      reportPort: 0,
    })

    // 设备注册后，中心能看到它在线且登记了哪些项目。
    await agent.register()
    expect(registry.status()[0]!.online).toBe(true)
    expect(registry.status()[0]!.projects).toEqual(['router-agent'])

    // 中心侧：建工单与派工，目标是 macbook-air 上的 router-agent。
    const ticketId = 'tk-88'
    store.insertTicket({
      id: ticketId,
      title: '多设备接入',
      threadId: 'th_1',
      source: 'feishu',
      chatId: 'oc_dev',
      mandateId: 'md_1',
      stage: 'todo',
      repo: 'router-agent',
      branch: 'main',
      prNumber: 0,
      prUrl: '',
      prState: 'none',
      createdAt: '2026-11-15T00:00:00.000Z',
      updatedAt: '2026-11-15T00:00:00.000Z',
    })
    const assignment = engine.startAssignment(ticketId, { runtimeId: 'node:macbook-air', handle: '', workdir: '' })

    const remote = new RemoteWorkerRuntime({
      nodeId: 'macbook-air',
      link: new DirectCenterLink(registry),
      isOnline: id => center.isOnline(id),
    })
    await remote.start({
      ticket: store.getTicket(ticketId)!,
      assignment,
      workdir: '',
      brief: { ticketId, title: '多设备接入', scope: '接入节点', workBranch: 'ra/tk-88', contract: '正文' },
    })

    // 设备取到任务，用本机 runtime 执行，仓库路径是设备本地的绝对路径。
    const messages = await link.receive(2_000)
    expect(messages[0]!.kind).toBe('task')
    await agent.handleMessage(messages[0]!)
    expect(localRuntime.starts).toHaveLength(1)
    expect(localRuntime.starts[0]!.ticket.repo).toBe('/Users/pz/dev/router-agent')
    expect(localRuntime.starts[0]!.brief!.contract).toContain('/Users/pz/dev/router-agent')

    // 设备把 worker 的结果回传中心。
    await agent.forwardReport({ ticketId, state: 'ready', summary: '节点上已完成', ackedInputs: [] })
    expect(reports).toEqual(['节点上已完成'])
  })

  it('设备上没有对应项目时回报失败，中心能收到原因', async () => {
    const centerConfig = nodeConfig()
    const store = new Store(':memory:')
    const registry = new NodeRegistry({
      devices: [{ id: 'macbook-air', name: 'MacBook Air', token: 'secret-air' }],
      clock: () => '2026-11-15T00:00:00.000Z',
    })
    const reports: string[] = []
    const center = new NodeCenter({
      config: centerConfig,
      store,
      registry,
      link: new DirectCenterLink(registry),
      onReport: async state => {
        reports.push(state.summary)
      },
      clock: () => '2026-11-15T00:00:00.000Z',
    })
    const api = createNodeApi({
      registry,
      onMessage: (nodeId, message) => center.handleMessage(nodeId, message),
    })
    const server = createServer((req, res) => {
      api.handle(req, res).then(handled => {
        if (!handled) res.writeHead(404).end()
      })
    })
    const baseUrl = await listen(server)

    const localRuntime = new FakeLocalRuntime()
    const deviceConfig = { ...centerConfig, runtime: { default: 'claude-code', projects: { 'claude-code': [] } } }
    const link = new DirectNodeAgentLink({ baseUrl, nodeId: 'macbook-air', token: 'secret-air' })
    const home = mkdtempSync(join(tmpdir(), 'ra-node-'))
    const agent = new NodeAgent({
      home,
      config: deviceConfig,
      link,
      runtimes: new RuntimeRegistry(new Map([[localRuntime.id, localRuntime]]), localRuntime.id),
      reportPort: 0,
    })
    await agent.register()

    store.insertTicket({
      id: 'tk-1',
      title: '标题',
      threadId: 'th_1',
      source: 'feishu',
      chatId: 'oc_dev',
      mandateId: 'md_1',
      stage: 'todo',
      repo: '不存在的项目',
      branch: 'main',
      prNumber: 0,
      prUrl: '',
      prState: 'none',
      createdAt: '2026-11-15T00:00:00.000Z',
      updatedAt: '2026-11-15T00:00:00.000Z',
    })
    new Engine({
      store,
      policy: policyOf(centerConfig),
      clock: { now: () => '2026-11-15T00:00:00.000Z' },
      ids: { next: prefix => `${prefix}_1` },
    }).startAssignment('tk-1', { runtimeId: 'node:macbook-air', handle: '', workdir: '' })

    await agent.handleMessage({
      kind: 'task',
      payload: {
        assignmentId: 'as_1',
        ticketId: 'tk-1',
        title: '标题',
        scope: '范围',
        project: '不存在的项目',
        branch: 'main',
        workBranch: 'ra/tk-1',
      },
    })
    expect(localRuntime.starts).toHaveLength(0)
    expect(reports[0]).toContain('没有项目')
  })
})
