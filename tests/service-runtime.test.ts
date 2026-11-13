import { beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store/db.js'
import { Engine } from '../src/core/engine.js'
import { RouterService, extractTerminalSnippet, extractSessionSnippet, formatProbeMessage } from '../src/service.js'
import { claudeProjectSlug } from '#runtime/agents/claude.js'
import { defaultConfig, policyOf, type AppConfig, chatEntry } from '../src/config.js'
import { DEFAULT_ADMISSION } from '#core/policy.js'
import type {
  WorkerRuntime,
  WorkerContext,
  SessionEvent,
  WorkerRef,
  StartResult,
  DeliveryReceipt,
  AgentStatus,
  WorkspaceInfo,
  WorkspaceRef,
} from '#runtime/port.js'
import type { Trigger } from '#core/model.js'
import type { DecisionEngine } from '../src/router/decision-engine.js'

/** 测试用：所有候选都 accept，回复为空。 */
function acceptEngine(): DecisionEngine {
  return {
    async assess(req) {
      const proposal = {
        triggerId: req.trigger.id,
        decision: 'accept' as const,
        strength: req.strength,
        reason: 'test',
        title: '测试工单',
        scope: '测试',
        rules: [],
      }
      return {
        proposal,
        audit: {
          engine: 'pi' as const,
          triggerId: req.trigger.id,
          durationMs: 1,
          toolCalls: [],
          tokens: { input: 0, output: 0, total: 0 },
          promptChars: { system: 0, user: 0 },
          proposal,
        },
      }
    },
    async reply() {
      return ''
    },
  }
}

class FakeRuntime implements WorkerRuntime {
  readonly id = 'orca'
  readonly capabilities = {
    agent: { liveStatus: true, processExit: false, output: true, activity: true, structuredInput: true, nudge: true },
    workspace: { cleanup: true, prLink: true, discovery: true },
  }
  starts: WorkerContext[] = []
  delivered: { handle: string; text: string }[] = []
  reattachCalls: string[] = []
  /** 模拟「上一轮被重启打断」；null 表示没有被打断的轮次。 */
  interrupted: { turnId: string; summary?: string } | null = null
  interruptedCalls: string[] = []
  /** 模拟 ACP 回合未结束：始终返回 queued。 */
  deliverQueue = false
  /** 模拟投递抛错（例如 Claude resume fork 但没有拿到新 id）。 */
  deliverError = ''
  /** 模拟运行时在投递时切换了会话。 */
  deliverHandle = ''
  /** 模拟 Agent 停在交互式提示上：运行时要求转人工。 */
  deliverNeedsHuman = false
  handles = new Map<string, { lastOutputAt: string }>()
  linkedPr: Record<string, unknown> | null = null
  /** 主动巡检读取的终端渲染屏幕。 */
  screen: string[] = []
  readStatus: 'running' | 'exited' | 'unknown' = 'running'
  /** 主动巡检优选的 Agent 会话记录；为 null 时退回终端屏幕。 */
  sessionEvents: SessionEvent[] | null = null
  sessionAt = ''
  async start(ctx: WorkerContext): Promise<StartResult> {
    const handle = `term-${this.starts.length + 1}`
    this.starts.push(ctx)
    this.handles.set(handle, { lastOutputAt: new Date().toISOString() })
    return { handle, workdir: `/tmp/${ctx.ticket.id}`, branch: `ra/${ctx.ticket.id}` }
  }
  async deliver(ref: WorkerRef | string, inputs: { text: string; id: string }[]): Promise<DeliveryReceipt> {
    if (this.deliverQueue) return { status: 'queued', inputIds: inputs.map(input => input.id), reason: 'acp:busy' }
    if (this.deliverNeedsHuman) {
      return {
        status: 'rejected',
        inputIds: [],
        reason: 'orca:agent-prompt-blocked',
        retryable: true,
        needsHuman: true,
        detail: 'agent_prompt_blocked The agent is showing a permission or trust prompt',
      }
    }
    if (this.deliverError) throw new Error(this.deliverError)
    const handle = typeof ref === 'string' ? ref : ref.handle
    for (const input of inputs) this.delivered.push({ handle, text: input.text })
    return {
      status: 'accepted',
      inputIds: inputs.map(input => input.id),
      ...(this.deliverHandle ? { handle: this.deliverHandle, sessionId: 's-new' } : {}),
    }
  }
  async reattach(ref: WorkerRef | string) {
    this.reattachCalls.push(typeof ref === 'string' ? ref : ref.handle)
    return true
  }
  async interruptedTurn(ref: WorkerRef | string) {
    this.interruptedCalls.push(typeof ref === 'string' ? ref : ref.handle)
    return this.interrupted
  }
  async registerContext() {}
  async stop() {}
  async nudge(ref: WorkerRef | string) {
    this.delivered.push({ handle: typeof ref === 'string' ? ref : ref.handle, text: 'status?' })
  }
  async status(ref: WorkerRef | string): Promise<AgentStatus | null> {
    const handle = typeof ref === 'string' ? ref : ref.handle
    const entry = this.handles.get(handle)
    if (!entry) return { alive: false, phase: 'lost', acceptingInput: false }
    return { alive: true, phase: 'running', acceptingInput: true, lastActivityAt: entry.lastOutputAt }
  }
  async read() {
    return { status: this.readStatus, lines: this.screen, source: 'screen' }
  }
  async output() {
    return this.read()
  }
  async session() {
    if (!this.sessionEvents) return null
    return { at: this.sessionAt || new Date().toISOString(), events: this.sessionEvents }
  }
  async activity() {
    return this.session()
  }
  async inspectWorkspace(): Promise<WorkspaceInfo | null> {
    const linked = this.linkedPr?.linkedPR as { number?: number; url?: string } | undefined
    return {
      workdir: '',
      branch: '',
      ...(linked && Number(linked.number) > 0
        ? { linkedPr: { number: Number(linked.number), url: String(linked.url ?? '') } }
        : {}),
    }
  }
  async inspectWorktree() {
    return this.linkedPr
  }
  /** 批量清理：记录被回收的目录，并按 removeErrors 模拟脏工作区被 provider 拒绝。 */
  removed: string[] = []
  removeErrors = new Map<string, string>()
  async removeWorkspace(ref: WorkspaceRef): Promise<void> {
    const message = this.removeErrors.get(ref.workdir)
    if (message) throw new Error(message)
    this.removed.push(ref.workdir)
    rmSync(ref.workdir, { recursive: true, force: true })
  }
}

class NullPrTracker {
  async view() { return null }
  async findByBranch() { return null }
}

function trigger(over: Partial<Trigger> = {}): Trigger {
  return {
    id: 't1', source: 'feishu', externalId: 'om_1', threadId: 'feishu:oc_dev:om_root', chatId: 'oc_dev', chatName: '研发群',
    actorId: 'ou_alice', actorName: 'Alice', isBot: false, text: '帮我把登录超时改成 30 秒', addressed: 'mention',
    receivedAt: '2026-11-06T09:59:00.000Z', disposition: 'pending', ...over,
  }
}

describe('运行时机制', () => {
  let store: Store
  let engine: Engine
  let runtime: FakeRuntime
  let config: AppConfig
  let service: RouterService
  let now: number
  /** 收集服务日志，断言关键事件名与字段。 */
  let logs: Array<{ level: string; message: string; extra?: Record<string, unknown> }>

  beforeEach(() => {
    now = Date.parse('2026-11-06T10:05:00.000Z')
    const home = mkdtempSync(join(tmpdir(), 'ra-rt-'))
    store = new Store(':memory:')
    config = { ...defaultConfig(), home }
    config.projects = [{ name: 'acme/web', repo: 'acme/web', defaultBranch: 'main' }]
    config.policy = { acceptMode: 'auto', maxWorkers: 4, admission: { ...DEFAULT_ADMISSION }, interruptedRecovery: 'auto', maxAutoRecover: 1 }
    config.feishu = { ...config.feishu, chats: [chatEntry('oc_dev')], allowed: ['ou_alice'] }
    let n = 0
    engine = new Engine({ store, policy: policyOf(config), clock: { now: () => new Date(now).toISOString() }, ids: { next: p => `${p}_${++n}` } })
    runtime = new FakeRuntime()
    logs = []
    service = new RouterService({
      config, store, engine, runtime,
      decisionEngine: acceptEngine(),
      prTracker: new NullPrTracker(),
      clock: { now: () => new Date(now).toISOString() },
      logger: {
        info: (message, extra) => { logs.push({ level: 'info', message, ...(extra ? { extra } : {}) }) },
        warn: (message, extra) => { logs.push({ level: 'warn', message, ...(extra ? { extra } : {}) }) },
        error: (message, extra) => { logs.push({ level: 'error', message, ...(extra ? { extra } : {}) }) },
      },
      agentLoopOptions: { batchWindowMs: 0 },
      claudeProjectsDir: join(home, 'claude-projects'),
    })
  })

  async function launchOne(): Promise<{ ticketId: string; handle: string; assignmentId: string }> {
    engine.ingest(trigger())
    await service.runOnce()
    const ticket = store.listTickets()[0]!
    const assignment = store.latestAssignment(ticket.id)!
    return { ticketId: ticket.id, handle: assignment.handle, assignmentId: assignment.id }
  }

  it('accepted 未 ack 时按退避，不每秒重投', async () => {
    const { ticketId } = await launchOne()
    engine.deliverInput(ticketId, { kind: 'followup', text: '第一件事' })
    await service.runOnce()
    const afterFirst = runtime.delivered.length
    await service.runOnce()
    expect(runtime.delivered.length).toBe(afterFirst)
  })

  it('deliver 抛错也计入重投次数并遵守退避，不会每秒拉起新会话', async () => {
    const { ticketId } = await launchOne()
    runtime.deliverError = 'claude:resume-forked'
    engine.deliverInput(ticketId, { kind: 'followup', text: '继续' })

    // 第一轮发起投递并失败。
    await service.runOnce()
    const failed = logs.filter(item => item.message === 'input:deliver-failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.extra).toMatchObject({ ticketId, attempt: 1 })

    // cooldown 内每个 tick 都不应再次投递。
    now += 1_000
    await service.runOnce()
    now += 5_000
    await service.runOnce()
    expect(logs.filter(item => item.message === 'input:deliver-failed')).toHaveLength(1)

    // 退避结束后才进行第 2 次尝试。
    now += 31_000
    await service.runOnce()
    expect(logs.filter(item => item.message === 'input:deliver-failed').at(-1)?.extra).toMatchObject({ attempt: 2 })
  })

  it('连续失败达到上限后转人工，不再无限重投', async () => {
    const { ticketId } = await launchOne()
    runtime.deliverError = 'claude:resume-forked'
    engine.deliverInput(ticketId, { kind: 'followup', text: '继续' })

    for (let i = 0; i < 6; i++) {
      await service.deliverPendingInputs()
      now += 10 * 60_000
    }
    expect(logs.some(item => item.message === 'input:redeliver-giveup')).toBe(true)
    expect(store.getAttention(ticketId)?.question ?? '').toContain('5 次')
  })

  it('Agent 停在交互式提示上时转人工并通知话题，不再静默重投', async () => {
    const { ticketId } = await launchOne()
    runtime.deliverNeedsHuman = true
    engine.deliverInput(ticketId, { kind: 'followup', text: '继续' })

    await service.deliverPendingInputs()

    expect(store.getAttention(ticketId)?.question ?? '').toContain('交互式提示')
    const texts = store.listOutbox(50).map(item => item.text).join('\n')
    expect(texts).toContain('交互式提示')
    expect(texts).toContain('Orca 终端')
    expect(logs.some(item => item.message === 'input:prompt-blocked')).toBe(true)
  })

  it('运行时投递时接管了新会话，Assignment 的 handle 同步更新', async () => {
    const { ticketId, handle } = await launchOne()
    runtime.deliverHandle = 'term-new'
    runtime.handles.set('term-new', { lastOutputAt: new Date(now).toISOString() })
    engine.deliverInput(ticketId, { kind: 'followup', text: '继续' })
    await service.runOnce()

    expect(store.latestAssignment(ticketId)?.handle).toBe('term-new')
    expect(store.latestAssignment(ticketId)?.handle).not.toBe(handle)
    expect(logs.find(item => item.message === 'input:adopted-handle')?.extra).toMatchObject({
      from: handle,
      to: 'term-new',
    })
  })

  it('worker 忙时 queued 不累计重投次数，长回合不会被误判为未 ack', async () => {
    const { ticketId } = await launchOne()
    runtime.deliverQueue = true
    engine.deliverInput(ticketId, { kind: 'followup', text: '长任务' })
    for (let i = 0; i < 8; i++) {
      now += 31_000
      await service.deliverPendingInputs()
    }
    expect(store.getAttention(ticketId)?.question ?? '').not.toContain('仍未 ack')
  })

  it('有新输入时，把未 ack 的旧输入一并重投（去重靠 id）', async () => {
    const { ticketId, handle } = await launchOne()
    const first = engine.deliverInput(ticketId, { kind: 'followup', text: '第一件事' })
    await service.runOnce()
    expect(runtime.delivered.map(d => d.text)).toEqual(['第一件事'])

    const second = engine.deliverInput(ticketId, { kind: 'followup', text: '第二件事' })
    await service.runOnce()
    const lastTwo = runtime.delivered.slice(-2).map(d => d.text)
    expect(lastTwo).toEqual(['第一件事', '第二件事'])
    expect(handle).toBeTruthy()
    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
  })

  it('ack 过的输入不会重投', async () => {
    const { ticketId, assignmentId } = await launchOne()
    engine.deliverInput(ticketId, { kind: 'followup', text: '第一件事' })
    await service.runOnce()
    service.onWorkerState({
      ticketId, assignmentId, turn: 2, state: 'progress', summary: '收到', prNumber: 0, prUrl: '',
      ackedInputs: [store.listInputs(ticketId)[0]!.id], updatedAt: new Date(now).toISOString(),
    })
    engine.deliverInput(ticketId, { kind: 'followup', text: '第二件事' })
    await service.runOnce()
    expect(runtime.delivered.slice(-1).map(d => d.text)).toEqual(['第二件事'])
  })

  it('终端长时间无输出时发 status? 唤醒，仍无响应则标记 stale 并通知', async () => {
    const { ticketId, handle, assignmentId } = await launchOne()
    service.onWorkerState({
      ticketId, assignmentId, turn: 1, state: 'progress', summary: '做到一半', prNumber: 0, prUrl: '',
      ackedInputs: [], updatedAt: new Date(now).toISOString(),
    })
    // 终端最后输出在 10 分钟前
    runtime.handles.set(handle, { lastOutputAt: new Date(now - 10 * 60_000).toISOString() })

    await service.checkIdle(now)
    expect(runtime.delivered.some(d => d.text.includes('status?'))).toBe(true)

    await service.checkIdle(now + 10 * 60_000)
    expect(store.getAttention(ticketId)?.question).toContain('无响应')
    const outbox = store.claimOutbox(new Date(now + 20 * 60_000).toISOString(), 10)
    expect(outbox.some(item => item.text.includes('无响应'))).toBe(true)
  })

  it('有新上报后 idle 计时应重置', async () => {
    const { ticketId, handle, assignmentId } = await launchOne()
    service.onWorkerState({
      ticketId, assignmentId, turn: 1, state: 'progress', summary: '做到一半', prNumber: 0, prUrl: '',
      ackedInputs: [], updatedAt: new Date(now).toISOString(),
    })
    runtime.handles.set(handle, { lastOutputAt: new Date(now - 10 * 60_000).toISOString() })
    await service.checkIdle(now)
    const before = runtime.delivered.length

    service.onWorkerState({
      ticketId, assignmentId, turn: 2, state: 'progress', summary: '又动了', prNumber: 0, prUrl: '',
      ackedInputs: [], updatedAt: new Date(now + 1000).toISOString(),
    })
    await service.checkIdle(now + 2000)
    expect(runtime.delivered.length).toBe(before)
  })

  it('worker 长时间不报进展时，Router 主动读终端并同步到话题', async () => {
    const { ticketId, handle } = await launchOne()
    runtime.screen = ['⏺ 正在修改登录超时配置', '⎿ pnpm test 进行中', '✻ Cascading… (30s)']
    runtime.handles.set(handle, { lastOutputAt: new Date(now + 10 * 60_000).toISOString() })

    await service.probeProgress(now + 11 * 60_000)

    const probe = store.listOutbox(200).find(item => item.text.includes('进展巡检'))
    expect(probe).toBeTruthy()
    expect(probe!.text).toContain('running')
    expect(probe!.text).toContain('正在修改登录超时配置')
    expect(probe!.text).not.toContain('pnpm test 进行中')
    expect(probe!.text).not.toContain('Cascading')
    expect(probe!.threadId).toBe('om_root')
    expect(store.getTicket(ticketId)?.stage).toBe('running')
  })

  it('同一静默期按 repeatMs 限流，避免重复刷屏', async () => {
    await launchOne()
    runtime.screen = ['⏺ 正在跑测试']

    await service.probeProgress(now + 11 * 60_000)
    await service.probeProgress(now + 20 * 60_000)
    expect(store.listOutbox(200).filter(item => item.text.includes('进展巡检'))).toHaveLength(1)

    // 距上次提醒 16 分钟，超过 repeatMs（15 分钟），允许再次提醒。
    await service.probeProgress(now + 27 * 60_000)
    expect(store.listOutbox(200).filter(item => item.text.includes('进展巡检'))).toHaveLength(2)
  })

  it('ready 之后又收到新输入时，仍会主动巡检正在补做的 worker', async () => {
    const { ticketId, assignmentId } = await launchOne()
    service.onWorkerState({
      ticketId, assignmentId, turn: 1, state: 'ready', summary: '第一轮完成', prNumber: 0, prUrl: '',
      ackedInputs: [], updatedAt: new Date(now).toISOString(),
    })
    expect(store.getTicket(ticketId)?.stage).toBe('review')

    now += 1_000
    engine.deliverInput(ticketId, { kind: 'followup', text: '再补一个单测' })
    runtime.screen = ['⏺ 正在补充单测', '✽ Cascading… (12s)']

    await service.probeProgress(now + 11 * 60_000)

    const probe = store.listOutbox(200).find(item => item.text.includes('进展巡检'))
    expect(probe).toBeTruthy()
    expect(probe!.text).toContain('正在补充单测')
    expect(probe!.text).toContain('review')
  })

  it('终端已退出时不发巡检消息（交给空闲巡检处理）', async () => {
    await launchOne()
    runtime.readStatus = 'exited'
    runtime.screen = ['⏺ 旧画面']

    await service.probeProgress(now + 11 * 60_000)
    expect(store.listOutbox(200).filter(item => item.text.includes('进展巡检'))).toHaveLength(0)
  })

  it('终端长时间没有新输出时，巡检消息会提示可能卡住', async () => {
    const { handle } = await launchOne()
    runtime.screen = ['⏺ 最后一条输出']
    runtime.handles.set(handle, { lastOutputAt: new Date(now - 20 * 60_000).toISOString() })

    await service.probeProgress(now + 21 * 60_000)

    const probe = store.listOutbox(200).find(item => item.text.includes('进展巡检'))
    expect(probe?.text).toContain('没有新输出')
    expect(probe?.text).toContain('可能')
  })

  it('优先使用 Agent 会话记录，不再读终端屏幕', async () => {
    await launchOne()
    runtime.screen = ['⏺ 屏幕噪声']
    runtime.sessionEvents = [
      { at: new Date(now + 5 * 60_000).toISOString(), kind: 'tool', text: 'Edit(service.ts)' },
      { at: new Date(now + 6 * 60_000).toISOString(), kind: 'text', text: '正在补单测' },
    ]
    runtime.sessionAt = new Date(now + 6 * 60_000).toISOString()

    await service.probeProgress(now + 11 * 60_000)

    const probe = store.listOutbox(200).find(item => item.text.includes('进展巡检'))
    expect(probe?.text).toContain('Claude 会话记录')
    expect(probe?.text).toContain('正在补单测')
    expect(probe?.text).not.toContain('Edit(service.ts)')
    expect(probe?.text).not.toContain('屏幕噪声')
  })

  it('会话记录里文本之后的工具调用折叠成动作概要，不逐条回放', async () => {
    await launchOne()
    runtime.sessionEvents = [
      { at: new Date(now + 5 * 60_000).toISOString(), kind: 'text', text: '开始改登录超时' },
      { at: new Date(now + 6 * 60_000).toISOString(), kind: 'tool', text: 'Edit(login.ts)', tool: { name: 'Edit', target: 'login.ts' } },
      { at: new Date(now + 7 * 60_000).toISOString(), kind: 'tool', text: 'Bash：跑测试' },
      { at: new Date(now + 8 * 60_000).toISOString(), kind: 'tool', text: 'TodoWrite' },
    ]
    runtime.sessionAt = new Date(now + 8 * 60_000).toISOString()

    await service.probeProgress(now + 11 * 60_000)

    const probe = store.listOutbox(200).find(item => item.text.includes('进展巡检'))
    expect(probe?.text).toContain('开始改登录超时')
    expect(probe?.text).toContain('动作概要：修改 login.ts、执行 跑测试')
    expect(probe?.text).not.toContain('Edit(login.ts)')
    expect(probe?.text).not.toContain('TodoWrite')
  })

  it('会话记录不可用时退回终端屏幕', async () => {
    await launchOne()
    runtime.sessionEvents = null
    runtime.screen = ['⏺ 终端里的进展']

    await service.probeProgress(now + 11 * 60_000)

    const probe = store.listOutbox(200).find(item => item.text.includes('进展巡检'))
    expect(probe?.text).toContain('终端屏幕')
    expect(probe?.text).toContain('终端里的进展')
  })

  it('extractTerminalSnippet 过滤工具调用回显与状态栏，只留语义化动作概要', () => {
    const snippet = extractTerminalSnippet([
      '✻ Brewed for 3m · done',
      '❯ 【Router 输入 in_1】',
      '  给我改个东西',
      '⏺ Update(tests/config.test.ts)',
      '⎿  Added 11 lines',
      '  ⎿  $ pnpm test',
      '✽ Cascading… (30s)',
      '────────────────────────',
      '❯',
      '  当前模型: deepseek-v4.1-flash',
    ])
    expect(snippet).toContain('动作概要：修改 tests/config.test.ts')
    expect(snippet).not.toContain('Update(')
    expect(snippet).not.toContain('Added 11 lines')
    expect(snippet).not.toContain('给我改个东西')
    expect(snippet).not.toContain('$ pnpm test')
    expect(snippet).not.toContain('当前模型')
    expect(snippet).not.toContain('Cascading')
    expect(snippet).not.toContain('❯')
  })

  it('extractSessionSnippet 只展示助手文本，过滤工具调用噪音', () => {
    const snippet = extractSessionSnippet([
      { at: '2026-11-06T10:00:00.000Z', kind: 'tool', text: 'Edit(README.md)' },
      { at: '2026-11-06T10:01:00.000Z', kind: 'tool', text: 'Edit(README.md)' },
      { at: '2026-11-06T10:02:00.000Z', kind: 'tool', text: 'Edit(README.md)' },
      { at: '2026-11-06T10:03:00.000Z', kind: 'text', text: 'README 改完了，接下来跑测试' },
    ])
    expect(snippet).toContain('README 改完了，接下来跑测试')
    expect(snippet).not.toContain('Edit(README.md)')
    expect(snippet).not.toContain('动作概要')
  })

  it('extractSessionSnippet 把最后一条文本之后的工具动作折叠成一行概要', () => {
    const snippet = extractSessionSnippet([
      { at: '2026-11-06T10:00:00.000Z', kind: 'text', text: '先看一下配置' },
      { at: '2026-11-06T10:01:00.000Z', kind: 'tool', text: 'Read(service.ts)' },
      { at: '2026-11-06T10:02:00.000Z', kind: 'tool', text: 'Edit(service.ts)', tool: { name: 'Edit', target: 'service.ts' } },
      { at: '2026-11-06T10:03:00.000Z', kind: 'tool', text: 'Edit(service.ts)', tool: { name: 'Edit', target: 'service.ts' } },
      { at: '2026-11-06T10:04:00.000Z', kind: 'tool', text: 'Bash：跑测试' },
      { at: '2026-11-06T10:05:00.000Z', kind: 'tool', text: 'TodoWrite' },
    ])
    expect(snippet).toContain('先看一下配置')
    expect(snippet).toContain('动作概要：查看 service.ts、修改 service.ts ×2、执行 跑测试')
    expect(snippet).not.toContain('TodoWrite')
    expect(snippet).not.toContain('Edit(service.ts)')
  })

  it('extractTerminalSnippet 没有活动标记时取输入回显之前的尾部文本', () => {
    const snippet = extractTerminalSnippet(['- 删除了 ACK 文案', '  验证通过', '❯ 【Router 输入 in_2】', '  新需求'])
    expect(snippet).toBe('- 删除了 ACK 文案\n验证通过')
  })

  it('formatProbeMessage 会中和摘录里的三反引号，避免破坏飞书代码块', async () => {
    const { ticketId } = await launchOne()
    const ticket = store.getTicket(ticketId)!
    const text = formatProbeMessage(ticket, {
      nowMs: now + 11 * 60_000,
      lastProgress: now,
      snippet: '⏺ 示例\n```ts\nconst a = 1\n```',
      unchanged: false,
      lastActivityAt: now + 10 * 60_000,
      lastOutputAt: now + 10 * 60_000,
      source: 'session',
      silenceMs: 600_000,
    })
    expect(text).not.toContain('```ts')
    expect(text).toContain("'''ts")
    expect(text).toContain('Claude 会话记录')
  })

  it('PR 优先取 Orca worktree 的 linkedPR，拿不到才回退 gh', async () => {
    const { ticketId } = await launchOne()
    runtime.linkedPr = { linkedPR: { number: 42, url: 'https://github.com/acme/web/pull/42' } }
    await service.trackPullRequests()
    expect(store.getTicket(ticketId)?.prNumber).toBe(42)
    expect(store.getTicket(ticketId)?.prState).toBe('open')
  })

  it('重启对账：orphaned 但仍 connected 的终端按存活复用', async () => {
    const { ticketId } = await launchOne()
    const assignment = store.latestAssignment(ticketId)!
    // 模拟实测行为：CLI 创建的终端 orphaned=true，但连接正常
    runtime.status = async () => ({
      alive: true,
      phase: 'running',
      acceptingInput: true,
      lastActivityAt: new Date().toISOString(),
      detail: { orphaned: true },
    })
    await service.recover()
    expect(runtime.starts).toHaveLength(1)
    expect(store.latestAssignment(ticketId)!.id).toBe(assignment.id)
    expect(runtime.reattachCalls).toHaveLength(0)
  })

  it('重启对账：exited 但可恢复的会话先 reattach 接回，不重新派工', async () => {
    const { ticketId } = await launchOne()
    engine.setAttention(ticketId, 'worker 无响应：长时间没有新的 state.json 上报，已标记 stale，请人工确认')
    runtime.status = async () => ({
      alive: false,
      phase: 'exited',
      acceptingInput: true,
      lastActivityAt: new Date(now).toISOString(),
    })
    await service.recover()
    expect(runtime.reattachCalls).toHaveLength(1)
    expect(runtime.starts).toHaveLength(1)
    expect(store.getAttention(ticketId)).toBeNull()
  })

  it('重启对账：worker 上一轮被中断时自动补一条 retry 输入，并发中断与恢复提示', async () => {
    const { ticketId } = await launchOne()
    // 只有进程随 Router 一起死的运行时才需要中断恢复。
    runtime.capabilities.agent.processExit = true
    runtime.status = async () => ({
      alive: false,
      phase: 'exited',
      acceptingInput: true,
      lastActivityAt: new Date(now).toISOString(),
    })
    runtime.interrupted = { turnId: 'turn_x', summary: '执行命令：npm test' }

    await service.recover()

    expect(runtime.interruptedCalls).toHaveLength(1)
    // 自动恢复：补一条 kind=retry 的输入。
    const inputs = store.listInputs(ticketId)
    const retry = inputs.find(input => input.kind === 'retry')
    expect(retry).toBeDefined()
    expect(retry!.text).toContain('npm test')
    expect(retry!.text).toContain('检查当前现场')

    // 中断提示与恢复提示都要发出去。
    const outbox = store.listOutbox(50)
    const texts = outbox.map(item => item.text).join('\n')
    expect(texts).toContain('因服务重启被中断')
    expect(texts).toContain('已自动从中断处恢复')

    // 关键事件要能在日志里查到（排查「任务为什么停了」的第一入口）。
    const interrupted = logs.find(item => item.message === 'recover:interrupted')
    expect(interrupted).toBeDefined()
    expect(interrupted!.extra?.turnId).toBe('turn_x')
    expect(interrupted!.extra?.mode).toBe('auto')
    const resumed = logs.find(item => item.message === 'recover:auto-resume')
    expect(resumed).toBeDefined()
    expect(resumed!.extra?.turnId).toBe('turn_x')
  })

  it('重启对账：interruptedRecovery=notify 时只提醒，不自动补输入', async () => {
    const { ticketId } = await launchOne()
    config.policy.interruptedRecovery = 'notify'
    runtime.capabilities.agent.processExit = true
    runtime.status = async () => ({
      alive: false,
      phase: 'exited',
      acceptingInput: true,
      lastActivityAt: new Date(now).toISOString(),
    })
    runtime.interrupted = { turnId: 'turn_y', summary: '写入文件：a.txt' }

    await service.recover()

    expect(store.listInputs(ticketId).filter(input => input.kind === 'retry')).toHaveLength(0)
    const texts = store.listOutbox(50).map(item => item.text).join('\n')
    expect(texts).toContain('因服务重启被中断')
    expect(texts).toContain('回复「继续」')
    expect(texts).not.toContain('已自动从中断处恢复')
  })

  it('重启对账：同一个被中断的轮次不会重复恢复', async () => {
    const { ticketId } = await launchOne()
    runtime.capabilities.agent.processExit = true
    runtime.status = async () => ({
      alive: false,
      phase: 'exited',
      acceptingInput: true,
      lastActivityAt: new Date(now).toISOString(),
    })
    runtime.interrupted = { turnId: 'turn_z', summary: '步骤 1' }

    await service.recover()
    const first = store.listInputs(ticketId).filter(input => input.kind === 'retry').length
    expect(first).toBe(1)

    // 再次重启：同一轮不再重复恢复。
    await service.recover()
    expect(store.listInputs(ticketId).filter(input => input.kind === 'retry')).toHaveLength(first)
  })

  it('重启对账：自动恢复次数用完后降级为提醒', async () => {
    const { ticketId } = await launchOne()
    config.policy.maxAutoRecover = 1
    runtime.capabilities.agent.processExit = true
    runtime.status = async () => ({
      alive: false,
      phase: 'exited',
      acceptingInput: true,
      lastActivityAt: new Date(now).toISOString(),
    })
    runtime.interrupted = { turnId: 'turn_1', summary: '步骤 A' }
    await service.recover()
    expect(store.listInputs(ticketId).filter(input => input.kind === 'retry')).toHaveLength(1)

    // 换一个被中断的轮次，但自动恢复次数已经用完。
    runtime.interrupted = { turnId: 'turn_2', summary: '步骤 B' }
    await service.recover()
    expect(store.listInputs(ticketId).filter(input => input.kind === 'retry')).toHaveLength(1)
    const texts = store.listOutbox(50).map(item => item.text).join('\n')
    expect(texts).toContain('自动恢复次数已达上限')
  })

  it('重启对账：worker 进程不随 Router 死时不触发中断恢复', async () => {
    const { ticketId } = await launchOne()
    // orca / claude-code 的 worker 活在自己的常驻服务里，重启期间照常干活。
    runtime.capabilities.agent.processExit = false
    runtime.status = async () => ({
      alive: false,
      phase: 'exited',
      acceptingInput: true,
      lastActivityAt: new Date(now).toISOString(),
    })
    runtime.interrupted = { turnId: 'turn_no', summary: '不该被处理' }

    await service.recover()

    expect(runtime.interruptedCalls).toHaveLength(0)
    expect(store.listInputs(ticketId).filter(input => input.kind === 'retry')).toHaveLength(0)
  })

  it('重启对账：interruptedRecovery=off 时完全不处理', async () => {
    const { ticketId } = await launchOne()
    config.policy.interruptedRecovery = 'off'
    runtime.capabilities.agent.processExit = true
    runtime.status = async () => ({
      alive: false,
      phase: 'exited',
      acceptingInput: true,
      lastActivityAt: new Date(now).toISOString(),
    })
    runtime.interrupted = { turnId: 'turn_off', summary: '不该被处理' }

    await service.recover()

    expect(runtime.interruptedCalls).toHaveLength(0)
    expect(store.listInputs(ticketId).filter(input => input.kind === 'retry')).toHaveLength(0)
  })

  it('重启对账：自动恢复投递失败时记 warn 并提示用户手动继续', async () => {
    const { ticketId } = await launchOne()
    runtime.capabilities.agent.processExit = true
    runtime.status = async () => ({
      alive: false,
      phase: 'exited',
      acceptingInput: true,
      lastActivityAt: new Date(now).toISOString(),
    })
    runtime.interrupted = { turnId: 'turn_fail', summary: '步骤 C' }
    // 投递队列炸了：恢复动作发不出去。
    engine.deliverInput = () => { throw new Error('engine:closed') }

    await service.recover()

    const failed = logs.find(item => item.message === 'recover:auto-resume-failed')
    expect(failed).toBeDefined()
    expect(failed!.extra?.turnId).toBe('turn_fail')
    expect(typeof failed!.extra?.message).toBe('string')
    const texts = store.listOutbox(50).map(item => item.text).join('\n')
    expect(texts).toContain('自动恢复失败')
  })

  it('worktree 已被删除时 PR 跟踪静默跳过，不抛错也不刷日志', async () => {
    const { ticketId } = await launchOne()
    runtime.inspectWorkspace = async () => { throw new Error('orca:command-failed(worktree show): selector_not_found') }
    await expect(service.trackPullRequests()).resolves.toBeUndefined()
    expect(store.getTicket(ticketId)?.prNumber).toBe(0)
  })

  it('resumeHint 从共享 meta 和静态运行时映射生成命令', async () => {
    const { ticketId } = await launchOne()
    const workdir = join(config.home, 'worktrees', 'ra-tk-1-demo')
    mkdirSync(workdir, { recursive: true })

    // 新 assignment 用 ACP 运行时，模拟运行时写入的 meta。
    now += 1_000
    const assignment = engine.startAssignment(ticketId, { runtimeId: 'acp-claude', handle: 'sess_1', workdir })
    mkdirSync(join(config.home, 'workers', ticketId), { recursive: true })
    writeFileSync(join(config.home, 'workers', ticketId, 'meta.json'), JSON.stringify({
      ticketId, assignmentId: assignment.id, runtime: 'acp-claude',
      handle: assignment.handle, workdir, sessionId: 'sess_1',
    }))

    expect(await service.resumeHint(ticketId)).toEqual({
      command: `cd '${workdir}' && claude '--resume' 'sess_1'`,
      sessionId: 'sess_1',
    })
  })

  it('resumeHint 在 meta 缺失、运行时不一致或运行时未收录时返回 null', async () => {
    const { ticketId } = await launchOne()
    const workdir = join(config.home, 'worktrees', 'ra-tk-1-demo')
    mkdirSync(workdir, { recursive: true })
    expect(await service.resumeHint(ticketId)).toBeNull()

    const metaPath = join(config.home, 'workers', ticketId, 'meta.json')
    mkdirSync(join(config.home, 'workers', ticketId), { recursive: true })

    // meta 是 acp-claude，但最新 assignment 仍是 orca：旧 meta 不能跨运行时使用。
    writeFileSync(metaPath, JSON.stringify({
      ticketId, runtime: 'acp-claude', handle: 'sess_1', workdir, sessionId: 'sess_1',
    }))
    expect(await service.resumeHint(ticketId)).toBeNull()

    // 新 assignment 切到 acp-claude，但 meta 写的是 orca：同样视为不一致。
    now += 1_000
    engine.startAssignment(ticketId, { runtimeId: 'acp-claude', handle: 'sess_1', workdir })
    writeFileSync(metaPath, JSON.stringify({
      ticketId, runtime: 'orca', handle: 'sess_1', workdir, sessionId: 'sess_1',
    }))
    expect(await service.resumeHint(ticketId)).toBeNull()

    // 运行时一致且 Orca 的 meta 里已有 sessionId：按 Claude 会话恢复。
    now += 1_000
    engine.startAssignment(ticketId, { runtimeId: 'orca', handle: 'term-2', workdir })
    writeFileSync(metaPath, JSON.stringify({
      ticketId, runtime: 'orca', handle: 'term-2', workdir, sessionId: 'sess_1', agent: 'claude',
    }))
    expect(await service.resumeHint(ticketId)).toEqual({
      command: `cd '${workdir}' && claude '--resume' 'sess_1'`,
      sessionId: 'sess_1',
      note: expect.stringContaining('不再由 Orca 托管'),
    })

    // meta 里没记 Agent：按选项声明的默认值（claude）解释 sessionId。
    now += 1_000
    engine.startAssignment(ticketId, { runtimeId: 'orca', handle: 'term-3', workdir })
    writeFileSync(metaPath, JSON.stringify({
      ticketId, runtime: 'orca', handle: 'term-3', workdir, sessionId: 'sess_1',
    }))
    expect(await service.resumeHint(ticketId)).toEqual({
      command: `cd '${workdir}' && claude '--resume' 'sess_1'`,
      sessionId: 'sess_1',
      note: expect.stringContaining('不再由 Orca 托管'),
    })
    expect(await service.resumeHint('tk_missing')).toBeNull()
  })

  it('resumeHint 为 Orca 工单按 workdir 补 sessionId；没有记录时退回 terminal switch', async () => {
    const { ticketId } = await launchOne()
    const workdir = join(config.home, 'worktrees', 'ra-tk-1-demo')
    mkdirSync(workdir, { recursive: true })
    const metaPath = join(config.home, 'workers', ticketId, 'meta.json')
    mkdirSync(join(config.home, 'workers', ticketId), { recursive: true })
    const assignment = store.latestAssignment(ticketId)!
    writeFileSync(metaPath, JSON.stringify({
      ticketId, runtime: 'orca', handle: assignment.handle, workdir,
    }))

    // 没有 Claude 会话记录：退回 orca terminal switch，仍给可用命令。
    expect(await service.resumeHint(ticketId)).toEqual({
      command: `orca 'terminal' 'switch' '--terminal' '${assignment.handle}'`,
      note: expect.stringContaining('Orca'),
    })

    // 写入会话记录后：按 workdir 找到最新 session，生成 claude --resume。
    const projects = join(config.home, 'claude-projects', claudeProjectSlug(workdir))
    mkdirSync(projects, { recursive: true })
    writeFileSync(join(projects, 'sess_orca.jsonl'), '{}\n')
    expect(await service.resumeHint(ticketId)).toEqual({
      command: `cd '${workdir}' && claude '--resume' 'sess_orca'`,
      sessionId: 'sess_orca',
      note: expect.stringContaining('不再由 Orca 托管'),
    })
  })

  /** 批量清理用：直接开单 + 派工，不经过 launch（避免 FakeRuntime 覆盖 workdir）。 */
  function makeTicket(suffix: string) {
    engine.ingest(trigger({ id: `t_${suffix}`, externalId: `om_${suffix}`, threadId: `feishu:oc_dev:om_${suffix}` }))
    return engine.decide({
      triggerId: `t_${suffix}`,
      decision: 'accept',
      strength: 'explicit',
      reason: 'ok',
      title: `任务 ${suffix}`,
    }).ticket!
  }

  it('批量清理：按运行时分组列出仍存在的工作区，只把已关闭工单标为可清理', () => {
    const openDir = mkdtempSync(join(tmpdir(), 'ra-ws-open-'))
    const closedDir = mkdtempSync(join(tmpdir(), 'ra-ws-closed-'))
    const goneDir = join(tmpdir(), `ra-ws-gone-${Date.now()}`)

    const open = makeTicket('open')
    engine.startAssignment(open.id, { runtimeId: 'orca', handle: 'h-open', workdir: openDir })
    const closed = makeTicket('closed')
    engine.startAssignment(closed.id, { runtimeId: 'orca', handle: 'h-closed', workdir: closedDir })
    engine.closeTicket(closed.id, 'test')
    // 已关单但目录已被回收：不应再出现在清单里。
    const gone = makeTicket('gone')
    engine.startAssignment(gone.id, { runtimeId: 'orca', handle: 'h-gone', workdir: goneDir })
    engine.closeTicket(gone.id, 'test')

    const overview = service.listWorkspaces()
    expect(overview.runtimes).toHaveLength(1)
    const group = overview.runtimes[0]!
    expect(group.runtimeId).toBe('orca')
    expect(group.label).toBe('orca')
    expect(group.supported).toBe(true)
    expect(group.entries.map(entry => entry.ticketId).sort()).toEqual([open.id, closed.id].sort())
    expect(group.entries.find(entry => entry.ticketId === closed.id)).toMatchObject({ cleanable: true })
    expect(group.entries.find(entry => entry.ticketId === open.id)).toMatchObject({ cleanable: false })
    expect(group.cleanableCount).toBe(1)
    expect(overview.cleanableCount).toBe(1)
  })

  it('批量清理：按运行时回收已关闭工单的工作区，脏目录跳过并返回原因', async () => {
    const activeDir = mkdtempSync(join(tmpdir(), 'ra-ws-active-'))
    const okDir = mkdtempSync(join(tmpdir(), 'ra-ws-ok-'))
    const dirtyDir = mkdtempSync(join(tmpdir(), 'ra-ws-dirty-'))

    const active = makeTicket('active')
    engine.startAssignment(active.id, { runtimeId: 'orca', handle: 'h-active', workdir: activeDir })
    const done = makeTicket('done')
    engine.startAssignment(done.id, { runtimeId: 'orca', handle: 'h-done', workdir: okDir })
    engine.closeTicket(done.id, 'test')
    const dirty = makeTicket('dirty')
    engine.startAssignment(dirty.id, { runtimeId: 'orca', handle: 'h-dirty', workdir: dirtyDir })
    engine.closeTicket(dirty.id, 'test')
    runtime.removeErrors.set(dirtyDir, 'git worktree remove 失败: contains modified or untracked files')

    const result = await service.cleanupWorkspaces({ runtimeId: 'orca' })
    expect(result.removed).toEqual([{ ticketId: done.id, workdir: okDir }])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]).toMatchObject({ ticketId: dirty.id, workdir: dirtyDir })
    expect(result.skipped[0]?.reason).toContain('modified')
    expect(runtime.removed).toEqual([okDir])
    // 在办工单的工作区绝不能动。
    expect(existsSync(activeDir)).toBe(true)

    // 已回收的目录不再出现；脏目录仍在清单里，等人工处理后可以再点一次。
    const after = service.listWorkspaces().runtimes[0]!
    expect(after.entries.map(entry => entry.ticketId).sort()).toEqual([active.id, dirty.id].sort())
  })

  it('批量清理：只清理勾选的工单，未勾选的不动', async () => {
    const firstDir = mkdtempSync(join(tmpdir(), 'ra-ws-first-'))
    const secondDir = mkdtempSync(join(tmpdir(), 'ra-ws-second-'))
    const keepDir = mkdtempSync(join(tmpdir(), 'ra-ws-keep-'))

    const first = makeTicket('first')
    engine.startAssignment(first.id, { runtimeId: 'orca', handle: 'h-first', workdir: firstDir })
    engine.closeTicket(first.id, 'test')
    const second = makeTicket('second')
    engine.startAssignment(second.id, { runtimeId: 'orca', handle: 'h-second', workdir: secondDir })
    engine.closeTicket(second.id, 'test')
    const keep = makeTicket('keep')
    engine.startAssignment(keep.id, { runtimeId: 'orca', handle: 'h-keep', workdir: keepDir })
    engine.closeTicket(keep.id, 'test')

    const result = await service.cleanupWorkspaces({ ticketIds: [first.id, second.id] })
    expect(result.removed.map(item => item.ticketId).sort()).toEqual([first.id, second.id].sort())
    expect(result.skipped).toEqual([])
    expect(existsSync(firstDir)).toBe(false)
    expect(existsSync(secondDir)).toBe(false)
    expect(existsSync(keepDir)).toBe(true)
  })

  it('批量清理：勾选不可清理的工单会跳过并说明原因', async () => {
    const openDir = mkdtempSync(join(tmpdir(), 'ra-ws-pick-open-'))
    const open = makeTicket('pick-open')
    engine.startAssignment(open.id, { runtimeId: 'orca', handle: 'h-pick-open', workdir: openDir })

    const result = await service.cleanupWorkspaces({ ticketIds: [open.id, 'tk-missing'] })
    expect(result.removed).toEqual([])
    expect(result.skipped).toHaveLength(2)
    expect(result.skipped.find(item => item.ticketId === open.id)?.reason).toContain('未关闭')
    expect(result.skipped.find(item => item.ticketId === 'tk-missing')?.reason).toContain('没有找到')
    expect(existsSync(openDir)).toBe(true)
  })

  it('批量清理：目录被在办工单占用时不算可清理', async () => {
    const sharedDir = mkdtempSync(join(tmpdir(), 'ra-ws-shared-'))
    const open = makeTicket('shared-open')
    engine.startAssignment(open.id, { runtimeId: 'orca', handle: 'h-shared-open', workdir: sharedDir })
    const closed = makeTicket('shared-closed')
    engine.startAssignment(closed.id, { runtimeId: 'orca', handle: 'h-shared-closed', workdir: sharedDir })
    engine.closeTicket(closed.id, 'test')

    const entry = service.listWorkspaces().runtimes[0]!.entries.find(item => item.ticketId === closed.id)!
    expect(entry.cleanable).toBe(false)
    expect(entry.reason).toContain('占用')

    const result = await service.cleanupWorkspaces({ ticketIds: [closed.id] })
    expect(result.removed).toEqual([])
    expect(result.skipped[0]?.reason).toContain('占用')
    expect(existsSync(sharedDir)).toBe(true)
  })

  it('批量清理：未知运行时或空请求直接拒绝', async () => {
    await expect(service.cleanupWorkspaces({ runtimeId: 'nope' })).rejects.toThrow(/未知的 Worker 运行时/)
    await expect(service.cleanupWorkspaces({})).rejects.toThrow(/至少勾选一个工单/)
  })

})
