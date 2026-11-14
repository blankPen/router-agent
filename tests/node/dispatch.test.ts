import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { RouterService } from '../../src/service.js'
import { defaultConfig, policyOf, chatEntry, type AppConfig } from '../../src/config.js'
import { DEFAULT_ADMISSION } from '#core/policy.js'
import { NodeCenter } from '../../src/node/center.js'
import { DirectCenterLink } from '../../src/node/link.js'
import { NodeRegistry } from '../../src/node/registry.js'
import { RemoteWorkerRuntime } from '../../src/node/remote-runtime.js'
import { RuntimeRegistry } from '#runtime/registry.js'
import type { WorkerContext, WorkerRuntime, StartResult } from '#runtime/port.js'
import type { DecisionEngine, DecisionEngineResult, DecisionRequest } from '../../src/router/decision-engine.js'
import type { Trigger } from '#core/model.js'

class LocalRuntime implements WorkerRuntime {
  readonly id = 'orca'
  readonly capabilities = {
    agent: { liveStatus: true, processExit: false, output: true, activity: true, structuredInput: true, nudge: true },
    workspace: { cleanup: true, prLink: true, discovery: true },
  }
  starts: WorkerContext[] = []
  async start(ctx: WorkerContext): Promise<StartResult> {
    this.starts.push(ctx)
    return { handle: 'local-1', workdir: '/tmp/local' }
  }
  async deliver() {
    return { status: 'accepted' as const, inputIds: [] }
  }
  async stop() {}
}

class AcceptEngine implements DecisionEngine {
  async assess(req: DecisionRequest): Promise<DecisionEngineResult> {
    const proposal = {
      triggerId: req.trigger.id,
      decision: 'accept' as const,
      strength: req.strength,
      reason: '测试接单',
      title: '测试工单',
      scope: '测试',
      rules: [],
    }
    return {
      proposal,
      audit: {
        engine: 'pi',
        triggerId: req.trigger.id,
        durationMs: 1,
        toolCalls: [],
        tokens: { input: 0, output: 0, total: 0 },
        promptChars: { system: 0, user: 0 },
        proposal,
      },
    }
  }
  async reply(): Promise<string> {
    return ''
  }
}

/** 记录远端派工的运行时。 */
class RecordingRemoteRuntime extends RemoteWorkerRuntime {
  starts: WorkerContext[] = []
  override async start(ctx: WorkerContext): Promise<StartResult> {
    this.starts.push(ctx)
    return super.start(ctx)
  }
}

class FakePrTracker {
  async view() {
    return null
  }
  async findByBranch() {
    return null
  }
}

function trigger(): Trigger {
  return {
    id: 't1',
    source: 'feishu',
    externalId: 'om_1',
    threadId: 'feishu:oc_dev:om_root',
    chatId: 'oc_dev',
    chatName: '研发群',
    actorId: 'ou_alice',
    actorName: 'Alice',
    isBot: false,
    text: '帮我把登录超时改成 30 秒',
    addressed: 'mention',
    receivedAt: '2026-11-15T09:59:00.000Z',
    disposition: 'pending',
  }
}

describe('多设备派工', () => {
  it('项目绑定了设备时，工单派到远端设备而不是本机 runtime', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-node-svc-'))
    const config: AppConfig = {
      ...defaultConfig(),
      home,
      policy: { acceptMode: 'auto', maxWorkers: 2, admission: { ...DEFAULT_ADMISSION }, interruptedRecovery: 'auto', maxAutoRecover: 1 },
      feishu: { ...defaultConfig().feishu, chats: [chatEntry('oc_dev')], allowed: ['ou_alice'] },
      nodes: {
        ...defaultConfig().nodes,
        enabled: true,
        devices: [
          {
            id: 'macbook-air',
            name: 'MacBook Air',
            token: 'secret-air',
            projects: [{ name: 'remote-app', key: 'remote-app', defaultBranch: 'main' }],
          },
        ],
      },
    }
    const store = new Store(':memory:')
    const engine = new Engine({
      store,
      policy: policyOf(config),
      clock: { now: () => '2026-11-15T10:00:00.000Z' },
      ids: { next: prefix => `${prefix}_1` },
    })
    const registry = new NodeRegistry({
      devices: [{ id: 'macbook-air', name: 'MacBook Air', token: 'secret-air' }],
      clock: () => '2026-11-15T10:00:00.000Z',
    })
    const center = new NodeCenter({
      config,
      store,
      registry,
      link: new DirectCenterLink(registry),
      onReport: async () => {},
      clock: () => '2026-11-15T10:00:00.000Z',
    })
    const localRuntime = new LocalRuntime()
    // 设备在线并登记了自己的项目。
    registry.touch({ nodeId: 'macbook-air', name: 'MacBook Air', runtimes: ['claude-code'], projects: [{ name: 'remote-app', path: '/Users/pz/dev/remote-app' }] })
    const remoteRuntime = new RecordingRemoteRuntime({
      nodeId: 'macbook-air',
      link: new DirectCenterLink(registry),
      isOnline: id => center.isOnline(id),
    })
    const runtimes = new RuntimeRegistry(new Map([[localRuntime.id, localRuntime]]), localRuntime.id)
    runtimes.register(remoteRuntime)
    const service = new RouterService({
      config,
      store,
      engine,
      runtime: localRuntime,
      runtimes,
      decisionEngine: new AcceptEngine(),
      prTracker: new FakePrTracker(),
      nodeCenter: center,
      clock: { now: () => '2026-11-15T10:00:10.000Z' },
      agentLoopOptions: { batchWindowMs: 0 },
    })

    // 用户在消息里点名远端设备上的项目。
    engine.ingest(trigger())
    await service.runOnce()

    expect(localRuntime.starts).toHaveLength(0)
    expect(remoteRuntime.starts).toHaveLength(1)
    const ticket = store.listTickets()[0]!
    expect(ticket.repo).toBe('remote-app')
    const assignment = store.latestAssignment(ticket.id)!
    expect(assignment.runtimeId).toBe('node:macbook-air')
    // 远端任务带的是节点侧项目标识，由设备自己映射成本地绝对路径。
    const queued = registry.status()[0]!.tickets
    expect(queued).toContain(ticket.id)
  })
})
