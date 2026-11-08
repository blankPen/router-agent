import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store/db.js'
import { Engine } from '../src/core/engine.js'
import { RouterService, extractTerminalSnippet, extractSessionSnippet, formatProbeMessage } from '../src/service.js'
import { defaultConfig, policyOf, type AppConfig, chatEntry } from '../src/config.js'
import { DEFAULT_ADMISSION } from '../src/core/policy.js'
import type {
  WorkerBackend,
  WorkerContext,
  SessionEvent,
  WorkerRef,
  StartResult,
  DeliveryReceipt,
  AgentStatus,
  WorkspaceInfo,
} from '../src/worker/port.js'
import type { Trigger } from '../src/core/model.js'
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

class FakeBackend implements WorkerBackend {
  readonly id = 'orca'
  readonly capabilities = {
    agent: { liveStatus: true, processExit: false, output: true, activity: true, structuredInput: true, nudge: true },
    workspace: { cleanup: true, prLink: true, discovery: true },
  }
  starts: WorkerContext[] = []
  delivered: { handle: string; text: string }[] = []
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
    const handle = typeof ref === 'string' ? ref : ref.handle
    for (const input of inputs) this.delivered.push({ handle, text: input.text })
    return { status: 'accepted', inputIds: inputs.map(input => input.id) }
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
  let backend: FakeBackend
  let config: AppConfig
  let service: RouterService
  let now: number

  beforeEach(() => {
    now = Date.parse('2026-11-06T10:05:00.000Z')
    const home = mkdtempSync(join(tmpdir(), 'ra-rt-'))
    store = new Store(':memory:')
    config = { ...defaultConfig(), home }
    config.projects = [{ name: 'acme/web', repo: 'acme/web', branches: [], defaultBranch: 'main' }]
    config.policy = { acceptMode: 'auto', maxWorkers: 4, admission: { ...DEFAULT_ADMISSION } }
    config.feishu = { ...config.feishu, chats: [chatEntry('oc_dev')], allowed: ['ou_alice'] }
    let n = 0
    engine = new Engine({ store, policy: policyOf(config), clock: { now: () => new Date(now).toISOString() }, ids: { next: p => `${p}_${++n}` } })
    backend = new FakeBackend()
    service = new RouterService({
      config, store, engine, backend,
      decisionEngine: acceptEngine(),
      prTracker: new NullPrTracker(),
      clock: { now: () => new Date(now).toISOString() },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      agentLoopOptions: { batchWindowMs: 0 },
    })
  })

  async function launchOne(): Promise<{ ticketId: string; handle: string; assignmentId: string }> {
    engine.ingest(trigger())
    await service.runOnce()
    const ticket = store.listTickets()[0]!
    const assignment = store.latestAssignment(ticket.id)!
    return { ticketId: ticket.id, handle: assignment.handle, assignmentId: assignment.id }
  }

  it('有新输入时，把未 ack 的旧输入一并重投（去重靠 id）', async () => {
    const { ticketId, handle } = await launchOne()
    const first = engine.deliverInput(ticketId, { kind: 'followup', text: '第一件事' })
    await service.runOnce()
    expect(backend.delivered.map(d => d.text)).toEqual(['第一件事'])

    const second = engine.deliverInput(ticketId, { kind: 'followup', text: '第二件事' })
    await service.runOnce()
    const lastTwo = backend.delivered.slice(-2).map(d => d.text)
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
    expect(backend.delivered.slice(-1).map(d => d.text)).toEqual(['第二件事'])
  })

  it('终端长时间无输出时发 status? 唤醒，仍无响应则标记 stale 并通知', async () => {
    const { ticketId, handle, assignmentId } = await launchOne()
    service.onWorkerState({
      ticketId, assignmentId, turn: 1, state: 'progress', summary: '做到一半', prNumber: 0, prUrl: '',
      ackedInputs: [], updatedAt: new Date(now).toISOString(),
    })
    // 终端最后输出在 10 分钟前
    backend.handles.set(handle, { lastOutputAt: new Date(now - 10 * 60_000).toISOString() })

    await service.checkIdle(now)
    expect(backend.delivered.some(d => d.text.includes('status?'))).toBe(true)

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
    backend.handles.set(handle, { lastOutputAt: new Date(now - 10 * 60_000).toISOString() })
    await service.checkIdle(now)
    const before = backend.delivered.length

    service.onWorkerState({
      ticketId, assignmentId, turn: 2, state: 'progress', summary: '又动了', prNumber: 0, prUrl: '',
      ackedInputs: [], updatedAt: new Date(now + 1000).toISOString(),
    })
    await service.checkIdle(now + 2000)
    expect(backend.delivered.length).toBe(before)
  })

  it('worker 长时间不报进展时，Router 主动读终端并同步到话题', async () => {
    const { ticketId, handle } = await launchOne()
    backend.screen = ['⏺ 正在修改登录超时配置', '⎿ pnpm test 进行中', '✻ Cascading… (30s)']
    backend.handles.set(handle, { lastOutputAt: new Date(now + 10 * 60_000).toISOString() })

    await service.probeProgress(now + 11 * 60_000)

    const probe = store.listOutbox(200).find(item => item.text.includes('进展巡检'))
    expect(probe).toBeTruthy()
    expect(probe!.text).toContain('assigned')
    expect(probe!.text).toContain('正在修改登录超时配置')
    expect(probe!.text).not.toContain('pnpm test 进行中')
    expect(probe!.text).not.toContain('Cascading')
    expect(probe!.threadId).toBe('om_root')
    expect(store.getTicket(ticketId)?.stage).toBe('assigned')
  })

