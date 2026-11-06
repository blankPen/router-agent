import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store/db.js'
import { Engine } from '../src/core/engine.js'
import { RouterService } from '../src/service.js'
import { defaultConfig, policyOf, type AppConfig, chatEntry } from '../src/config.js'
import { DEFAULT_ADMISSION } from '../src/core/policy.js'
import type { WorkerBackend, WorkerContext } from '../src/worker/port.js'
import type { DecisionEngine, DecisionEngineResult, DecisionRequest } from '../src/router/decision-engine.js'
import type { Trigger } from '../src/core/model.js'

class FakeBackend implements WorkerBackend {
  readonly id = 'orca'
  starts: WorkerContext[] = []
  delivered: { handle: string; text: string }[] = []
  stopped: string[] = []
  handles = new Map<string, boolean>()
  async start(ctx: WorkerContext) {
    const handle = `term-${this.starts.length + 1}`
    this.starts.push(ctx)
    this.handles.set(handle, true)
    return { handle, workdir: `/tmp/${ctx.ticket.id}` }
  }
  async deliver(handle: string, inputs: { text: string }[]) {
    if (!this.handles.has(handle)) throw new Error('orca:command-failed(terminal send): terminal not found')
    for (const input of inputs) this.delivered.push({ handle, text: input.text })
  }
  async registerContext() {}
  async stop(handle: string) {
    this.stopped.push(handle)
    this.handles.delete(handle)
  }
  async inspect(handle: string) {
    return this.handles.has(handle)
      ? { handle, connected: true, writable: true, orphaned: false, lastOutputAt: new Date().toISOString(), worktreePath: '', branch: '' }
      : null
  }
  async inspectWorktree() {
    return null
  }
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

class FakePrTracker {
  states = new Map<number, 'open' | 'merged' | 'closed'>()
  async view(_repo: string, number: number) {
    const state = this.states.get(number)
    return state ? { number, url: `https://github.com/o/r/pull/${number}`, state, title: 't', branch: 'b' } : null
  }
  async findByBranch() {
    return null
  }
}

class FakeSender {
  sent: { text: string; threadId: string; key: string }[] = []
  async send(item: { text: string; threadId: string; key: string }) {
    this.sent.push(item)
  }
}

function makeTrigger(over: Partial<Trigger> = {}): Trigger {
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
    receivedAt: '2026-11-06T09:59:00.000Z',
    disposition: 'pending',
    ...over,
  }
}

