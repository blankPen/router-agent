import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store/db.js'
import { Engine } from '../src/core/engine.js'
import { RouterService } from '../src/service.js'
import { defaultConfig, policyOf, type AppConfig, chatEntry } from '../src/config.js'
import { DEFAULT_ADMISSION } from '../src/core/policy.js'
import type {
  WorkerBackend,
  WorkerContext,
  WorkerRef,
  StartResult,
  DeliveryReceipt,
  AgentStatus,
  WorkspaceInfo,
} from '../src/worker/port.js'
import type { DecisionEngine, DecisionEngineResult, DecisionRequest } from '../src/router/decision-engine.js'
import type { Trigger } from '../src/core/model.js'

class FakeBackend implements WorkerBackend {
  readonly id = 'orca'
  readonly capabilities = {
    agent: { liveStatus: true, processExit: false, output: true, activity: true, structuredInput: true, nudge: true },
    workspace: { cleanup: true, prLink: true, discovery: true },
  }
  starts: WorkerContext[] = []
  delivered: { handle: string; text: string }[] = []
  stopped: string[] = []
  removed: string[] = []
  handles = new Map<string, boolean>()
  /** 测试可指定终端最后一次输出时间；默认取当前时间。 */
  outputAt = ''
  /** 测试可模拟 provider 拒绝删除（如工作区有未提交改动）。 */
  removeError = ''
  async start(ctx: WorkerContext): Promise<StartResult> {
    const handle = `term-${this.starts.length + 1}`
    this.starts.push(ctx)
    this.handles.set(handle, true)
    return { handle, workdir: `/tmp/${ctx.ticket.id}`, branch: `ra/${ctx.ticket.id}` }
  }
  async deliver(ref: WorkerRef | string, inputs: { text: string; id: string }[]): Promise<DeliveryReceipt> {
    const handle = typeof ref === 'string' ? ref : ref.handle
    if (!this.handles.has(handle)) throw new Error('orca:command-failed(terminal send): terminal not found')
    for (const input of inputs) this.delivered.push({ handle, text: input.text })
    return { status: 'accepted', inputIds: inputs.map(input => input.id) }
  }
  async registerContext() {}
  async stop(ref: WorkerRef | string) {
    const handle = typeof ref === 'string' ? ref : ref.handle
    this.stopped.push(handle)
    this.handles.delete(handle)
  }
  async nudge(ref: WorkerRef | string) {
    const handle = typeof ref === 'string' ? ref : ref.handle
    this.delivered.push({ handle, text: 'status?' })
  }
  async status(ref: WorkerRef | string): Promise<AgentStatus | null> {
    const handle = typeof ref === 'string' ? ref : ref.handle
    if (!this.handles.has(handle)) return { alive: false, phase: 'lost', acceptingInput: false }
    return {
      alive: true,
      phase: 'running',
      acceptingInput: true,
      lastActivityAt: this.outputAt || new Date().toISOString(),
    }
  }
  async output() {
    return { status: 'running' as const, lines: [] }
  }
  async activity() {
    return null
  }
  async inspectWorkspace(): Promise<WorkspaceInfo | null> {
    return null
  }
  async removeWorkspace(ref: { workdir: string }) {
    if (this.removeError) throw new Error(this.removeError)
    this.removed.push(`path:${ref.workdir}`)
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

/** 第一次派工失败、之后成功的后端，用来验证「失败 → 用户回复 → 重派」闭环。 */
class FlakyBackend extends FakeBackend {
  failures = 0
  constructor(private readonly failTimes = 1) {
    super()
  }
  override async start(ctx: WorkerContext) {
    if (this.failures < this.failTimes) {
      this.failures += 1
      throw new Error('orca:command-failed(worktree create): exit=1 | code=agent_session_operation_unknown | message:base branch master not found')
    }
    return super.start(ctx)
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
  let logs: { level: string; message: string; extra?: Record<string, unknown> }[]

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'ra-svc-'))
    logs = []
    store = new Store(':memory:')
    config = { ...defaultConfig(), home }
    config.projects = [{ name: 'acme/web', repo: 'acme/web', defaultBranch: 'main' }]
    config.policy = { acceptMode: 'auto', maxWorkers: 2, admission: { ...DEFAULT_ADMISSION } }
    config.feishu = { ...config.feishu, chats: [chatEntry('oc_dev')], allowed: ['ou_alice'] }
    let n = 0
    engine = new Engine({ store, policy: policyOf(config), clock: { now: () => '2026-11-06T10:00:00.000Z' }, ids: { next: p => `${p}_${++n}` } })
    backend = new FakeBackend()
    prTracker = new FakePrTracker()
    service = new RouterService({
      config, store, engine, backend, decisionEngine: new AcceptEngine(), prTracker,
      clock: { now: () => '2026-11-06T10:00:10.000Z' },
      logger: {
        info: (message, extra) => logs.push({ level: 'info', message, ...(extra ? { extra } : {}) }),
        warn: (message, extra) => logs.push({ level: 'warn', message, ...(extra ? { extra } : {}) }),
        error: (message, extra) => logs.push({ level: 'error', message, ...(extra ? { extra } : {}) }),
      },
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

  it('派工失败：转人工释放并发、记录完整失败日志并回贴话题', async () => {
    const flaky = new FlakyBackend(99)
    service = new RouterService({
      config, store, engine, backend: flaky, decisionEngine: new AcceptEngine(), prTracker,
      clock: { now: () => '2026-11-06T10:00:10.000Z' },
      logger: {
        info: (message, extra) => logs.push({ level: 'info', message, ...(extra ? { extra } : {}) }),
        warn: (message, extra) => logs.push({ level: 'warn', message, ...(extra ? { extra } : {}) }),
        error: (message, extra) => logs.push({ level: 'error', message, ...(extra ? { extra } : {}) }),
      },
      agentLoopOptions: { batchWindowMs: 0 },
    })
    engine.ingest(makeTrigger())
    await service.runOnce()

    const ticket = store.listTickets()[0]!
    expect(store.latestAssignment(ticket.id)?.status).toBe('ended')
    expect(store.getTicket(ticket.id)?.stage).toBe('person')
    expect(store.getAttention(ticket.id)?.question).toContain('执行环境创建失败')

    // 失败必须留下可诊断的日志，而不是只有 code=1
    const entry = logs.find(item => item.message === 'launch:failed')
    expect(entry).toBeDefined()
    expect(entry?.extra).toMatchObject({ repo: 'acme/web', branch: 'main', attempt: 1 })
    expect(String(entry?.extra?.reason)).toContain('base branch master not found')

    const outbox = store.claimOutbox('2026-11-06T10:10:00.000Z', 20)
    const notice = outbox.find(item => item.text.includes('执行环境创建失败'))
    expect(notice?.text).toContain('起始分支：main')
    expect(notice?.text).toContain('回复任意内容')
  })

  it('派工失败不会永久占用并发，后续工单能正常派出去', async () => {
    config.policy.maxWorkers = 1
    engine.updatePolicy(policyOf(config))
    const flaky = new FlakyBackend(1)
    service = new RouterService({
      config, store, engine, backend: flaky, decisionEngine: new AcceptEngine(), prTracker,
      clock: { now: () => '2026-11-06T10:00:10.000Z' },
      logger: {
        info: (message, extra) => logs.push({ level: 'info', message, ...(extra ? { extra } : {}) }),
        warn: (message, extra) => logs.push({ level: 'warn', message, ...(extra ? { extra } : {}) }),
        error: (message, extra) => logs.push({ level: 'error', message, ...(extra ? { extra } : {}) }),
      },
      agentLoopOptions: { batchWindowMs: 0 },
    })
    engine.ingest(makeTrigger({ id: 't1', externalId: 'e1' }))
    engine.ingest(makeTrigger({ id: 't2', externalId: 'e2', threadId: 'feishu:oc_dev:om_root2', text: '再修一个分页 bug' }))

    await service.runOnce()

    // 第一张失败后阶段回落，额度立刻释放给第二张
    expect(flaky.starts).toHaveLength(1)
    expect(store.listTickets().filter(ticket => ticket.stage === 'assigned')).toHaveLength(1)
    expect(store.listTickets().filter(ticket => ticket.stage === 'person')).toHaveLength(1)
  })

  it('并发已满时记录排队日志并回贴排队提示，而不是静默跳过', async () => {
    config.policy.maxWorkers = 1
    engine.updatePolicy(policyOf(config))
    engine.ingest(makeTrigger({ id: 't1', externalId: 'e1' }))
    engine.ingest(makeTrigger({ id: 't2', externalId: 'e2', threadId: 'feishu:oc_dev:om_root2', text: '再修一个分页 bug' }))

    await service.runOnce()

    expect(backend.starts).toHaveLength(1)
    expect(logs.some(entry => entry.message === 'launch:queued')).toBe(true)
    const outbox = store.claimOutbox('2026-11-06T10:10:00.000Z', 20)
    expect(outbox.some(item => item.text.includes('已排队'))).toBe(true)
  })

  it('派工失败后，用户回复会重新派工；没有新输入时不会反复重试', async () => {
    config.policy.maxWorkers = 1
    engine.updatePolicy(policyOf(config))
    const flaky = new FlakyBackend(1)
    service = new RouterService({
      config, store, engine, backend: flaky, decisionEngine: new AcceptEngine(), prTracker,
      clock: { now: () => '2026-11-06T10:00:10.000Z' },
      logger: {
        info: (message, extra) => logs.push({ level: 'info', message, ...(extra ? { extra } : {}) }),
        warn: (message, extra) => logs.push({ level: 'warn', message, ...(extra ? { extra } : {}) }),
        error: (message, extra) => logs.push({ level: 'error', message, ...(extra ? { extra } : {}) }),
      },
      agentLoopOptions: { batchWindowMs: 0 },
    })
    engine.ingest(makeTrigger())
    await service.runOnce()
    const ticket = store.listTickets()[0]!
    expect(store.getTicket(ticket.id)?.stage).toBe('person')

    // 没有新输入：连续多轮也不能重试（否则每秒打一次 Orca）
    await service.runOnce()
    await service.runOnce()
    expect(flaky.failures).toBe(1)

    // 用户回复 = 重试信号，修好配置后能重新拉起 worker
    engine.deliverInput(ticket.id, { kind: 'followup', text: '分支改成 main 了，再试一次' })
    await service.runOnce()
    expect(flaky.starts).toHaveLength(1)
    expect(store.getTicket(ticket.id)?.stage).toBe('assigned')
  })

  it('服务重启后，失败前积压的旧输入不会再触发重试（水位持久化）', async () => {
    config.policy.maxWorkers = 1
    engine.updatePolicy(policyOf(config))
    const flaky = new FlakyBackend(99)
    const logger = {
      info: (message: string, extra?: Record<string, unknown>) => logs.push({ level: 'info', message, ...(extra ? { extra } : {}) }),
      warn: (message: string, extra?: Record<string, unknown>) => logs.push({ level: 'warn', message, ...(extra ? { extra } : {}) }),
      error: (message: string, extra?: Record<string, unknown>) => logs.push({ level: 'error', message, ...(extra ? { extra } : {}) }),
    }
    const build = () => new RouterService({
      config, store, engine, backend: flaky, decisionEngine: new AcceptEngine(), prTracker,
      clock: { now: () => '2026-11-06T10:00:10.000Z' },
      logger,
      agentLoopOptions: { batchWindowMs: 0 },
    })

    engine.ingest(makeTrigger())
    service = build()
    await service.runOnce()
    const ticket = store.listTickets()[0]!

    // 用户在两次尝试之间回复过：这条输入会随下一次失败一起被记为「已经试过」
    engine.deliverInput(ticket.id, { kind: 'followup', text: '？' })
    await service.runOnce()
    expect(flaky.failures).toBe(2)
    expect(store.getTicket(ticket.id)?.stage).toBe('person')

    // 模拟重启：内存里的失败记录清空，水位必须从 cursors 恢复，旧输入不能再触发派工
    service = build()
    await service.runOnce()
    await service.runOnce()
    expect(flaky.failures).toBe(2)

    // 只有真正新到的输入才能再触发一次派工；尝试次数也应跨重启累计
    engine.deliverInput(ticket.id, { kind: 'followup', text: '分支修好了，再试一次' })
    await service.runOnce()
    expect(flaky.failures).toBe(3)
    const lastFailure = logs.filter(entry => entry.message === 'launch:failed').at(-1)
    expect(lastFailure?.extra?.attempt).toBe(3)
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
    expect(outbox.filter(item => item.text.includes('执行会话已不存在'))).toHaveLength(1)
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
    expect(outbox.filter(item => item.text.includes('执行会话已不存在'))).toHaveLength(1)

    // 下一轮不再尝试投递，也不会重复通知
    const before = backend.delivered.length
    await service.runOnce()
    expect(backend.delivered.length).toBe(before)
    expect(store.claimOutbox('2026-11-06T10:11:00.000Z', 20).filter(item => item.text.includes('执行会话已不存在'))).toHaveLength(0)
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
    // 追问的回答用户正在等：progress 也立即发送，且后续轮询不会再重复发送。
    svc.syncProgress()

    const text = store.claimOutbox('2026-11-06T10:10:00.000Z', 20).map(item => item.text).join('\n')
    expect(text.match(/先改 A/g)).toHaveLength(1)
  })

  it('progress 上报不逐条发送，轮询时合并成一条进展消息', async () => {
    engine.ingest(makeTrigger())
    await service.runOnce()
    const ticket = store.listTickets()[0]!
    const assignment = store.latestAssignment(ticket.id)!
    const base = { ticketId: ticket.id, assignmentId: assignment.id, state: 'progress' as const, prNumber: 0, prUrl: '', ackedInputs: [] }

    service.onWorkerState({ ...base, turn: 1, summary: '已定位配置入口', updatedAt: '2026-11-06T10:01:00.000Z' })
    service.onWorkerState({ ...base, turn: 2, summary: '正在改超时逻辑', updatedAt: '2026-11-06T10:02:00.000Z' })

    // 上报本身不发消息
    expect(store.listOutbox(20).some(item => item.text.includes('已定位配置入口'))).toBe(false)

    service.syncProgress()

    const digests = store.claimOutbox('2026-11-06T10:10:00.000Z', 50).filter(item => item.text.includes('工单「测试工单」进展'))
    expect(digests).toHaveLength(1)
    expect(digests[0]?.text).toContain('已定位配置入口')
    expect(digests[0]?.text).toContain('正在改超时逻辑')
    expect(digests[0]?.threadId).toBe('om_root')
  })

  it('内容相同的进展不会重复同步', async () => {
    engine.ingest(makeTrigger())
    await service.runOnce()
    const ticket = store.listTickets()[0]!
    const assignment = store.latestAssignment(ticket.id)!
    const base = { ticketId: ticket.id, assignmentId: assignment.id, state: 'progress' as const, prNumber: 0, prUrl: '', ackedInputs: [] }

    service.onWorkerState({ ...base, turn: 1, summary: '仍在改', updatedAt: '2026-11-06T10:01:00.000Z' })
    service.syncProgress()
    expect(store.claimOutbox('2026-11-06T10:10:00.000Z', 50).filter(item => item.text.includes('仍在改'))).toHaveLength(1)

    service.onWorkerState({ ...base, turn: 2, summary: '仍在改', updatedAt: '2026-11-06T10:02:00.000Z' })
    service.syncProgress()
    expect(store.claimOutbox('2026-11-06T10:10:00.000Z', 50).filter(item => item.text.includes('仍在改'))).toHaveLength(0)
  })

  it('ready 回复不进进展摘要，仍立即发送', async () => {
    engine.ingest(makeTrigger())
    await service.runOnce()
    const ticket = store.listTickets()[0]!
    const assignment = store.latestAssignment(ticket.id)!

    service.onWorkerState({
      ticketId: ticket.id, assignmentId: assignment.id, turn: 1, state: 'ready',
      summary: '完成', prNumber: 0, prUrl: '', ackedInputs: [], reply: '最终交付内容',
      updatedAt: '2026-11-06T10:05:00.000Z',
    })
    service.syncProgress()

    const texts = store.claimOutbox('2026-11-06T10:10:00.000Z', 50).map(item => item.text)
    expect(texts.some(text => text.includes('最终交付内容'))).toBe(true)
    expect(texts.some(text => text.includes('工单「测试工单」进展'))).toBe(false)
  })

  describe('闲置工单治理', () => {
    let seq = 0
    const T0 = Date.parse('2026-11-06T10:00:00.000Z')
    const HOUR = 3_600_000

    function seed(opts: { state?: 'progress' | 'ready'; prState?: 'none' | 'open' } = {}): string {
      seq += 1
      const triggerId = `rt${seq}`
      engine.ingest(makeTrigger({ id: triggerId, externalId: `om_rt_${seq}` }))
      const outcome = engine.decide({
        triggerId,
        decision: 'accept',
        strength: 'explicit',
        reason: 'test',
        title: `闲置工单${seq}`,
        scope: '测试',
        repo: 'acme/web',
        branch: 'main',
      })
      const ticket = outcome.ticket!
      const assignment = engine.startAssignment(ticket.id, { backendId: 'orca', handle: 'term-1', workdir: '/tmp/tk-1' })
      if (opts.prState === 'open') {
        engine.updatePr(ticket.id, { number: 1, url: 'https://github.com/o/r/pull/1', state: 'open' })
      }
      engine.report(assignment.id, {
        ticketId: ticket.id,
        turn: 1,
        state: opts.state ?? 'ready',
        summary: '完成',
        ackedInputs: [],
      })
      return ticket.id
    }

    it('24 小时无进展先提醒，6 小时未回复后自动关闭并回收 workspace', async () => {
      const ticketId = seed()

      await service.sweepRetention(T0 + 24 * HOUR + 1000)
      expect(store.getTicket(ticketId)?.stage).not.toBe('closed')

      // 让提醒真正发出去（Effects 消费 outbox），之后才会进入关闭倒计时
      await service.runOnce()

      // 宽限期内不关闭
      await service.sweepRetention(T0 + 29 * HOUR)
      expect(store.getTicket(ticketId)?.stage).not.toBe('closed')

      // 宽限期满自动关闭
      await service.sweepRetention(T0 + 30 * HOUR + 1000)
      expect(store.getTicket(ticketId)?.stage).toBe('closed')

      const texts = store.listOutbox(50).map(item => item.text)
      expect(texts.some(text => text.includes('24 小时没有新的进展'))).toBe(true)
      expect(texts.some(text => text.includes('已自动关闭'))).toBe(true)

      // 关闭后由 Effects 回收 workspace
      await service.runOnce()
      expect(backend.stopped).toContain('term-1')
      expect(backend.removed).toContain('path:/tmp/tk-1')
    })

    it('提醒还没发出去时不会自动关闭，避免用户没看到通知就被关单', async () => {
      const ticketId = seed()
      await service.sweepRetention(T0 + 24 * HOUR + 1000)

      // 不跑 Effects：提醒仍停留在 outbox pending，宽限期到了也不能关。
      await service.sweepRetention(T0 + 31 * HOUR)
      expect(store.getTicket(ticketId)?.stage).not.toBe('closed')
    })

    it('PR 仍开着：只催办一次，不自动关闭', async () => {
      const ticketId = seed({ prState: 'open' })

      await service.sweepRetention(T0 + 24 * HOUR + 1000)
      await service.sweepRetention(T0 + 48 * HOUR)

      expect(store.getTicket(ticketId)?.stage).not.toBe('closed')
      const urges = store.claimOutbox('2026-11-07T20:00:00.000Z', 50).filter(item => item.text.includes('PR 已经'))
      expect(urges).toHaveLength(1)
    })

    it('执行中 6 小时无上报且终端无输出：转人工，不自动关闭', async () => {
      const ticketId = seed({ state: 'progress' })
      backend.handles.set('term-1', true)
      backend.outputAt = '2026-11-06T10:00:00.000Z'

      await service.sweepRetention(T0 + 6 * HOUR + 1000)
      expect(store.getTicket(ticketId)?.stage).toBe('person')
      expect(store.getAttention(ticketId)?.question).toContain('6 小时没有上报')

      // 转人工后不再自动关闭
      await service.sweepRetention(T0 + 30 * HOUR)
      expect(store.getTicket(ticketId)?.stage).not.toBe('closed')
    })

    it('提醒后出现新进展：取消自动关闭', async () => {
      const ticketId = seed()
      await service.sweepRetention(T0 + 24 * HOUR + 1000)

      const assignment = store.latestAssignment(ticketId)!
      store.insertReport({
        id: 'rp_late_1',
        ticketId,
        assignmentId: assignment.id,
        turn: 2,
        state: 'progress',
        summary: '又有进展',
        ackedInputs: [],
        at: new Date(T0 + 25 * HOUR).toISOString(),
      })

      await service.sweepRetention(T0 + 31 * HOUR)
      expect(store.getTicket(ticketId)?.stage).not.toBe('closed')
      expect(store.getCursor(`retention:reminder:${ticketId}`)).toBeNull()
    })

    it('workspace 有未提交改动时不强删，并通知人工处理', async () => {
      const ticketId = seed()
      backend.removeError = 'worktree has uncommitted changes'

      await service.sweepRetention(T0 + 24 * HOUR + 1000)
      await service.runOnce()
      await service.sweepRetention(T0 + 30 * HOUR + 1000)
      expect(store.getTicket(ticketId)?.stage).toBe('closed')

      await service.runOnce()
      expect(backend.removed).toHaveLength(0)
      expect(store.listOutbox(50).some(item => item.text.includes('未能自动回收'))).toBe(true)
    })
  })
})

describe('会话文件清理', () => {
  function serviceWithSession(): { service: RouterService; store: Store; config: AppConfig; home: string } {
    const home = mkdtempSync(join(tmpdir(), 'ra-clean-'))
    const store = new Store(':memory:')
    const config = { ...defaultConfig(), home }
    config.feishu = { ...config.feishu, chats: [chatEntry('oc_dev')], allowed: ['ou_alice'] }
    const engine = new Engine({ store, policy: policyOf(config), clock: { now: () => '2026-11-06T10:00:00.000Z' } })
    const service = new RouterService({
      config,
      store,
      engine,
      backend: new FakeBackend(),
      decisionEngine: new AcceptEngine(),
      prTracker: new FakePrTracker(),
      clock: { now: () => '2026-11-20T00:00:00.000Z' },
    })
    return { service, store, config, home }
  }

  it('只删 /new 后超过 7 天、且位于 sessions 根目录下的文件', async () => {
    const { service, store, config, home } = serviceWithSession()
    const { mkdirSync, writeFileSync, existsSync } = await import('node:fs')
    const sessionDir = join(home, 'sessions')
    mkdirSync(sessionDir, { recursive: true })
    const oldFile = join(sessionDir, 'old.jsonl')
    writeFileSync(oldFile, '{}')
    store.upsertChatSession({
      sessionKey: 'chat:oc_dev:user:ou_alice',
      chatId: 'oc_dev',
      actorId: 'ou_alice',
      threadId: '',
      sessionFile: oldFile,
      sessionId: 'sid',
      soulVersion: '',
      policyVersion: '',
      createdAt: '2026-10-01T00:00:00.000Z',
      lastUsedAt: '2026-10-01T00:00:00.000Z',
      status: 'superseded',
      resetAt: '2026-10-01T00:00:00.000Z',
      resetBy: 'ou_alice',
      purgedAt: null,
    })
    expect(config.router.session.retentionDays).toBe(7)

    expect(await service.cleanupChatSessions()).toBe(1)
    expect(existsSync(oldFile)).toBe(false)
    expect(store.getChatSession('chat:oc_dev:user:ou_alice')).toBeNull()
    expect(store.getChatSessionByFile(oldFile)?.status).toBe('purged')
  })

  it('路径不在 sessions 根目录下的记录不会被删除', async () => {
    const { service, store } = serviceWithSession()
    const { writeFileSync, existsSync, mkdtempSync: mk } = await import('node:fs')
    const outside = join(mk(join(tmpdir(), 'ra-outside-')), 'keep.jsonl')
    writeFileSync(outside, '{}')
    store.upsertChatSession({
      sessionKey: 'chat:oc_dev:user:ou_bob',
      chatId: 'oc_dev',
      actorId: 'ou_bob',
      threadId: '',
      sessionFile: outside,
      sessionId: 'sid',
      soulVersion: '',
      policyVersion: '',
      createdAt: '2026-10-01T00:00:00.000Z',
      lastUsedAt: '2026-10-01T00:00:00.000Z',
      status: 'superseded',
      resetAt: '2026-10-01T00:00:00.000Z',
      resetBy: 'ou_bob',
      purgedAt: null,
    })

    expect(await service.cleanupChatSessions()).toBe(0)
    expect(existsSync(outside)).toBe(true)
  })
})