  it('同一静默期按 repeatMs 限流，避免重复刷屏', async () => {
    await launchOne()
    backend.screen = ['⏺ 正在跑测试']

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
    backend.screen = ['⏺ 正在补充单测', '✽ Cascading… (12s)']

    await service.probeProgress(now + 11 * 60_000)

    const probe = store.listOutbox(200).find(item => item.text.includes('进展巡检'))
    expect(probe).toBeTruthy()
    expect(probe!.text).toContain('正在补充单测')
    expect(probe!.text).toContain('review')
  })

  it('终端已退出时不发巡检消息（交给空闲巡检处理）', async () => {
    await launchOne()
    backend.readStatus = 'exited'
    backend.screen = ['⏺ 旧画面']

    await service.probeProgress(now + 11 * 60_000)
    expect(store.listOutbox(200).filter(item => item.text.includes('进展巡检'))).toHaveLength(0)
  })

  it('终端长时间没有新输出时，巡检消息会提示可能卡住', async () => {
    const { handle } = await launchOne()
    backend.screen = ['⏺ 最后一条输出']
    backend.handles.set(handle, { lastOutputAt: new Date(now - 20 * 60_000).toISOString() })

    await service.probeProgress(now + 21 * 60_000)

    const probe = store.listOutbox(200).find(item => item.text.includes('进展巡检'))
    expect(probe?.text).toContain('没有新输出')
    expect(probe?.text).toContain('可能')
  })

  it('优先使用 Agent 会话记录，不再读终端屏幕', async () => {
    await launchOne()
    backend.screen = ['⏺ 屏幕噪声']
    backend.sessionEvents = [
      { at: new Date(now + 5 * 60_000).toISOString(), kind: 'tool', text: 'Edit(service.ts)' },
      { at: new Date(now + 6 * 60_000).toISOString(), kind: 'text', text: '正在补单测' },
    ]
    backend.sessionAt = new Date(now + 6 * 60_000).toISOString()

    await service.probeProgress(now + 11 * 60_000)

    const probe = store.listOutbox(200).find(item => item.text.includes('进展巡检'))
    expect(probe?.text).toContain('Claude 会话记录')
    expect(probe?.text).toContain('正在补单测')
    expect(probe?.text).not.toContain('Edit(service.ts)')
    expect(probe?.text).not.toContain('屏幕噪声')
  })

  it('会话记录里文本之后的工具调用折叠成动作概要，不逐条回放', async () => {
    await launchOne()
    backend.sessionEvents = [
      { at: new Date(now + 5 * 60_000).toISOString(), kind: 'text', text: '开始改登录超时' },
      { at: new Date(now + 6 * 60_000).toISOString(), kind: 'tool', text: 'Edit(login.ts)', tool: { name: 'Edit', target: 'login.ts' } },
      { at: new Date(now + 7 * 60_000).toISOString(), kind: 'tool', text: 'Bash：跑测试' },
      { at: new Date(now + 8 * 60_000).toISOString(), kind: 'tool', text: 'TodoWrite' },
    ]
    backend.sessionAt = new Date(now + 8 * 60_000).toISOString()

    await service.probeProgress(now + 11 * 60_000)

    const probe = store.listOutbox(200).find(item => item.text.includes('进展巡检'))
    expect(probe?.text).toContain('开始改登录超时')
    expect(probe?.text).toContain('动作概要：修改 login.ts、执行 跑测试')
    expect(probe?.text).not.toContain('Edit(login.ts)')
    expect(probe?.text).not.toContain('TodoWrite')
  })

  it('会话记录不可用时退回终端屏幕', async () => {
    await launchOne()
    backend.sessionEvents = null
    backend.screen = ['⏺ 终端里的进展']

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
    backend.linkedPr = { linkedPR: { number: 42, url: 'https://github.com/acme/web/pull/42' } }
    await service.trackPullRequests()
    expect(store.getTicket(ticketId)?.prNumber).toBe(42)
    expect(store.getTicket(ticketId)?.prState).toBe('open')
  })

  it('重启对账：orphaned 但仍 connected 的终端按存活复用', async () => {
    const { ticketId } = await launchOne()
    const assignment = store.latestAssignment(ticketId)!
    // 模拟实测行为：CLI 创建的终端 orphaned=true，但连接正常
    backend.status = async () => ({
      alive: true,
      phase: 'running',
      acceptingInput: true,
      lastActivityAt: new Date().toISOString(),
      detail: { orphaned: true },
    })
    await service.recover()
    expect(backend.starts).toHaveLength(1)
    expect(store.latestAssignment(ticketId)!.id).toBe(assignment.id)
  })

  it('worktree 已被删除时 PR 跟踪静默跳过，不抛错也不刷日志', async () => {
    const { ticketId } = await launchOne()
    backend.inspectWorkspace = async () => { throw new Error('orca:command-failed(worktree show): selector_not_found') }
    await expect(service.trackPullRequests()).resolves.toBeUndefined()
    expect(store.getTicket(ticketId)?.prNumber).toBe(0)
  })

  it('启动时执行历史补拉，补回来的消息进入领域', async () => {
    service = new RouterService({
      config, store, engine, backend,
      decisionEngine: acceptEngine(),
      prTracker: new NullPrTracker(),
      clock: { now: () => new Date(now).toISOString() },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      backfill: async () => [{
        id: 'feishu_om_backfill', source: 'feishu', externalId: 'om_backfill',
        threadId: 'feishu:oc_dev:om_backfill', chatId: 'oc_dev', chatName: '',
        actorId: 'ou_alice', actorName: 'Alice', isBot: false, text: '历史消息：改一下超时',
        addressed: 'none', receivedAt: new Date(now - 60_000).toISOString(), disposition: 'pending',
      }],
    } as never)
    await service.start()
    service.stop()
    expect(store.listTriggers().map(t => t.externalId)).toContain('om_backfill')
  })
})
