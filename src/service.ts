import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Clock, Engine } from './core/engine.js'
import type { Assignment, Report, Stage, Ticket, Trigger } from './core/model.js'
import type { Store } from './store/db.js'
import type { AppConfig, RetentionSettings } from './config.js'
import { replyAlwaysChatsOf } from './config.js'
import type { WorkerBackend, WorkerContext, SessionEvent } from './worker/port.js'
import { AgentLoop } from './router/agent-loop.js'
import type { DecisionAudit, DecisionEngine } from './router/decision-engine.js'
import { dispatchSettingsOf } from './router/dispatch.js'
import { ReportPoller, appendEvent, judgeIdle, type WorkerMeta, type WorkerStateFile } from './worker/orca/report-poller.js'
import { OrcaCommandError, type OrcaTerminalInfo } from './worker/orca/index.js'
import { EffectsProcessor } from './core/effects.js'
import { preview } from './core/events.js'
import { shouldSendAsText } from './sources/feishu.js'
import type { CommandRunner } from './infra/process.js'
import type { GitHubTracker as GhTracker } from './sources/github.js'

export interface Logger {
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

export interface PrTracker {
  view(repo: string, number: number): Promise<{ number: number; url: string; state: 'open' | 'merged' | 'closed'; title: string; branch: string } | null>
  findByBranch(repo: string, branch: string): Promise<{ number: number; url: string; state: 'open' | 'merged' | 'closed'; title: string; branch: string } | null>
}

export interface OutboundSender {
  send(item: { channelKind: string; channelId: string; threadId: string; text: string; key: string }): Promise<void>
}

export interface RouterServiceOptions {
  config: AppConfig
  store: Store
  engine: Engine
  backend: WorkerBackend & {
    inspect?: (handle: string) => Promise<unknown | null>
    inspectWorktree?: (selector: string) => Promise<Record<string, unknown> | null>
    removeWorktree?: (selector: string) => Promise<void>
  }
  /** 唯一研判引擎（Pi）。 */
  decisionEngine: DecisionEngine
  prTracker: PrTracker
  clock?: Clock
  logger?: Logger
  poller?: { scan(): number; reset?: () => void }
  effects?: EffectsProcessor
  sender?: OutboundSender
  agentLoopOptions?: { batchWindowMs?: number }
  onDecisionAudit?: (audit: DecisionAudit) => void
  /** 终端多久没输出算空闲，默认 2 分钟。 */
  idleAfterMs?: number
  /** 唤醒后多久仍无响应算 stale，默认 5 分钟。 */
  staleAfterMs?: number
  /** 注入触发源（服务层用 FeishuConsumer 接）。 */
  onTrigger?: (trigger: Trigger) => void
  /** 启动时补拉历史消息。 */
  backfill?: () => Promise<Trigger[]>
}

const noopLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

/** 进展游标的起点标记：表示「从派工这一刻开始」，之前没有需要同步的报告。 */
const PROGRESS_FROM_START = '@start'

function progressCursorKey(ticketId: string): string {
  return `progress:${ticketId}`
}

/** 派工失败水位：持久化到 cursors，重启后仍能区分「失败前积压的旧输入」与「用户新回复」。 */
function launchFailureCursorKey(ticketId: string): string {
  return `launch-failure:${ticketId}`
}

/** 关单提醒水位：记录提醒时间与自动关闭时间，重启后仍能继续倒计时。 */
function reminderCursorKey(ticketId: string): string {
  return `retention:reminder:${ticketId}`
}

/** 主动巡检水位：记录当前静默期已经提醒过的次数与终端画面指纹，避免刷屏。 */
function probeCursorKey(ticketId: string): string {
  return `progress:probe:${ticketId}`
}

interface ProbeRecord {
  /** 本轮静默期的起点（最后一次上报 / 新输入 / 派工时间）。 */
  lastProgressAt: number
  /** 上次主动巡检消息的发送时间。 */
  lastPostAt: number
  /** 本轮静默期的提醒次数，用来生成稳定的 outbox key。 */
  count: number
  /** 终端摘录指纹；画面没变时可以明确告诉用户。 */
  snippetHash: string
}

/** PR 催办水位：同一段闲置期只催一次；有新进展后自动清空。 */
function prUrgeCursorKey(ticketId: string): string {
  return `retention:pr-urge:${ticketId}`
}

/** 僵尸水位：转人工后不再自动关闭，直到出现新的进展。 */
function zombieCursorKey(ticketId: string): string {
  return `retention:zombie:${ticketId}`
}

interface ReminderRecord {
  remindedAt: number
  closeAt: number
  /** 提醒消息的 outbox key；用来确认提醒真的发出去了再关单。 */
  outboxKey?: string
}

/** 工作区删除里不值得重试的错误：脏工作区、目录已经不存在等。 */
function isCleanupSkipError(message: string): boolean {
  return /dirty|uncommitted|modified|untracked|not clean|not found|does not exist|no such file|not a git repository/i.test(message)
}

interface LaunchFailureRecord {
  attempts: number
  /** 上次失败时工单上已存在的最大输入序号；序号不大于它的输入不再触发重试。 */
  lastSeq: number
  lastReason: string
}

/** 同一条进展（summary + reply）只保留一次，避免 worker 重复上报刷屏。 */
function dedupeProgress(reports: Report[]): Report[] {
  const seen = new Set<string>()
  return reports.filter(report => {
    const key = progressSignature([report])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function progressSignature(reports: Report[]): string {
  return reports.map(report => `${report.summary.trim()}\u0000${report.reply?.trim() ?? ''}`).join('\u0001')
}

/** 每张工单最多记住最近 50 条进展签名，避免进程内去重表无限增长。 */
function rememberProgress(seen: Set<string>, signature: string): void {
  seen.add(signature)
  if (seen.size <= 50) return
  const oldest = seen.values().next().value
  if (oldest !== undefined) seen.delete(oldest)
}

/** 把多条 progress 上报合并成一条话题消息。 */
export function formatProgressDigest(title: string, reports: Report[]): string {
  const lines: string[] = [`**工单「${title}」进展**`]
  for (const report of reports) {
    const summary = report.summary.trim()
    if (!summary) continue
    const clock = clockOf(report.at)
    lines.push('', clock ? `**${clock}** ${summary}` : `**${summary}**`)
    const reply = report.reply?.trim() ?? ''
    if (reply && reply !== summary) lines.push(reply)
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

function clockOf(at: string): string {
  const ts = Date.parse(at)
  if (!Number.isFinite(ts)) return ''
  const date = new Date(ts)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const STAGE_LABELS: Record<Stage, string> = {
  draft: '草稿',
  accepted: '已接单',
  assigned: '已派工',
  running: '执行中',
  review: '待验收',
  person: '等人处理',
  idle: '空闲',
  closed: '已关闭',
}

/** Claude Code / Codex 在渲染屏幕里的活动标记：⏺ 文本、⎿ 工具结果、✻✽ 状态行。 */
const ACTIVITY_MARKERS = /^[⏺⎿✻✽✶✳⏵◆◇●○]/

/**
 * 从 Orca 渲染屏幕里挑出最后几行「像进展」的输出。
 *
 * 不解析 TUI 语义，只做保守清洗：去掉状态栏、空 prompt、分隔线；
 * 优先取本轮 Router 输入之后的 ⏺/⎿/✻ 行，其次取屏幕尾部的自然文本。
 */
export function extractTerminalSnippet(lines: string[], opts: { maxLines?: number; maxChars?: number } = {}): string {
  const maxLines = opts.maxLines ?? 8
  const maxChars = opts.maxChars ?? 1200
  const cleaned = lines
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter(line => !/^[─━═\-—_]{8,}$/.test(line))
    .filter(line => !/^[❯›]\s*$/.test(line))
    .filter(line => !/^[⎿›].*\$\s/.test(line))
    .filter(line => !(/^[⎿›]/.test(line) && line.length > 240))
    .filter(line => !/(当前模型|bypass permissions|shift\+tab|esc to interrupt|ctrl[-+]c to|new task\?|\/clear to save|context left)/i.test(line))
    .map(line => (line.length <= 300 ? line : `${line.slice(0, 300)}…`))

  const inputAt = lastIndexWhere(cleaned, line => /^[❯›]\s*【Router 输入/.test(line))
  const afterInput = inputAt >= 0 ? cleaned.slice(inputAt + 1) : cleaned
  const afterInputMarkers = afterInput.filter(line => ACTIVITY_MARKERS.test(line))
  if (afterInputMarkers.length > 0) return joinSnippet(afterInputMarkers.slice(-maxLines), maxChars)

  const markers = cleaned.filter(line => ACTIVITY_MARKERS.test(line))
  if (markers.length >= 2) return joinSnippet(markers.slice(-maxLines), maxChars)

  // 没有活动标记（普通 shell / 已结束的会话）：取输入回显之前的屏幕尾部。
  const fallback = inputAt >= 0 ? cleaned.slice(0, inputAt) : cleaned
  return joinSnippet(fallback.slice(-maxLines), maxChars)
}

/** 终端摘录指纹：只用来判断「画面有没有变化」，不做安全用途。 */
export function snippetFingerprint(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0
  return hash.toString(16)
}

/**
 * 从 Agent 的会话记录里挑出最近几条活动。
 * 比终端屏幕干净：只有 assistant 文本与工具调用，没有状态栏和输入回显。
 */
export function extractSessionSnippet(events: SessionEvent[], opts: { maxLines?: number; maxChars?: number } = {}): string {
  const maxLines = opts.maxLines ?? 8
  const maxChars = opts.maxChars ?? 1200
  // 连续重复的同一动作（例如连续三次 Edit(README.md)）压成一条，节省摘录空间。
  const collapsed: Array<SessionEvent & { count: number }> = []
  for (const event of events) {
    const last = collapsed.at(-1)
    if (last && last.kind === event.kind && last.text === event.text) {
      last.count += 1
      last.at = event.at
    } else {
      collapsed.push({ ...event, count: 1 })
    }
  }
  const lines = collapsed.slice(-maxLines).map(event => {
    const time = clockOf(event.at)
    const body = event.text.replace(/\s+/g, ' ').trim()
    const truncated = body.length <= 240 ? body : `${body.slice(0, 240)}…`
    return `${time ? `[${time}] ` : ''}${event.kind === 'text' ? '助手' : '动作'}：${truncated}${event.count > 1 ? ` ×${event.count}` : ''}`
  })
  return joinSnippet(lines, maxChars)
}

/** 主动巡检消息：全部是确定性文本，不额外调用模型。 */
export function formatProbeMessage(ticket: Ticket, info: {
  nowMs: number
  lastProgress: number
  snippet: string
  unchanged: boolean
  lastActivityAt: number
  lastOutputAt: number
  source: 'session' | 'terminal'
  silenceMs: number
}): string {
  const minutes = Math.max(0, Math.round((info.nowMs - info.lastProgress) / 60_000))
  const activeStage = ticket.stage === 'assigned' || ticket.stage === 'running'
  const sourceLabel = info.source === 'session' ? 'Claude 会话记录' : '终端屏幕'
  const lines = [
    `**工单「${ticket.title}」进展巡检（${ticket.id}）**`,
    '',
    `- 当前阶段：${ticket.stage}（${STAGE_LABELS[ticket.stage]}）${activeStage ? '' : '；已有新输入，worker 应已重新开工'}`,
    `- 距上次上报 / 新输入：${minutes} 分钟`,
  ]
  if (info.source === 'session' && Number.isFinite(info.lastActivityAt)) {
    lines.push(`- 最近活动：${minutesAgo(info.nowMs, info.lastActivityAt)} 分钟前（${sourceLabel}）`)
  }
  if (Number.isFinite(info.lastOutputAt)) {
    const outputMinutes = minutesAgo(info.nowMs, info.lastOutputAt)
    lines.push(`- 终端最后一次输出：${outputMinutes} 分钟前`)
    if (outputMinutes * 60_000 >= info.silenceMs) {
      lines.push(`- ⚠️ 终端已经 ${outputMinutes} 分钟没有新输出，可能在等待输入或卡住，建议到 Orca 终端确认。`)
    }
  } else if (Number.isFinite(info.lastActivityAt)) {
    const activityMinutes = minutesAgo(info.nowMs, info.lastActivityAt)
    if (activityMinutes * 60_000 >= info.silenceMs) {
      lines.push(`- ⚠️ 已经 ${activityMinutes} 分钟没有新活动，可能卡住，建议到 Orca 终端确认。`)
    }
  }
  lines.push('', `**最新进展（${sourceLabel}摘录）**`, '```text', (info.snippet || '(没有可读输出)').replace(/```/g, "'''"), '```')
  if (info.unchanged) lines.push('', '与上次巡检相比，终端画面没有变化。')
  lines.push('', '这是 Router 的主动巡检，不需要回复。')
  return lines.join('\n')
}

function minutesAgo(nowMs: number, at: number): number {
  return Math.max(0, Math.round((nowMs - at) / 60_000))
}

function joinSnippet(lines: string[], maxChars: number): string {
  const text = lines.join('\n').trim()
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`
}

function lastIndexWhere(items: string[], predicate: (item: string) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) if (predicate(items[i]!)) return i
  return -1
}

/**
 * 服务编排：把 AgentLoop、上报轮询、Effects、PR 跟踪与 WorkerBackend 接在一起。
 * 本身不持有终端状态；重启后靠 recover() 与 Orca 对账。
 */
export class RouterService {
  readonly store: Store
  readonly engine: Engine
  readonly loop: AgentLoop
  readonly config: AppConfig
  private backend: WorkerBackend & {
    inspect?: (handle: string) => Promise<unknown | null>
    inspectWorktree?: (selector: string) => Promise<Record<string, unknown> | null>
    removeWorktree?: (selector: string) => Promise<void>
  }
  private clock: Clock
  private logger: Logger
  private poller: { scan(): number; reset?: () => void }
  private effects: EffectsProcessor
  private prTracker: PrTracker
  private sender: OutboundSender
  private timers: NodeJS.Timeout[] = []
  private running = false
  private idleAfterMs: number
  private staleAfterMs: number
  private idle = new Map<string, { turn: number; nudgedAt: number | null; stale: boolean }>()
  private ticking = false
  private backfill?: () => Promise<Trigger[]>
  /** 派工失败记录：用于限制「旧输入」反复触发重试，并累计尝试次数。内存缓存 + cursors 持久化。 */
  private launchFailures = new Map<string, LaunchFailureRecord>()
  /** 排队状态的去重签名，避免每秒刷同一条排队日志。 */
  private queueSignature = ''
  /** 已经发过排队通知的工单，避免刷屏。 */
  private queueNotified = new Set<string>()
  /** 工单进展合并同步的轮询间隔；0 表示关闭。 */
  private progressSyncMs: number
  /** 主动巡检间隔：读 worker 终端并同步进展；0 表示关闭。 */
  private progressProbeMs: number
  /** 多久没有新上报 / 新输入才算静默。 */
  private progressSilenceMs: number
  /** 同一静默期内重复提醒的最小间隔。 */
  private progressRepeatMs: number
  /** 防止上一轮巡检还没结束、下一轮又进来。 */
  private probing = false
  /** 每张工单已经同步过的进展签名（有界），用于内容去重。 */
  private progressSeen = new Map<string, Set<string>>()
  /** 闲置治理阈值；配置缺失时关闭，避免旧测试或嵌入用法被意外清理。 */
  private retention: RetentionSettings
  /** 防止上一轮扫描还没结束、下一轮又进来。 */
  private retentionSweeping = false

  constructor(opts: RouterServiceOptions) {
    this.store = opts.store
    this.engine = opts.engine
    this.config = opts.config
    this.backend = opts.backend
    this.clock = opts.clock ?? { now: () => new Date().toISOString() }
    this.logger = opts.logger ?? noopLogger
    this.prTracker = opts.prTracker
    this.idleAfterMs = opts.idleAfterMs ?? 120_000
    this.staleAfterMs = opts.staleAfterMs ?? 300_000
    this.progressSyncMs = opts.config.progress?.syncMs ?? 60_000
    this.progressProbeMs = opts.config.progress?.probeMs ?? 120_000
    this.progressSilenceMs = opts.config.progress?.silenceMs ?? 600_000
    this.progressRepeatMs = opts.config.progress?.repeatMs ?? 900_000
    this.retention = opts.config.retention ?? {
      enabled: false,
      idleHours: 24,
      closeGraceHours: 6,
      zombieHours: 6,
      sweepMinutes: 5,
    }
    this.backfill = opts.backfill
    this.loop = new AgentLoop({
      engine: opts.engine,
      decisionEngine: opts.decisionEngine,
      clock: this.clock,
      batchWindowMs: opts.agentLoopOptions?.batchWindowMs ?? 8000,
      dispatch: dispatchSettingsOf(opts.config),
      replyAlwaysChats: replyAlwaysChatsOf(opts.config),
      ...(opts.onDecisionAudit ? { onAudit: opts.onDecisionAudit } : {}),
    })
    this.poller = opts.poller ?? new ReportPoller({
      workersDir: join(opts.config.home, 'workers'),
      onState: (state, meta) => this.onWorkerState(state, meta ?? undefined),
      onError: (ticketId, error) => this.logger.error('report:invalid', { ticketId, message: error.message }),
    })
    this.sender = opts.sender ?? { send: async () => {} }
    this.effects = opts.effects ?? new EffectsProcessor({
      store: opts.store,
      sender: this.sender,
      clock: this.clock,
    })
    this.bindEffects(this.effects)
  }

  /** 把停止、派工与结果投递能力接到 EffectsProcessor 上（内部与 CLI 共用）。 */
  bindEffects(effects: EffectsProcessor): void {
    effects.register('stop-worker', async payload => {
      const ticketId = String(payload.ticketId ?? '')
      const assignment = this.store.latestAssignment(ticketId)
      if (!assignment?.handle) return
      await this.backend.stop(assignment.handle, 'ticket-stopped')
      this.log('worker:stopped', ticketId, { handle: assignment.handle })
    })
    effects.register('launch-worker', async payload => {
      const ticket = this.store.getTicket(String(payload.ticketId ?? ''))
      if (!ticket || ticket.stage === 'closed') return
      await this.launch(ticket)
    })
    effects.register('cleanup-workspace', async (payload, item) => {
      await this.cleanupWorkspace(String(payload.ticketId ?? ''), item.attempts)
    })
  }

  /** 一个完整周期：研判 → 上报 → Effects → 派工 → 投递。周期之间串行，避免重叠。 */
  async runOnce(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.runCycle()
    } finally {
      this.ticking = false
    }
  }

  private async runCycle(): Promise<void> {
    await this.loop.tick()
    this.poller.scan()
    await this.effects.tick()
    await this.launchPending()
    await this.deliverPendingInputs()
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    await this.recover()
    if (this.backfill) {
      try {
        const triggers = await this.backfill()
        for (const trigger of triggers) this.engine.ingest(trigger)
        if (triggers.length > 0) this.logger.info('backfill:done', { count: triggers.length })
      } catch (error) {
        this.logger.warn('backfill:failed', { message: error instanceof Error ? error.message : String(error) })
      }
    }
    const every = (ms: number, fn: () => Promise<void> | void): void => {
      const timer = setInterval(() => {
        Promise.resolve(fn()).catch(error => this.logger.error('loop:error', { message: error instanceof Error ? error.message : String(error) }))
      }, ms)
      timer.unref?.()
      this.timers.push(timer)
    }
    every(1000, () => this.runOnce())
    every(5000, () => this.trackPullRequests())
    every(15_000, () => this.checkIdle())
    if (this.progressSyncMs > 0) every(this.progressSyncMs, () => this.syncProgress())
    if (this.progressProbeMs > 0) every(this.progressProbeMs, () => this.probeProgress())
    if (this.retention.enabled) every(this.retention.sweepMinutes * 60_000, () => this.sweepRetention())
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    this.running = false
  }

  // ---------- 派工 ----------

  /** 把所有 accepted 阶段、且还有并发额度的工单派出去。 */
  async launchPending(): Promise<Ticket[]> {
    const launched: Ticket[] = []
    const open = this.store.listOpenTickets()
    let capacity = this.config.policy.maxWorkers - this.activeWorkers()
    if (capacity <= 0) {
      this.reportQueue(capacity)
      return launched
    }
    for (const ticket of open) {
      if (capacity <= 0) break
      if (ticket.stage !== 'accepted') continue
      const latest = this.store.latestAssignment(ticket.id)
      if (latest && latest.status !== 'ended') continue
      try {
        await this.launch(ticket)
        launched.push(ticket)
        capacity -= 1
      } catch {
        // launch() 内部已记录详细原因、转人工并通知发起人，这里不再重复。
      }
    }
    this.reportQueue(capacity)
    return launched
  }

  /**
   * 并发已满时不能静默跳过：记录排队日志，并给首次排队的工单发一次提示。
   * 用签名去重，避免每秒重复写日志与发消息。
   */
  private reportQueue(capacity: number): void {
    // 重新查库：调用方手里的快照可能是派工前的，会把已派出的工单误报成排队。
    const waiting = this.store.listOpenTickets().filter(ticket => ticket.stage === 'accepted')
    if (waiting.length === 0) {
      this.queueSignature = ''
      return
    }
    const signature = `${Math.max(capacity, 0)}:${waiting.map(ticket => ticket.id).join(',')}`
    if (signature === this.queueSignature) return
    this.queueSignature = signature
    this.logger.info('launch:queued', {
      maxWorkers: this.config.policy.maxWorkers,
      capacity: Math.max(capacity, 0),
      waiting: waiting.length,
      ticketIds: waiting.slice(0, 10).map(ticket => ticket.id),
    })
    if (capacity > 0) return
    for (const ticket of waiting) {
      if (this.queueNotified.has(ticket.id)) continue
      this.queueNotified.add(ticket.id)
      this.notify(
        ticket,
        `当前执行并发已满（${this.config.policy.maxWorkers} 个），工单「${ticket.title}」已排队，有空闲后会自动开始。`,
        `queued:${ticket.id}`,
      )
    }
  }

  private async launch(ticket: Ticket): Promise<Assignment> {
    const assignment = this.engine.startAssignment(ticket.id, {
      backendId: this.backend.id,
      handle: '',
      workdir: '',
    })
    // 进展同步从派工这一刻起算：首次派工用起点标记，重启重派则沿用/回落到最新报告。
    if (this.store.getCursor(progressCursorKey(ticket.id)) === null) {
      const latest = this.store.latestReport(ticket.id)
      this.store.setCursor(progressCursorKey(ticket.id), latest?.id ?? PROGRESS_FROM_START, this.clock.now())
    }
    const ctx: WorkerContext = { ticket, assignment, workdir: '' }
    try {
      const { handle, workdir } = await this.backend.start(ctx)
      const updated: Assignment = { ...assignment, handle, workdir: workdir ?? '' }
      this.store.updateAssignment(updated)
      this.engine.refreshStage(ticket.id)
      this.clearLaunchFailure(ticket.id)
      this.queueNotified.delete(ticket.id)
      this.log('launch', ticket.id, { handle, workdir })
      return updated
    } catch (error) {
      this.store.updateAssignment({ ...assignment, status: 'ended', endedAt: this.clock.now() })
      this.reportLaunchFailure(ticket, error)
      throw error
    }
  }

  /**
   * 派工失败统一收口：完整日志 + 转人工（释放并发额度）+ 飞书话题反馈。
   * 此前只把 assignment 标记 ended，工单会永远停在 assigned：既不再重试，又一直占着 maxWorkers。
   */
  private reportLaunchFailure(ticket: Ticket, error: unknown): void {
    const failure = describeLaunchError(error)
    const previous = this.loadLaunchFailure(ticket.id)
    const attempts = (previous?.attempts ?? 0) + 1
    const lastSeq = this.store.pendingInputs(ticket.id).reduce((max, input) => Math.max(max, input.seq), 0)
    this.saveLaunchFailure(ticket.id, { attempts, lastSeq, lastReason: failure.reason })

    const hint = `请确认项目「${ticket.repo}」与起始分支「${ticket.branch}」存在；修正后在本话题回复任意内容即可重试`
    this.engine.setAttention(ticket.id, `执行环境创建失败：${failure.reason}`)
    this.appendEventLog(ticket.id, { kind: 'launch-failure', attempt: attempts, reason: failure.reason, at: this.clock.now() })

    this.logger.error('launch:failed', {
      ticketId: ticket.id,
      title: ticket.title,
      repo: ticket.repo,
      branch: ticket.branch,
      attempt: attempts,
      reason: failure.reason,
      ...(failure.cause ? { cause: failure.cause } : {}),
      ...(failure.operationId ? { operationId: failure.operationId } : {}),
      ...(failure.code !== undefined ? { exitCode: failure.code } : {}),
      ...(failure.orcaCode ? { orcaCode: failure.orcaCode } : {}),
      ...(failure.args ? { args: failure.args } : {}),
      ...(failure.stdout ? { stdout: failure.stdout } : {}),
      ...(failure.stderr ? { stderr: failure.stderr } : {}),
      hint,
    })

    this.notify(
      ticket,
      [
        `工单「${ticket.title}」的执行环境创建失败，已暂停执行并转人工。`,
        '',
        `失败原因：${failure.reason}`,
        ...(failure.cause ? [`底层原因：${failure.cause}`] : []),
        ...(failure.orcaCode ? [`错误码：${failure.orcaCode}`] : []),
        `项目：${ticket.repo}　起始分支：${ticket.branch}`,
        `已尝试次数：${attempts}`,
        '',
        `${hint}。`,
      ].join('\n'),
      `launch-failed:${ticket.id}:${reasonKey(failure.reason)}`,
    )
  }

  /** 读取失败水位：内存缓存优先；进程重启后从 cursors 恢复，避免旧输入被当成新回复重试。 */
  private loadLaunchFailure(ticketId: string): LaunchFailureRecord | undefined {
    const cached = this.launchFailures.get(ticketId)
    if (cached) return cached
    const raw = this.store.getCursor(launchFailureCursorKey(ticketId))
    if (!raw) return undefined
    try {
      const parsed = JSON.parse(raw) as Partial<LaunchFailureRecord>
      if (typeof parsed.attempts !== 'number' || typeof parsed.lastSeq !== 'number') return undefined
      const record: LaunchFailureRecord = {
        attempts: parsed.attempts,
        lastSeq: parsed.lastSeq,
        lastReason: typeof parsed.lastReason === 'string' ? parsed.lastReason : '',
      }
      this.launchFailures.set(ticketId, record)
      return record
    } catch {
      return undefined
    }
  }

  private saveLaunchFailure(ticketId: string, record: LaunchFailureRecord): void {
    this.launchFailures.set(ticketId, record)
    this.store.setCursor(launchFailureCursorKey(ticketId), JSON.stringify(record), this.clock.now())
  }

  private clearLaunchFailure(ticketId: string): void {
    this.launchFailures.delete(ticketId)
    this.store.deleteCursor(launchFailureCursorKey(ticketId))
  }

  private activeWorkers(): number {
    return this.store.listOpenTickets().filter(t => t.stage === 'assigned' || t.stage === 'running').length
  }

  async deliverPendingInputs(): Promise<void> {
    for (const ticket of this.store.listOpenTickets()) {
      if (ticket.stage === 'closed') continue
      const assignment = this.store.latestAssignment(ticket.id)
      const pending = this.store.pendingInputs(ticket.id)
      if (pending.length === 0) continue
      // 没有活着的 worker：新输入视为「重试派工」信号。
      // 派工失败后工单会转人工，用户在该话题里回复即可重新拉起 worker。
      if (!assignment || assignment.status === 'ended' || !assignment.handle) {
        await this.relaunchForInput(ticket, pending)
        continue
      }
      // 下次唤醒时把上次已投递但没 ack 的输入一并重发，靠 id 去重。
      const unacked = this.store.unackedInputs(ticket.id)
      const batch = [...unacked, ...pending]
      try {
        // 用 input.id（而不是 assignmentId:seq）作为投递 id：worker 会原样写进 acked_inputs。
        await this.backend.deliver(assignment.handle, batch.map(input => ({ id: input.id, kind: input.kind, text: input.text })))
        this.store.markInputsDelivered(ticket.id, this.clock.now())
        this.log('input:delivered', ticket.id, {
          count: batch.length,
          redelivered: unacked.length,
          text: preview(batch.map(item => item.text).join(' / ')),
        })
      } catch (error) {
        // 终端被删掉时 send 会一直失败；先确认会话是否还在，别每秒重试。
        if (await this.workerGone(assignment.handle)) {
          this.handleLostWorker(ticket, 'input-deliver-failed')
          continue
        }
        this.logger.warn('input:deliver-failed', { ticketId: ticket.id, message: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  /**
   * 旧 worker 已结束、但有新输入时重新派工。
   * 只对「上次失败之后新到的输入」触发，避免同一批积压输入每秒重试打爆 Orca。
   */
  private async relaunchForInput(ticket: Ticket, pending: { seq: number }[]): Promise<void> {
    const failure = this.loadLaunchFailure(ticket.id)
    if (failure && !pending.some(input => input.seq > failure.lastSeq)) return
    if (this.activeWorkers() >= this.config.policy.maxWorkers) {
      this.logger.info('launch:queued-input', {
        ticketId: ticket.id,
        pending: pending.length,
        maxWorkers: this.config.policy.maxWorkers,
      })
      return
    }
    this.engine.clearAttention(ticket.id)
    try {
      await this.launch(ticket)
      this.log('input:relaunch', ticket.id, { pending: pending.length })
    } catch {
      // launch() 内部已记录原因、转人工并通知发起人。
    }
  }

  // ---------- 空闲与失联 ----------

  /**
   * 用 Orca 的结构化字段判断 worker 是否空闲：
   * 长时间无输出 → 主动发 `status?` 唤醒；仍然无响应 → 标 stale 并通知人。
   */
  async checkIdle(nowMs: number = Date.parse(this.clock.now())): Promise<void> {
    if (!this.backend.inspect) return
    for (const ticket of this.store.listOpenTickets()) {
      if (ticket.stage !== 'running' && ticket.stage !== 'assigned') continue
      const assignment = this.store.latestAssignment(ticket.id)
      if (!assignment?.handle || assignment.status === 'ended') continue
      let info: OrcaTerminalInfo | null
      try {
        info = (await this.backend.inspect(assignment.handle)) as OrcaTerminalInfo | null
      } catch {
        // Orca 暂时不可用，下一轮再看。
        continue
      }
      if (!info || !info.connected) {
        this.handleLostWorker(ticket, 'inspect-dead')
        continue
      }
      const turn = this.store.latestReport(ticket.id)?.turn ?? 0
      const state = this.idle.get(ticket.id)
      if (!state) {
        this.idle.set(ticket.id, { turn, nudgedAt: null, stale: false })
      } else if (state.turn !== turn) {
        this.idle.set(ticket.id, { turn, nudgedAt: null, stale: false })
        continue
      }
      const current = this.idle.get(ticket.id)!
      const verdict = judgeIdle({ info, turn, lastTurn: turn, now: nowMs, idleAfterMs: this.idleAfterMs })
      if (verdict !== 'idle') continue

      if (!current.nudgedAt) {
        await this.backend.deliver(assignment.handle, [{ id: `${assignment.id}:status-check`, kind: 'retry', text: 'status?' }])
        current.nudgedAt = nowMs
        this.log('idle:nudge', ticket.id, { handle: assignment.handle })
        continue
      }

      if (!current.stale && nowMs - current.nudgedAt > this.staleAfterMs) {
        current.stale = true
        // 标记为僵尸：闲置治理只转人工，不再提醒关单、不自动关闭。
        this.store.setCursor(zombieCursorKey(ticket.id), String(nowMs), this.clock.now())
        this.engine.setAttention(ticket.id, 'worker 无响应：长时间没有新的 state.json 上报，已标记 stale，请人工确认')
        this.notify(ticket, `工单「${ticket.title}」的 worker 无响应，已标记 stale，请到 Orca 终端确认。`, `stale:${ticket.id}`)
        this.log('idle:stale', ticket.id, {})
      }
    }
  }

  // ---------- 闲置工单治理 ----------

  /**
   * 定时扫描闲置工单，按用户确认的策略执行：
   * - 执行中但 6 小时无上报/终端输出：转人工，不关闭；
   * - 24 小时没有任何新进展：先发一次关单提醒，6 小时没回复自动关闭并回收 workspace；
   * - PR 仍开着：只催办一次，不关闭。
   *
   * 公开方法便于测试与手工补跑；生产环境由 `start()` 里的定时器驱动。
   */
  async sweepRetention(nowMs: number = Date.parse(this.clock.now())): Promise<void> {
    if (!this.retention.enabled || this.retentionSweeping) return
    this.retentionSweeping = true
    try {
      for (const ticket of this.store.listOpenTickets()) {
        try {
          await this.checkRetention(ticket, nowMs)
        } catch (error) {
          this.logger.warn('retention:sweep-failed', {
            ticketId: ticket.id,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } finally {
      this.retentionSweeping = false
    }
  }

  private async checkRetention(ticket: Ticket, nowMs: number): Promise<void> {
    // 草稿还没进入派工流程，不参与闲置治理。
    if (ticket.stage === 'draft') return
    const idleMs = this.retention.idleHours * 3_600_000
    const graceMs = this.retention.closeGraceHours * 3_600_000
    const zombieMs = this.retention.zombieHours * 3_600_000
    const lastProgress = this.lastProgressAt(ticket)

    // 1) 僵尸进程：先转人工，明确不自动关闭。
    if ((ticket.stage === 'assigned' || ticket.stage === 'running') && (await this.isZombie(ticket, nowMs, zombieMs))) {
      this.markZombie(ticket)
      return
    }

    // 提醒/催办之后又有了新进展：清掉水位，这一轮不重复打扰。
    if (this.clearRetentionMarksOnProgress(ticket, lastProgress)) return

    // 3) 已经转过人工的僵尸工单：不再提醒、不再自动关闭，直到出现新的进展。
    if (this.store.getCursor(zombieCursorKey(ticket.id)) !== null) return

    if (nowMs - lastProgress < idleMs) return

    // 2) PR 还开着：只催办一次，不关闭。
    if (ticket.prState === 'open') {
      this.urgeOpenPullRequest(ticket)
      return
    }

    // 4) 24 小时无进展：提醒 → 6 小时宽限 → 自动关闭。
    const reminder = this.readReminder(ticket.id)
    if (!reminder) {
      this.sendCloseReminder(ticket, nowMs, graceMs)
      return
    }
    if (nowMs < reminder.closeAt) return
    // 提醒还没真正发出去（飞书不可用 / 正在重试）时不要关单，否则用户没看到提醒就被关了。
    if (reminder.outboxKey) {
      const status = this.store.getOutboxStatus(reminder.outboxKey)
      if (status === null) {
        // 提醒消息丢了：清掉水位，下一轮重新提醒。
        this.store.deleteCursor(reminderCursorKey(ticket.id))
        return
      }
      if (status !== 'sent') return
    }
    this.closeIdleTicket(ticket)
  }

  /**
   * 最后一次「有进展」的时间：worker 上报、用户输入、派工启动。
   * 不取 `tickets.updated_at`——PR 轮询会每 5 秒刷新它，会把闲置时钟永远顶住。
   */
  private lastProgressAt(ticket: Ticket): number {
    const inputs = this.store.listInputs(ticket.id)
    const candidates = [
      Date.parse(ticket.createdAt),
      Date.parse(this.store.latestReport(ticket.id)?.at ?? ''),
      Date.parse(inputs.at(-1)?.createdAt ?? ''),
      Date.parse(this.store.latestAssignment(ticket.id)?.startedAt ?? ''),
    ].filter(Number.isFinite)
    return candidates.length > 0 ? Math.max(...candidates) : 0
  }

  /** 显示在执行、但长时间没有上报且终端无输出/已失联。 */
  private async isZombie(ticket: Ticket, nowMs: number, zombieMs: number): Promise<boolean> {
    const assignment = this.store.latestAssignment(ticket.id)
    if (!assignment || assignment.status === 'ended') return false
    if (nowMs - this.lastProgressAt(ticket) < zombieMs) return false
    if (!assignment.handle || !this.backend.inspect) return true
    try {
      const info = (await this.backend.inspect(assignment.handle)) as OrcaTerminalInfo | null
      if (!info || !info.connected) return true
      const outputAt = Date.parse(info.lastOutputAt)
      // 终端还活着但拿不到输出时间：不误判成僵尸。
      if (!Number.isFinite(outputAt)) return false
      return nowMs - outputAt >= zombieMs
    } catch {
      // Orca 暂时不可用：保持现状，下一轮再看。
      return false
    }
  }

  private markZombie(ticket: Ticket): void {
    const key = zombieCursorKey(ticket.id)
    if (this.store.getCursor(key) !== null) return
    const now = this.clock.now()
    const assignment = this.store.latestAssignment(ticket.id)
    const lastProgress = this.lastProgressAt(ticket)
    this.engine.setAttention(ticket.id, `worker 已 ${this.retention.zombieHours} 小时没有上报，终端也没有响应`)
    this.notify(
      ticket,
      `工单「${ticket.title}」的 worker 已 ${this.retention.zombieHours} 小时没有上报，终端也没有响应，已转人工处理（不会自动关闭）。请到 Orca 终端确认，或在本话题回复任意内容以重新派工。`,
      // key 用「最后进展时间」：同一段闲置期重跑只会发一次，出现新进展后才允许再提醒。
      `retention:zombie:${ticket.id}:${lastProgress}`,
    )
    this.store.setCursor(key, String(Date.parse(now)), now)
    this.log('retention:zombie', ticket.id, { handle: assignment?.handle ?? '' })
  }

  /** 有新的进展就清掉提醒/催办/僵尸水位，让下一段闲置期可以重新计时。 */
  private clearRetentionMarksOnProgress(ticket: Ticket, lastProgress: number): boolean {
    let cleared = false
    const reminder = this.readReminder(ticket.id)
    if (reminder && lastProgress > reminder.remindedAt) {
      this.store.deleteCursor(reminderCursorKey(ticket.id))
      cleared = true
    }
    const urgeAt = Number(this.store.getCursor(prUrgeCursorKey(ticket.id)) ?? '')
    if (Number.isFinite(urgeAt) && urgeAt > 0 && lastProgress > urgeAt) {
      this.store.deleteCursor(prUrgeCursorKey(ticket.id))
      cleared = true
    }
    const zombieAt = Number(this.store.getCursor(zombieCursorKey(ticket.id)) ?? '')
    if (Number.isFinite(zombieAt) && zombieAt > 0 && lastProgress > zombieAt) {
      this.store.deleteCursor(zombieCursorKey(ticket.id))
      cleared = true
    }
    return cleared
  }

  private readReminder(ticketId: string): ReminderRecord | null {
    const raw = this.store.getCursor(reminderCursorKey(ticketId))
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Partial<ReminderRecord>
      if (typeof parsed.remindedAt !== 'number' || typeof parsed.closeAt !== 'number') return null
      return {
        remindedAt: parsed.remindedAt,
        closeAt: parsed.closeAt,
        ...(typeof parsed.outboxKey === 'string' ? { outboxKey: parsed.outboxKey } : {}),
      }
    } catch {
      return null
    }
  }

  private sendCloseReminder(ticket: Ticket, nowMs: number, graceMs: number): void {
    const closeAt = nowMs + graceMs
    const attention = this.store.getAttention(ticket.id)
    const lines = [
      `工单「${ticket.title}」（${ticket.id}）已经 ${this.retention.idleHours} 小时没有新的进展。`,
      ...(attention ? ['', `当前在等你确认：${attention.question}`] : []),
      '',
      `如果还需要继续，请直接在本话题回复任意内容；否则 ${this.retention.closeGraceHours} 小时后将自动关闭，并回收对应的 workspace。`,
    ]
    // 先发通知再落水位：即使进程在两者之间崩溃，重复通知也会被 outbox key 去重；
    // 反过来则可能只落了关闭时间、却没提醒到人。key 用最后进展时间，下一段闲置期可以再次提醒。
    const lastProgress = this.lastProgressAt(ticket)
    const outboxKey = `retention:reminder:${ticket.id}:${lastProgress}`
    this.notify(ticket, lines.join('\n'), outboxKey)
    this.store.setCursor(
      reminderCursorKey(ticket.id),
      JSON.stringify({ remindedAt: nowMs, closeAt, outboxKey }),
      this.clock.now(),
    )
    this.log('retention:reminded', ticket.id, { closeAt: new Date(closeAt).toISOString() })
  }

  private urgeOpenPullRequest(ticket: Ticket): void {
    if (this.store.getCursor(prUrgeCursorKey(ticket.id)) !== null) return
    const now = this.clock.now()
    const lastProgress = this.lastProgressAt(ticket)
    this.notify(
      ticket,
      `工单「${ticket.title}」的 PR 已经 ${this.retention.idleHours} 小时没有新进展：${ticket.prUrl || '(PR 链接缺失)'}\n请确认是否需要继续推进；这张工单会保留，不会自动关闭。`,
      `retention:pr-urge:${ticket.id}:${lastProgress}`,
    )
    this.store.setCursor(prUrgeCursorKey(ticket.id), String(Date.parse(now)), now)
    this.log('retention:pr-urge', ticket.id, { pr: ticket.prNumber })
  }

  private closeIdleTicket(ticket: Ticket): void {
    let closed: Ticket
    try {
      closed = this.engine.closeTicket(ticket.id, `idle:${this.retention.idleHours}h`)
    } catch (error) {
      // PR 在扫描与关闭之间被重新打开：保留工单，下一轮按 PR 催办处理。
      if (error instanceof Error && error.message === 'pr:open') return
      throw error
    }
    this.store.deleteCursor(reminderCursorKey(ticket.id))
    this.enqueueWorkspaceCleanup(closed)
    this.notify(
      closed,
      `工单「${closed.title}」已 ${this.retention.idleHours} 小时无进展且 ${this.retention.closeGraceHours} 小时未回复，已自动关闭，正在回收对应的 workspace。`,
      `retention:closed:${closed.id}`,
    )
    this.log('retention:closed', closed.id, { reason: 'idle' })
  }

  private enqueueWorkspaceCleanup(ticket: Ticket): void {
    const suffix = ticket.closedAt ?? this.clock.now()
    this.store.enqueueEffect({
      id: `ef_cleanup_${ticket.id}_${suffix.replace(/[^0-9a-zA-Z]/g, '')}`,
      key: `cleanup-workspace:${ticket.id}:${suffix}`,
      kind: 'cleanup-workspace',
      payload: { ticketId: ticket.id },
      now: this.clock.now(),
    })
  }

  /**
   * 关闭后的 workspace 回收：先关终端，再删 worktree。
   * 不强制删除脏工作区；不可重试的失败只记录一次，避免 Effects 无限重试。
   */
  private async cleanupWorkspace(ticketId: string, attempts: number): Promise<void> {
    if (!ticketId) return
    const ticket = this.store.getTicket(ticketId)
    const assignment = this.store.latestAssignment(ticketId)
    if (!assignment) return
    if (assignment.handle) {
      try {
        await this.backend.stop(assignment.handle, 'workspace-cleanup')
      } catch (error) {
        this.logger.warn('cleanup:stop-failed', {
          ticketId,
          handle: assignment.handle,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (!assignment.workdir) return
    if (!this.backend.removeWorktree) {
      this.log('cleanup:no-remove-capability', ticketId, { workdir: assignment.workdir })
      return
    }
    try {
      // 不带 --force：脏工作区交给 Orca 拒绝，避免误删未提交改动。
      await this.backend.removeWorktree(`path:${assignment.workdir}`)
      this.log('cleanup:worktree-removed', ticketId, { workdir: assignment.workdir })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isCleanupSkipError(message) || attempts >= 3) {
        this.logger.warn('cleanup:worktree-skipped', { ticketId, workdir: assignment.workdir, reason: message, attempts })
        if (ticket) {
          // 工作区没能自动回收时告诉发起人，避免以为代码已经清掉了。
          this.notify(
            ticket,
            `工单「${ticket.title}」已关闭，但对应的 workspace 未能自动回收：${message}\n请在 Orca 里确认（可能有未提交改动或目录已被占用）。`,
            `cleanup-skip:${ticketId}`,
          )
        }
        return
      }
      throw error
    }
  }

  // ---------- 上报 ----------

  /** Worker 通过 state.json 上报；poller 与测试都走这里。 */
  onWorkerState(state: WorkerStateFile, meta?: WorkerMeta): void {
    const ticket = this.store.getTicket(state.ticketId)
    if (!ticket) {
      this.logger.warn('report:unknown-ticket', { ticketId: state.ticketId })
      return
    }
    const assignment = (state.assignmentId ? this.store.getAssignment(state.assignmentId) : null) ?? this.store.latestAssignment(ticket.id)
    if (!assignment) {
      this.logger.warn('report:no-assignment', { ticketId: ticket.id })
      return
    }
    // 上报有 HTTP 与 state.json 两条通道；重启后 poller 会重读旧文件，
    // 用「上报时间早于最后一条已入库报告」把它挡掉，避免旧内容被重复投递。
    const latestReport = this.store.latestReport(ticket.id)
    const incomingAt = Date.parse(state.updatedAt)
    if (latestReport && Number.isFinite(incomingAt) && Date.parse(latestReport.at) > incomingAt) {
      this.logger.info('report:stale-ignored', { ticketId: ticket.id, incoming: state.updatedAt, latest: latestReport.at })
      return
    }
    const reply = state.reply?.trim() ?? ''
    const report = this.engine.report(assignment.id, {
      ticketId: ticket.id,
      turn: state.turn,
      state: state.state,
      summary: state.summary,
      ...(state.humanAction ? { humanAction: state.humanAction } : {}),
      ...(state.prNumber ? { prNumber: state.prNumber } : {}),
      ...(state.prUrl ? { prUrl: state.prUrl } : {}),
      ...(reply ? { reply } : {}),
      ackedInputs: state.ackedInputs,
    })
    this.appendEventLog(ticket.id, { kind: 'report', state: state.state, turn: state.turn, at: state.updatedAt })
    this.log('report', ticket.id, {
      state: state.state,
      turn: state.turn,
      summary: preview(state.summary),
      ...(state.humanAction ? { humanAction: preview(state.humanAction) } : {}),
      ...(state.prNumber ? { pr: state.prNumber } : {}),
      ...(reply ? { replyChars: reply.length } : {}),
    })

    // 追问的回答（ackedInputs 非空）用户正在等，立即发送；其余 progress 交给定时轮询合并。
    const answersInput = state.state === 'progress' && report.ackedInputs.length > 0 && Boolean(reply)
    if (answersInput) rememberProgress(this.seenProgress(ticket.id), progressSignature([report]))
    // 发送终态或追问回答前，先把更早的进展补同步掉，保证话题里的先后顺序。
    if (state.state !== 'progress' || answersInput) {
      try {
        this.syncProgress()
      } catch (error) {
        this.logger.warn('progress:sync-failed', { ticketId: ticket.id, message: error instanceof Error ? error.message : String(error) })
      }
    }

    const reportKey = `${state.turn}:${state.updatedAt}`
    if (reply && (state.state !== 'progress' || answersInput)) {
      // Worker 给了完整回复就原样发；正文里带文档链接 / PR 链接都照发，Router 不改写。
      const text = state.prUrl && !reply.includes(state.prUrl) ? `${reply}\n\nPR：${state.prUrl}` : reply
      this.queueLong(ticket, '', text, `reply:${ticket.id}:${reportKey}`)
    } else if (state.state === 'ready') {
      const key = `ready:${ticket.id}:${reportKey}`
      const base = `工单「${ticket.title}」已完成：${state.prUrl || state.summary}`
      this.queue(ticket, state.prUrl ? base : `${base}\n\n（worker 只回了一句话，未提供完整回复；如需完整内容请在本话题继续追问）`, key)
    }

    if (state.state === 'blocked' && !reply) {
      this.notify(ticket, `工单「${ticket.title}」卡住了：${state.humanAction ?? state.summary}`, `blocked:${ticket.id}:${reportKey}`)
    }
  }

  // ---------- 工单进展定时同步 ----------

  /**
   * 定时轮询工单进展：把自上次同步以来的 progress 上报合并成一条消息发到话题。
   * 由 `progress.syncMs` 定时触发；也可直接调用（测试或手动补同步）。
   */
  syncProgress(): void {
    const now = this.clock.now()
    for (const ticket of this.store.listOpenTickets()) {
      const cursorKey = progressCursorKey(ticket.id)
      let marker = this.store.getCursor(cursorKey)
      if (marker === null) {
        // 兼容升级前已存在的工单：以最新一条报告为基线，不把历史进展回灌进话题。
        const latest = this.store.latestReport(ticket.id)
        this.store.setCursor(cursorKey, latest?.id ?? PROGRESS_FROM_START, now)
        if (!latest) continue
        marker = latest.id
      }

      const fresh = this.store.listReportsAfter(ticket.id, marker)
      if (fresh.length === 0) continue
      const newest = fresh[fresh.length - 1]!
      // 先推进游标再发送：本轮跳过的内容（重复进展）不会在下一轮反复扫描。
      this.store.setCursor(cursorKey, newest.id, now)

      const pending = dedupeProgress(fresh.filter(report => report.state === 'progress'))
      const seen = this.seenProgress(ticket.id)
      const toSend = pending.filter(report => !seen.has(progressSignature([report])))
      if (toSend.length === 0) {
        if (pending.length > 0) this.log('progress:dedup', ticket.id, { skipped: pending.length })
        continue
      }

      const text = formatProgressDigest(ticket.title, toSend)
      if (!text) continue

      for (const report of toSend) rememberProgress(seen, progressSignature([report]))
      this.queueLong(ticket, '', text, `progress:${ticket.id}:${newest.id}`)
      this.log('progress:synced', ticket.id, { count: toSend.length })
    }
  }

  private seenProgress(ticketId: string): Set<string> {
    let seen = this.progressSeen.get(ticketId)
    if (!seen) {
      seen = new Set()
      this.progressSeen.set(ticketId, seen)
    }
    return seen
  }

  // ---------- 工单进展主动巡检 ----------

  /**
   * 不依赖 worker 上报：定时读 Orca 终端的渲染屏幕，判断 worker 是否还在动，
   * 并把最近输出摘录同步到工单话题。
   *
   * 覆盖两类场景：
   * - 执行中（assigned/running）但长时间没上报；
   * - 已 ready 进入 review/person 后，用户又发了新输入，worker 重新开工但阶段还没变。
   */
  async probeProgress(nowMs: number = Date.parse(this.clock.now())): Promise<void> {
    if (this.progressProbeMs <= 0 || this.probing) return
    if (!this.backend.read && !this.backend.session) return
    this.probing = true
    try {
      for (const ticket of this.store.listOpenTickets()) {
        try {
          await this.probeTicket(ticket, nowMs)
        } catch (error) {
          this.logger.warn('progress:probe-failed', {
            ticketId: ticket.id,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } finally {
      this.probing = false
    }
  }

  private async probeTicket(ticket: Ticket, nowMs: number): Promise<void> {
    const assignment = this.store.latestAssignment(ticket.id)
    if (!assignment?.handle || assignment.status === 'ended') return
    if (!this.awaitingWorker(ticket)) return

    const lastProgress = this.lastProgressAt(ticket)
    if (!lastProgress || nowMs - lastProgress < this.progressSilenceMs) return

    const record = this.readProbeRecord(ticket.id)
    const samePeriod = record !== null && record.lastProgressAt === lastProgress
    if (samePeriod && nowMs - record.lastPostAt < this.progressRepeatMs) return

    const info = this.backend.inspect
      ? (await this.backend.inspect(assignment.handle)) as OrcaTerminalInfo | null
      : null
    if (info && !info.connected) return

    // 首选 Agent 自己的结构化会话记录；没有（非 Claude / 文件未落盘）再退回终端屏幕。
    const snapshot = assignment.workdir
      ? await this.backend.session?.(assignment.workdir, { maxEvents: 40 })
      : null
    let snippet: string
    let source: 'session' | 'terminal'
    let lastActivityAt = Number.NaN
    if (snapshot && snapshot.events.length > 0) {
      snippet = extractSessionSnippet(snapshot.events)
      source = 'session'
      lastActivityAt = Date.parse(snapshot.at)
    } else {
      if (!this.backend.read) return
      const output = await this.backend.read(assignment.handle, { limit: 60 })
      if (!output || output.status !== 'running') return
      snippet = extractTerminalSnippet(output.lines)
      source = 'terminal'
      lastActivityAt = info?.lastOutputAt ? Date.parse(info.lastOutputAt) : Number.NaN
    }

    const snippetHash = snippetFingerprint(snippet)
    const unchanged = samePeriod && record.snippetHash === snippetHash
    const count = samePeriod ? record.count + 1 : 1
    const lastOutputAt = info?.lastOutputAt ? Date.parse(info.lastOutputAt) : Number.NaN

    const text = formatProbeMessage(ticket, {
      nowMs,
      lastProgress,
      snippet,
      unchanged,
      lastActivityAt,
      lastOutputAt,
      source,
      silenceMs: this.progressSilenceMs,
    })

    this.queue(ticket, text, `progress:probe:${ticket.id}:${lastProgress}:${count}`)
    this.store.setCursor(
      probeCursorKey(ticket.id),
      JSON.stringify({
        lastProgressAt: lastProgress,
        lastPostAt: nowMs,
        count,
        snippetHash,
      } satisfies ProbeRecord),
      this.clock.now(),
    )
    this.log('progress:probed', ticket.id, {
      minutes: Math.round((nowMs - lastProgress) / 60_000),
      count,
      unchanged,
      source,
    })
  }

  /** worker 是否应该在工作：执行中，或 ready / blocked 之后又收到了新输入。 */
  private awaitingWorker(ticket: Ticket): boolean {
    if (ticket.stage === 'assigned' || ticket.stage === 'running') return true
    const latest = this.store.latestReport(ticket.id)
    const newestInput = this.store.listInputs(ticket.id).at(-1)
    if (!newestInput) return false
    const inputAt = Date.parse(newestInput.createdAt)
    return Number.isFinite(inputAt) && (!latest || inputAt > Date.parse(latest.at))
  }

  private readProbeRecord(ticketId: string): ProbeRecord | null {
    const raw = this.store.getCursor(probeCursorKey(ticketId))
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Partial<ProbeRecord>
      if (typeof parsed.lastProgressAt !== 'number' || typeof parsed.lastPostAt !== 'number') return null
      return {
        lastProgressAt: parsed.lastProgressAt,
        lastPostAt: parsed.lastPostAt,
        count: typeof parsed.count === 'number' ? parsed.count : 0,
        snippetHash: typeof parsed.snippetHash === 'string' ? parsed.snippetHash : '',
      }
    } catch {
      return null
    }
  }

  // ---------- 停止 ----------

  stopTicket(ticketId: string, reason: string): Ticket {
    const ticket = this.engine.stopTicket(ticketId, reason)
    this.store.enqueueEffect({ id: `ef_stop_${ticketId}_${Date.now()}`, key: `stop:${ticketId}`, kind: 'stop-worker', payload: { ticketId }, now: this.clock.now() })
    return ticket
  }

  // ---------- PR 闭环 ----------

  async trackPullRequests(): Promise<void> {
    for (const ticket of this.store.listOpenTickets()) {
      // 每张工单自带仓库，不再有全局 repo 兜底。
      const repo = ticket.repo
      let prNumber = ticket.prNumber
      let prUrl = ticket.prUrl

      // 双保险之一：Orca worktree 自带的 linkedPR / linkedGitLabMR。
      if (!prNumber && this.backend.inspectWorktree) {
        const assignment = this.store.latestAssignment(ticket.id)
        // 派工已结束或 worktree 被删时 Orca 会返回 selector_not_found，静默跳过，不要每 5 秒刷错误。
        if (assignment?.workdir && assignment.status !== 'ended') {
          try {
            const worktree = (await this.backend.inspectWorktree(`path:${assignment.workdir}`)) as Record<string, any> | null
            const linked = worktree?.linkedPR ?? worktree?.linkedGitLabMR ?? worktree?.worktree?.linkedPR
            const number = Number(linked?.number ?? linked?.iid ?? 0)
            if (number > 0) {
              prNumber = number
              prUrl = String(linked.url ?? linked.webUrl ?? prUrl)
              this.engine.updatePr(ticket.id, { number: prNumber, url: prUrl, state: 'open' })
              this.log('pr:linked', ticket.id, { number: prNumber, source: 'orca' })
            }
          } catch {
            // worktree 不在了：等 gh 兜底或人工处理
          }
        }
      }

      // 双保险之二：gh pr view。
      if (!prNumber || !repo) continue
      const info = await this.prTracker.view(repo, prNumber)
      if (!info) continue

      const before = ticket.prState
      const updated = this.engine.updatePr(ticket.id, { number: info.number, url: info.url || ticket.prUrl, state: info.state })
      if (before !== info.state) this.log('pr:state', ticket.id, { from: before, to: info.state })

      if ((info.state === 'merged' || info.state === 'closed') && updated.stage !== 'closed') {
        const closed = this.engine.closeTicket(ticket.id, `pr:${info.state}`)
        appendEvent(join(this.config.home, 'workers', ticket.id, 'events.log'), { kind: 'pr', state: info.state, at: this.clock.now() })
        const label = info.state === 'merged' ? '已合并' : '已关闭'
        this.notify(closed, `工单「${closed.title}」的 PR ${info.url} ${label}，工单闭环。`, `pr:${ticket.id}:${info.state}`)
      }
    }
  }

  // ---------- 重启对账 ----------

  async recover(): Promise<void> {
    for (const ticket of this.store.listOpenTickets()) {
      const assignment = this.store.latestAssignment(ticket.id)
      if (assignment && assignment.status !== 'ended' && assignment.handle && this.backend.inspect) {
        let info: { connected?: boolean; orphaned?: boolean } | null
        try {
          info = (await this.backend.inspect(assignment.handle)) as { connected?: boolean; orphaned?: boolean } | null
        } catch {
          // Orca 暂时不可用：保持现状，不要误判成会话丢失。
          continue
        }
        // 实测 CLI 创建的终端可能 orphaned=true 但依然 connected/writable；
        // 只有 connected=false 才说明终端真的没了。
        if (info && info.connected) {
          if (info.orphaned) this.logger.warn('recover:orphaned-but-alive', { ticketId: ticket.id, handle: assignment.handle })
          else this.log('recover:reuse', ticket.id, { handle: assignment.handle })
          continue
        }
        // 会话没了就不再偷偷重开一个没有上下文的新 worker，直接转人工。
        this.handleLostWorker(ticket, 'recover')
        continue
      }
      if (ticket.stage !== 'closed' && (!assignment || assignment.status === 'ended')) {
        if (ticket.stage === 'accepted' || ticket.stage === 'assigned' || ticket.stage === 'running') {
          try {
            await this.launch(ticket)
            this.log('recover:relaunch', ticket.id, {})
          } catch {
            // launch() 已记录详细失败原因、转人工并通知发起人。
          }
        }
      }
    }
    this.poller.reset?.()
  }

  // ---------- 内部 ----------

  /** 只把「终端确实不存在」判为丢失；Orca 短暂不可用不误杀。 */
  private async workerGone(handle: string): Promise<boolean> {
    if (!this.backend.inspect) return false
    try {
      const info = (await this.backend.inspect(handle)) as { connected?: boolean } | null
      return info === null || info.connected === false
    } catch {
      return false
    }
  }

  /**
   * Worker 会话被意外删除：结束派工、转人工、取消线程订阅，只通知一次。
   * 不自动重开新 worker——新会话没有原上下文，重跑等于从头再来。
   */
  private handleLostWorker(ticket: Ticket, reason: string): void {
    const assignment = this.store.latestAssignment(ticket.id)
    if (assignment && assignment.status !== 'ended') {
      this.store.updateAssignment({ ...assignment, status: 'ended', endedAt: this.clock.now() })
    }
    this.engine.setAttention(ticket.id, '执行会话意外删除，已经找不到了')
    this.engine.unsubscribe(ticket.threadId, ticket.id)
    this.notify(
      ticket,
      `工单「${ticket.title}」的执行会话意外删除，已经找不到了，无法继续执行。如果还需要继续，请在本话题里说明，我会重新开一张工单。`,
      `worker-lost:${ticket.id}`,
    )
    this.log('worker:lost', ticket.id, { handle: assignment?.handle ?? '', reason })
  }

  /** 长内容按行切块并顺序进入 outbox，避免超过飞书单条消息长度。 */
  private queueLong(ticket: Ticket, header: string, content: string, key: string): void {
    const body = header ? `${header}\n\n${content}` : content
    const chunks = splitMessage(body, 3500)
    const base = Date.parse(this.clock.now())
    chunks.forEach((chunk, index) => {
      const suffix = chunks.length > 1 ? `\n\n(${index + 1}/${chunks.length})` : ''
      this.store.enqueueOutbox({
        id: `ob_${`${key}:${index}`.replace(/[^a-zA-Z0-9:_-]/g, '_')}`,
        key: `${key}:${index}`,
        channelKind: 'feishu',
        channelId: ticket.chatId,
        threadId: ticket.threadId.split(':').at(-1) ?? '',
        text: `${chunk}${suffix}`,
        now: Number.isFinite(base) ? new Date(base + index).toISOString() : this.clock.now(),
      })
    })
  }

  private queue(ticket: Ticket, text: string, key: string): void {
    this.store.enqueueOutbox({
      id: `ob_${key.replace(/[^a-zA-Z0-9:_-]/g, '_')}`,
      key,
      channelKind: 'feishu',
      channelId: ticket.chatId,
      threadId: ticket.threadId.split(':').at(-1) ?? '',
      text,
      now: this.clock.now(),
    })
  }

  private notify(ticket: Ticket, text: string, key: string): void {
    this.queue(ticket, text, key)
  }

  private appendEventLog(ticketId: string, event: Record<string, unknown>): void {
    const dir = join(this.config.home, 'workers', ticketId)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'events.log'), `${JSON.stringify(event)}\n`, 'utf8')
  }

  private log(kind: string, ticketId: string, extra: Record<string, unknown>): void {
    this.logger.info(kind, { ticketId, ...extra })
  }
}

export interface CreateServiceDeps {
  config: AppConfig
  runner: CommandRunner
  backend: WorkerBackend & {
    inspect?: (handle: string) => Promise<unknown | null>
    removeWorktree?: (selector: string) => Promise<void>
  }
  prTracker: GhTracker
  sender: FeishuOutbound
  logger: Logger
}

/** 回复投递需要的飞书能力；生产环境由 FeishuSender 实现。 */
export interface FeishuOutbound {
  reply(messageId: string, text: string, idempotencyKey: string): Promise<void>
  send(chatId: string, text: string, idempotencyKey: string): Promise<void>
  sendCard(chatId: string, markdown: string, idempotencyKey: string): Promise<void>
  replyCard(messageId: string, markdown: string, idempotencyKey: string): Promise<void>
}

/** 生产装配：用一个 CommandRunner 驱动 Orca 与 gh。 */
export function createEffectsSender(sender: FeishuOutbound): OutboundSender {
  return {
    async send(item) {
      if (item.channelKind !== 'feishu') return
      const text = item.text.trim()
      if (!text) return
      // 简单消息走纯文本：不开卡片，少一次渲染、少一类兼容问题。
      if (shouldSendAsText(text)) {
        if (item.threadId) await sender.reply(item.threadId, text, item.key)
        else await sender.send(item.channelId, text, item.key)
        return
      }
      // 其余走互动卡片：Markdown 先在 feishuCard 内归一化，卡片失败时 Sender 内部降级为 post。
      if (item.threadId) await sender.replyCard(item.threadId, text, item.key)
      else await sender.sendCard(item.channelId, text, item.key)
    },
  }
}

/** 按行切成不超过 limit 的消息块，保证长回复不会被截断。 */
export function splitMessage(text: string, limit = 3500): string[] {
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}

export interface LaunchErrorDetail {
  reason: string
  /** Orca 包装成通用文案时保留在 `error.data.cause` 里的底层原因。 */
  cause?: string
  /** 启动结果未知时的重试句柄。 */
  operationId?: string
  code?: number
  orcaCode?: string
  args?: string
  stdout?: string
  stderr?: string
}

/**
 * 把后端抛出的错误整理成可读、可审计的结构。
 * Orca 在 `--json` 模式下把错误体写在 stdout，stderr 通常为空；
 * 只取 stderr 会得到没有信息量的 `code=1`。
 */
export function describeLaunchError(error: unknown): LaunchErrorDetail {
  if (error instanceof OrcaCommandError) {
    const detail = error.detail
    return {
      reason: detail.orcaMessage ?? error.message,
      ...(detail.orcaCause ? { cause: detail.orcaCause } : {}),
      ...(detail.orcaOperationId ? { operationId: detail.orcaOperationId } : {}),
      code: detail.code,
      ...(detail.orcaCode ? { orcaCode: detail.orcaCode } : {}),
      ...(detail.args ? { args: detail.args } : {}),
      ...(detail.stdoutTail ? { stdout: detail.stdoutTail } : {}),
      ...(detail.stderrTail ? { stderr: detail.stderrTail } : {}),
    }
  }
  return { reason: error instanceof Error ? error.message : String(error) }
}

/** 同一条失败原因只通知一次，避免用户每次重试都收到重复消息。 */
function reasonKey(reason: string): string {
  let hash = 0
  for (let i = 0; i < reason.length; i += 1) {
    hash = (hash * 31 + reason.charCodeAt(i)) >>> 0
  }
  return hash.toString(36)
}