describe('RouterService 编排', () => {
  let store: Store
  let engine: Engine
  let backend: FakeBackend
  let prTracker: FakePrTracker
  let config: AppConfig
  let service: RouterService

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'ra-svc-'))
    store = new Store(':memory:')
    config = { ...defaultConfig(), home }
    config.projects = [{ name: 'acme/web', repo: 'acme/web', branches: [], defaultBranch: 'main' }]
    config.policy = { acceptMode: 'auto', maxWorkers: 2, admission: { ...DEFAULT_ADMISSION } }
    config.feishu = { ...config.feishu, chats: [chatEntry('oc_dev')], allowed: ['ou_alice'] }
    let n = 0
    engine = new Engine({ store, policy: policyOf(config), clock: { now: () => '2026-11-06T10:00:00.000Z' }, ids: { next: p => `${p}_${++n}` } })
    backend = new FakeBackend()
    prTracker = new FakePrTracker()
    service = new RouterService({
      config, store, engine, backend, decisionEngine: new AcceptEngine(), prTracker,
      clock: { now: () => '2026-11-06T10:00:10.000Z' },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      agentLoopOptions: { batchWindowMs: 0 },
    })
  })

  it('接单后排工启动 worker，并建立 Assignment', async () => {
    engine.ingest(makeTrigger())
    await service.runOnce()

    expect(backend.starts).toHaveLength(1)
    const ticket = store.listTickets()[0]!
    // 派工所需的项目与起始分支随工单一起落库，并交给 backend
    expect(ticket.repo).toBe('acme/web')
    expect(ticket.branch).toBe('main')
    expect(backend.starts[0]?.ticket).toMatchObject({ repo: 'acme/web', branch: 'main' })
    const assignment = store.latestAssignment(ticket.id)!
    expect(assignment.handle).toBe('term-1')
    expect(assignment.status).toBe('pending')
  })

  it('并发上限生效：超出的工单排队而不是丢弃', async () => {
    config.policy.maxWorkers = 1
    engine.updatePolicy(policyOf(config))
    engine.ingest(makeTrigger({ id: 't1', externalId: 'e1' }))
    engine.ingest(makeTrigger({ id: 't2', externalId: 'e2', threadId: 'feishu:oc_dev:om_root2', text: '再修一个分页 bug' }))

    await service.runOnce()
    expect(backend.starts).toHaveLength(1)

    // 让第一个 worker 结束，队列里的第二个才会启动
    const first = store.listTickets()[0]!
    const assignment = store.latestAssignment(first.id)!
    service.onWorkerState({
      ticketId: first.id,
      assignmentId: assignment.id,
      turn: 1,
      state: 'waiting',
      summary: '等新消息',
      prNumber: 0,
      prUrl: '',
      ackedInputs: [],
      updatedAt: '2026-11-06T10:01:00.000Z',
    })
    await service.runOnce()
    expect(backend.starts.length).toBe(2)
  })

  it('worker 上报 ready 时进入 review 并安排 PR 跟踪', async () => {
    engine.ingest(makeTrigger())
    await service.runOnce()
    const ticket = store.listTickets()[0]!
    const assignment = store.latestAssignment(ticket.id)!

    service.onWorkerState({
      ticketId: ticket.id,
      assignmentId: assignment.id,
      turn: 1,
      state: 'ready',
      summary: 'PR 已开',
      prNumber: 12,
      prUrl: 'https://github.com/o/r/pull/12',
      ackedInputs: [],
      updatedAt: '2026-11-06T10:01:00.000Z',
    })
    expect(store.getTicket(ticket.id)?.stage).toBe('review')
    expect(store.getTicket(ticket.id)?.prNumber).toBe(12)
  })

  it('PR 合并后关闭工单并通知发起人', async () => {
    engine.ingest(makeTrigger())
    await service.runOnce()
    const ticket = store.listTickets()[0]!
    const assignment = store.latestAssignment(ticket.id)!
    service.onWorkerState({
      ticketId: ticket.id, assignmentId: assignment.id, turn: 1, state: 'ready', summary: 'PR 已开',
      prNumber: 12, prUrl: 'https://github.com/o/r/pull/12', ackedInputs: [], updatedAt: '2026-11-06T10:01:00.000Z',
    })

    prTracker.states.set(12, 'merged')
    await service.trackPullRequests()

    expect(store.getTicket(ticket.id)?.stage).toBe('closed')
    expect(store.getTicket(ticket.id)?.prState).toBe('merged')
    const outbox = store.claimOutbox('2026-11-06T10:10:00.000Z', 10)
    expect(outbox.some(item => item.text.includes('已合并'))).toBe(true)
  })

  it('PR 仍开时不关闭工单', async () => {
    engine.ingest(makeTrigger())
    await service.runOnce()
    const ticket = store.listTickets()[0]!
    const assignment = store.latestAssignment(ticket.id)!
    service.onWorkerState({
      ticketId: ticket.id, assignmentId: assignment.id, turn: 1, state: 'ready', summary: 'PR 已开',
      prNumber: 13, prUrl: 'u13', ackedInputs: [], updatedAt: '2026-11-06T10:01:00.000Z',
    })
    prTracker.states.set(13, 'open')
    await service.trackPullRequests()
    expect(store.getTicket(ticket.id)?.stage).toBe('review')
  })

  it('worker 上报 blocked 时通知发起人并登记待答问题', async () => {
    engine.ingest(makeTrigger())
    await service.runOnce()
    const ticket = store.listTickets()[0]!
    const assignment = store.latestAssignment(ticket.id)!

    service.onWorkerState({
      ticketId: ticket.id, assignmentId: assignment.id, turn: 1, state: 'blocked',
      summary: '缺测试账号', humanAction: '请提供测试账号', prNumber: 0, prUrl: '',
      ackedInputs: [], updatedAt: '2026-11-06T10:01:00.000Z',
    })

    expect(store.getTicket(ticket.id)?.stage).toBe('person')
    expect(store.getAttention(ticket.id)?.question).toBe('请提供测试账号')
    const outbox = store.claimOutbox('2026-11-06T10:10:00.000Z', 10)
    expect(outbox.some(item => item.text.includes('测试账号'))).toBe(true)
  })

  it('重启对账：终端还在则复用，终端被删则转人工并通知，不重开', async () => {
    engine.ingest(makeTrigger())
    await service.runOnce()
    const ticket = store.listTickets()[0]!
    const first = store.latestAssignment(ticket.id)!

    // handle 仍然在线：不重开
    backend.handles.set(first.handle, true)
    await service.recover()
    expect(backend.starts).toHaveLength(1)

    // handle 丢失：不偷偷重开新会话，直接转人工
    backend.handles.delete(first.handle)
    await service.recover()
    expect(backend.starts).toHaveLength(1)
    expect(store.latestAssignment(ticket.id)?.status).toBe('ended')
    expect(store.getTicket(ticket.id)?.stage).toBe('person')

    const outbox = store.claimOutbox('2026-11-06T10:10:00.000Z', 20)
    expect(outbox.filter(item => item.text.includes('意外删除'))).toHaveLength(1)
  })

  it('worker 会话被删后，追加输入不再每秒重试，只通知一次', async () => {
    engine.ingest(makeTrigger())
    await service.runOnce()
    const ticket = store.listTickets()[0]!
    const assignment = store.latestAssignment(ticket.id)!

    engine.deliverInput(ticket.id, { kind: 'followup', text: '继续补充一下' })
    backend.handles.delete(assignment.handle)
    await service.runOnce()

    expect(store.getTicket(ticket.id)?.stage).toBe('person')
    expect(store.latestAssignment(ticket.id)?.status).toBe('ended')
    const outbox = store.claimOutbox('2026-11-06T10:10:00.000Z', 20)
    expect(outbox.filter(item => item.text.includes('意外删除'))).toHaveLength(1)

    // 下一轮不再尝试投递，也不会重复通知
    const before = backend.delivered.length
    await service.runOnce()
    expect(backend.delivered.length).toBe(before)
    expect(store.claimOutbox('2026-11-06T10:11:00.000Z', 20).filter(item => item.text.includes('意外删除'))).toHaveLength(0)
  })

  it('停止工单会触发 worker 停止', async () => {
    engine.ingest(makeTrigger())
    await service.runOnce()
    const ticket = store.listTickets()[0]!
    const assignment = store.latestAssignment(ticket.id)!

    service.stopTicket(ticket.id, '人工停止')
    await service.runOnce()
    expect(backend.stopped).toContain(assignment.handle)
    expect(store.getTicket(ticket.id)?.stage).toBe('closed')
  })

  it('待投递的 follow-up 会在下一轮投给 worker', async () => {
    engine.ingest(makeTrigger())
    await service.runOnce()
    const ticket = store.listTickets()[0]!

    service.engine.deliverInput(ticket.id, { kind: 'followup', text: '顺便补个测试' })
    await service.runOnce()
    expect(backend.delivered.some(d => d.text.includes('补个测试'))).toBe(true)
    expect(store.pendingInputs(ticket.id)).toHaveLength(0)
  })

  it('ready 携带 reply 时，把完整正文回复到原话题', async () => {
    engine.ingest(makeTrigger())
    await service.runOnce()
    const ticket = store.listTickets()[0]!
    const assignment = store.latestAssignment(ticket.id)!
    const sender = new FakeSender()
    const svc = new RouterService({
      config, store, engine, backend, decisionEngine: new AcceptEngine(), prTracker,
      clock: { now: () => '2026-11-06T10:00:10.000Z' },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      sender,
    })

    svc.onWorkerState({
      ticketId: ticket.id, assignmentId: assignment.id, turn: 1, state: 'ready',
      summary: '完成可优化点梳理', prNumber: 0, prUrl: '', ackedInputs: [],
      reply: '## 可优化点\n1. 先修 A\n2. 再修 B',
      updatedAt: '2026-11-06T10:01:00.000Z',
    })

    const outbox = store.claimOutbox('2026-11-06T10:10:00.000Z', 20)
    const text = outbox.map(item => item.text).join('\n')
    expect(text).toContain('先修 A')
    expect(text).toContain('再修 B')
    expect(outbox.every(item => item.threadId === 'om_root')).toBe(true)
  })

  it('长 reply 由 worker 决定形态，Router 不会自动转文档，只按卡片分块回复', async () => {
    engine.ingest(makeTrigger())
    await service.runOnce()
    const ticket = store.listTickets()[0]!
    const assignment = store.latestAssignment(ticket.id)!
    const sender = new FakeSender()
    const svc = new RouterService({
      config, store, engine, backend, decisionEngine: new AcceptEngine(), prTracker,
      clock: { now: () => '2026-11-06T10:00:10.000Z' },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      sender,
    })
    const content = Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 条：这是一行用于测试分块的建议内容`).join('\n')
    svc.onWorkerState({
      ticketId: ticket.id, assignmentId: assignment.id, turn: 1, state: 'ready',
      summary: '长清单', prNumber: 0, prUrl: '', ackedInputs: [],
      reply: content,
      updatedAt: '2026-11-06T10:01:00.000Z',
    })

    const outbox = store.claimOutbox('2026-11-06T10:10:00.000Z', 50)
    const text = outbox.map(item => item.text).join('')
    expect(outbox.length).toBeGreaterThan(1)
    expect(text).toContain('第 1 条')
    expect(text).toContain('第 200 条')
  })

  it('ready 只有 summary 时明确提示回复不完整', async () => {
    engine.ingest(makeTrigger())
    await service.runOnce()
    const ticket = store.listTickets()[0]!
    const assignment = store.latestAssignment(ticket.id)!
    service.onWorkerState({
      ticketId: ticket.id, assignmentId: assignment.id, turn: 1, state: 'ready',
      summary: '完成了梳理', prNumber: 0, prUrl: '', ackedInputs: [],
      updatedAt: '2026-11-06T10:01:00.000Z',
    })

    const outbox = store.claimOutbox('2026-11-06T10:10:00.000Z', 20)
    const text = outbox.map(item => item.text).join('\n')
    expect(text).toContain('完成了梳理')
    expect(text).toContain('未提供完整回复')
  })

  it('同一 turn 的多次追问回答都会被投递，不被幂等 key 吞掉', async () => {
    engine.ingest(makeTrigger())
    await service.runOnce()
    const ticket = store.listTickets()[0]!
    const assignment = store.latestAssignment(ticket.id)!
    const sender = new FakeSender()
    const svc = new RouterService({
      config, store, engine, backend, decisionEngine: new AcceptEngine(), prTracker,
      clock: { now: () => '2026-11-06T10:00:10.000Z' },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      sender,
    })
    const base = { ticketId: ticket.id, assignmentId: assignment.id, turn: 1, state: 'ready' as const, prNumber: 0, prUrl: '', ackedInputs: [] }

    svc.onWorkerState({ ...base, summary: '第一次回答', reply: '回答一', updatedAt: '2026-11-06T10:01:00.000Z' })
    const firstText = store.claimOutbox('2026-11-06T10:10:00.000Z', 50).map(item => item.text).join('\n')

    svc.onWorkerState({ ...base, summary: '第二次回答', reply: '回答二', updatedAt: '2026-11-06T10:02:00.000Z' })
    const secondText = store.claimOutbox('2026-11-06T10:10:00.000Z', 50).map(item => item.text).join('\n')

    expect(firstText).toContain('回答一')
    expect(secondText).toContain('回答二')
  })

  it('重启后重读的旧 state.json 不会重复入库与投递', async () => {
    engine.ingest(makeTrigger())
    await service.runOnce()
    const ticket = store.listTickets()[0]!
    const assignment = store.latestAssignment(ticket.id)!
    const base = { ticketId: ticket.id, assignmentId: assignment.id, turn: 2, state: 'progress' as const, prNumber: 0, prUrl: '', ackedInputs: [] }

    service.onWorkerState({ ...base, summary: '新进展', updatedAt: '2026-11-06T10:01:00.000Z' })
    const count = store.listReports(ticket.id).length

    service.onWorkerState({
      ...base, state: 'ready', summary: '旧内容',
      reply: '旧回答',
      updatedAt: '2026-11-06T09:00:00.000Z',
    })

    expect(store.listReports(ticket.id)).toHaveLength(count)
  })

  it('追问的回答即使以 progress 上报，也会同步给用户', async () => {
    engine.ingest(makeTrigger())
    await service.runOnce()
    const ticket = store.listTickets()[0]!
    const assignment = store.latestAssignment(ticket.id)!
    const sender = new FakeSender()
    const svc = new RouterService({
      config, store, engine, backend, decisionEngine: new AcceptEngine(), prTracker,
      clock: { now: () => '2026-11-06T10:00:10.000Z' },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      sender,
    })
    svc.onWorkerState({
      ticketId: ticket.id, assignmentId: assignment.id, turn: 2, state: 'progress',
      summary: '先回答追问', prNumber: 0, prUrl: '', ackedInputs: ['in_1'],
      reply: '先改 A，因为 A 影响面最大。',
      updatedAt: '2026-11-06T10:03:00.000Z',
    })

    const text = store.claimOutbox('2026-11-06T10:10:00.000Z', 20).map(item => item.text).join('\n')
    expect(text).toContain('先改 A')
  })
})
