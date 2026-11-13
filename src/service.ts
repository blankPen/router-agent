import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Clock, Engine } from './core/engine.js'
import type { Assignment, Input, Question, Report, Ticket, Trigger } from '#core/model.js'
import type { ReplyBlock, ReplyPayload, ReplyQuestion } from '#core/reply.js'
import { choiceBlockOf } from '#core/reply.js'
import type { Store } from './store/db.js'
import type { AppConfig, RetentionSettings, WorkspaceSettings } from './config.js'
import { DEFAULT_CHAT_INTAKE, replyAlwaysChatsOf } from './config.js'
import { STAGE_LABELS } from '#core/stage.js'
import { WorkerRuntimeError, type WorkerRuntime, type WorkerContext, type SessionEvent, type WorkerRef, type AgentStatus, type ResumeHint } from '#runtime/port.js'
import { AgentLoop } from './router/agent-loop.js'
import type { DecisionAudit, DecisionEngine } from './router/decision-engine.js'
import { dispatchSettingsOf } from './router/dispatch.js'
import type { IntakeEngine } from './router/intake-engine.js'
import type { IntakeChatSettings } from './router/intake-flow.js'
import { createRepoPathResolver } from './router/repo-paths.js'
import { ReportPoller, appendEvent, readWorkerMeta, type WorkerMeta, type WorkerStateFile } from '#runtime/report-poller.js'
import { classifyAgentStatus } from '#runtime/status.js'
import { RuntimeRegistry } from '#runtime/registry.js'
import { normalizeRuntimeId, ORCA_RUNTIME_ID } from '#runtime/runtimes/catalog.js'
import { buildNeutralContract, buildWorkerBrief, buildWorkerPrompt, workerSkillDir, workerSkillSnapshot, type WorkerSkillSnapshot } from '#runtime/spec/index.js'
import { migrateLegacySoul } from './specs/index.js'
import { workBranch } from '#runtime/naming.js'
import { buildResumeHint } from '#runtime/resume.js'
import { resolveSession } from '#runtime/agents/registry.js'
import { runtimeOptionString } from '#runtime/runtimes/options.js'
import {
  workspaceRuntimeLabel,
  type WorkspaceCleanupRequest,
  type WorkspaceCleanupResultView,
  type WorkspaceEntryView,
  type WorkspaceOverviewView,
  type WorkspaceRuntimeGroupView,
} from '#runtime/workspaces/overview.js'
import { EffectsProcessor } from './core/effects.js'
import { preview } from '#core/events.js'
import { DEFAULT_CHANNEL_ID } from '#channel/port.js'
import type { CardAction, QuestionCardUpdate } from '#channel/port.js'
import type { ChannelRegistry } from '#channel/registry.js'
import type { CommandRunner } from '#infra/process.js'
import { realRunner } from '#infra/process.js'
import { errorMessage, noopLogger, withFieldContext, type Logger } from '#infra/logger.js'
import type { PrInfo } from './sources/github.js'
import {

  ReportRejectedError,
  decisionLogDetail,
  evaluateUiEvidence,
  evidenceRejectedMessage,
} from '#runtime/evidence-gate.js'

// Logger 的实现放在 infra/logger.ts；这里保留 re-export，兼容既有 import。
export type { Logger } from '#infra/logger.js'

export interface PrTracker {
  /** hint 用于把项目名/path 选择器解析成真实仓库：优先 PR/MR 链接，其次 workdir。 */
  view(repo: string, number: number, hint?: { url?: string; cwd?: string }): Promise<PrInfo | null>
  /** 按工作分支反查；GitLab 需要 workdir 让 glab 从 git remote 推断项目。 */
  findByBranch(repo: string, branch: string, hint?: { cwd?: string }): Promise<PrInfo | null>
}

export interface OutboundSender {
  send(item: { channelKind: string; channelId: string; threadId: string; text: string; key: string; blocks?: ReplyBlock[] }): Promise<void>
}

export interface RouterServiceOptions {
  config: AppConfig
  store: Store
  engine: Engine
  runtime: WorkerRuntime
  /** 多运行时注册表；不传时退化为只含 runtime 的单运行时注册表。 */
  runtimes?: RuntimeRegistry
  /** 唯一研判引擎（Pi）。 */
  decisionEngine: DecisionEngine
  /**
   * 需求识别引擎（初筛 + 分析子 Agent）。
   * 只在有群开启「需求分析助手」时装配；不传则普通成员仍无法自助提需。
   */
  intakeEngine?: IntakeEngine
  /**
   * 群 id → 终审管理员 open_id（启动时已把邮箱解析成 open_id）。
   * 没传时按「没配管理员」处理，终审回退到全局允许名单。
   */
  intakeApprovers?: Record<string, string[]>
  /** intake 读代码时把 repo 选择器解析成本地目录；不传则只基于对话分析。 */
  resolveIntakeProjectPath?: (project: { name: string; repo: string }) => Promise<string | undefined>
  /** Orca 命令；传了但没传 resolveIntakeProjectPath 时用默认解析器。 */
  orca?: CommandRunner
  prTracker: PrTracker
  clock?: Clock
  logger?: Logger
  /** git 命令；UI 证据门禁按改动文件推断是否属于 UI 工单。 */
  git?: CommandRunner
  poller?: { scan(): number; reset?: () => void }
  effects?: EffectsProcessor
  sender?: OutboundSender
  /** 通道注册表；选择题回写卡片时按工单所在通道找适配器。 */
  channels?: ChannelRegistry
  agentLoopOptions?: { batchWindowMs?: number }
  onDecisionAudit?: (audit: DecisionAudit) => void
  /** 终端多久没输出算空闲，默认 2 分钟。 */
  idleAfterMs?: number
  /** 唤醒后多久仍无响应算 stale，默认 5 分钟。 */
  staleAfterMs?: number
  /** 注入触发源（服务层由通道适配器接入）。 */
  onTrigger?: (trigger: Trigger) => void
  /** Claude Code 会话记录目录；默认 ~/.claude/projects，测试可注入。 */
  claudeProjectsDir?: string
}

/** 进展游标的起点标记：表示「从派工这一刻开始」，之前没有需要同步的报告。 */
const PROGRESS_FROM_START = '@start'

function progressCursorKey(ticketId: string): string {
  return `progress:${ticketId}`
}

/** 派工失败水位：持久化到 cursors，重启后仍能区分「失败前积压的旧输入」与「用户新回复」。 */
function launchFailureCursorKey(ticketId: string): string {
  return `launch-failure:${ticketId}`
}

/**
 * 重新派工水位：记录上一次「为积压输入重建 worker」时处理到的最大输入 seq。
 * 同一条输入只允许触发一次重建，避免新 worker 也投递失败时无限重建（tk-51）。
 */
function relaunchCursorKey(ticketId: string): string {
  return `relaunch:${ticketId}`
}

/**
 * 中断恢复水位：记录已处理过的「被中断轮次」与自动恢复次数。
 * 持久化到 cursors，保证同一个被中断的轮次不会被反复恢复 / 反复提醒。
 */
function interruptedCursorKey(ticketId: string): string {
  return `interrupted:${ticketId}`
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
  /** 语义摘要指纹；摘要没变时可以明确告诉用户。 */
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

/** 未 ack 提醒水位：同一条输入只提醒一次。 */
function unackedNoticeCursorKey(inputId: string): string {
  return `input:unacked-notice:${inputId}`
}

/** 单条输入最多投递次数；超过转人工，不再无限重投。 */
const MAX_DELIVERY_ATTEMPTS = 5

/** 已投递未 ack 多久算「worker 一直没确认」，记 warn 提示人工看一眼。 */
const UNACKED_TIMEOUT_MS = 30 * 60_000

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

/**
 * Orca 终端句柄失效：句柄只在签发它的那个 Orca 服务实例里有效。
 * 服务重启 / 终端早已关闭后再关，永远会报 terminal_handle_stale。
 */
function isStaleHandleError(error: unknown): boolean {
  const message = errorMessage(error)
  return /terminal_handle_stale|terminal not found|no such terminal/i.test(message)
}

interface LaunchFailureRecord {
  attempts: number
  /** 上次失败时工单上已存在的最大输入序号；序号不大于它的输入不再触发重试。 */
  lastSeq: number
  lastReason: string
}

/** 中断恢复水位：同一个被中断的轮次只处理一次，自动恢复次数也有上限。 */
interface InterruptedRecord {
  /** 已处理过的被中断轮次 id；避免重启后反复恢复同一轮。 */
  turnIds: string[]
  /** 已自动恢复的次数。 */
  autoRecovered: number
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

/** 巡检时不在摘要里展开的纯流程工具：只影响 agent 内部节奏，对用户没有信息量。 */
const NOISE_TOOLS = new Set(['TodoWrite', 'TodoRead', 'ExitPlanMode', 'EnterPlanMode', 'BashOutput', 'KillShell'])

/** 渲染屏幕里的活动标记：⏺ 等是 agent 输出，⎿ 是工具结果，✻✽ 是状态行。 */
const ACTIVITY_MARKER = /^[⏺◆◇●○]\s*(.*)$/
const TOOL_RESULT_LINE = /^⎿/
const STATUS_LINE = /^[✻✽✶✳⏵]/

/** Claude Code 在渲染屏幕里的工具调用回显：`⏺ Update(path)`、`⏺ Bash(命令)` 等。 */
const TERMINAL_TOOL_LINE = new RegExp(
  `^[⏺◆◇●○]\\s*(Update|Edit|MultiEdit|Write|Read|Bash|Shell|Grep|Glob|Task|Agent|WebFetch|WebSearch|NotebookEdit|TodoWrite|TodoRead|ExitPlanMode|BashOutput|KillShell)\\b(?:\\s*\\((.*)\\)|\\s*[:：]\\s*(.*))?$`,
)

interface ActionItem {
  key: string
  label: string
}

/** 把工具事件解析成 `{ 工具名, 目标 }`；优先用结构化信息，旧数据从展示文本反解。 */
function toolInfoOf(event: SessionEvent): { name: string; target?: string } | null {
  if (event.tool?.name) return event.tool
  const body = event.text.replace(/\s+/g, ' ').trim()
  if (!body) return null
  const call = body.match(/^([A-Za-z][\w.-]*)(?:\((.*)\))?$/)
  if (call) return { name: call[1]!, ...(call[2] ? { target: call[2] } : {}) }
  const colon = body.match(/^([A-Za-z][\w.-]*)[：:]\s*(.+)$/)
  if (colon) return { name: colon[1]!, target: colon[2]! }
  return { name: body }
}

/**
 * 把一次工具调用翻译成用户能看懂的动作：修改 / 查看 / 检索 / 执行。
 * 目标只保留文件名或一句话描述，绝不回放完整命令或文件内容。
 */
function semanticActionOf(event: SessionEvent): ActionItem | null {
  const info = toolInfoOf(event)
  if (!info || NOISE_TOOLS.has(info.name)) return null
  const target = (info.target ?? '').replace(/\s+/g, ' ').trim()
  const short = target.length <= 60 ? target : `${target.slice(0, 60)}…`
  switch (info.name) {
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Update':
      return { key: `edit:${short}`, label: short ? `修改 ${short}` : '修改代码' }
    case 'Read':
      return { key: `read:${short}`, label: short ? `查看 ${short}` : '查看代码' }
    case 'Grep':
    case 'Glob':
      return { key: `search:${short}`, label: short ? `检索 ${short}` : '搜索代码' }
    case 'Bash':
    case 'Shell':
      return { key: `run:${short}`, label: short ? `执行 ${short}` : '执行命令' }
    case 'Task':
    case 'Agent':
      return { key: `task:${short}`, label: short ? `子任务：${short}` : '子任务' }
    case 'WebFetch':
    case 'WebSearch':
      return { key: 'web', label: '查询资料' }
    default:
      return { key: `other:${info.name}`, label: short ? `${info.name}：${short}` : info.name }
  }
}

/**
 * 把一批工具事件折叠成一句话的动作概要。
 * 同一类动作只报一次并按次数合并，最多展开 maxItems 项，避免工具调用刷屏。
 */
export function summarizeToolActions(events: SessionEvent[], opts: { maxItems?: number } = {}): string {
  const maxItems = opts.maxItems ?? 4
  const items = new Map<string, { label: string; count: number }>()
  for (const event of events) {
    if (event.kind !== 'tool') continue
    const action = semanticActionOf(event)
    if (!action) continue
    const found = items.get(action.key)
    if (found) {
      found.count += 1
      found.label = action.label
    } else {
      items.set(action.key, { label: action.label, count: 1 })
    }
  }
  if (items.size === 0) return ''
  const entries = [...items.values()]
  const shown = entries.slice(0, maxItems).map(item => (item.count > 1 ? `${item.label} ×${item.count}` : item.label))
  if (entries.length > maxItems) shown.push(`等 ${entries.length} 项动作`)
  return shown.join('、')
}

/**
 * 从 Orca 渲染屏幕里挑出最后几行「像进展」的输出。
 *
 * 只保留 agent 的自然语言输出，把工具调用回显（`⏺ Update(x)`）、工具结果（`⎿`）
 * 与状态行（`✻✽`）折叠成一行动作概要；没有活动标记时退回屏幕尾部的自然文本。
 */
export function extractTerminalSnippet(lines: string[], opts: { maxLines?: number; maxChars?: number } = {}): string {
  const maxLines = opts.maxLines ?? 6
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

  const textLines: Array<{ index: number; text: string }> = []
  const toolEvents: Array<{ index: number; event: SessionEvent }> = []
  afterInput.forEach((line, index) => {
    if (TOOL_RESULT_LINE.test(line) || STATUS_LINE.test(line)) return
    const tool = parseTerminalToolLine(line)
    if (tool) {
      toolEvents.push({ index, event: { at: '', kind: 'tool', text: tool.text, tool: tool.info } })
      return
    }
    const match = line.match(ACTIVITY_MARKER)
    const text = (match ? match[1]! : '').trim()
    if (text) textLines.push({ index, text })
  })

  const lastTextIndex = textLines.at(-1)?.index ?? -1
  const actionSummary = summarizeToolActions(toolEvents.filter(item => item.index >= lastTextIndex).map(item => item.event))
  const summary = textLines.slice(-maxLines).map(item => item.text)
  if (actionSummary) summary.push(`动作概要：${actionSummary}`)
  if (summary.length > 0) return joinSnippet(summary, maxChars)

  // 没有活动标记（普通 shell / 已结束的会话）：取输入回显之前的屏幕尾部。
  const fallback = (inputAt >= 0 ? cleaned.slice(0, inputAt) : cleaned)
    .filter(line => !STATUS_LINE.test(line) && !TOOL_RESULT_LINE.test(line))
  return joinSnippet(fallback.slice(-maxLines), maxChars)
}

/** 解析渲染屏幕里的工具调用回显；解析不出来返回 null（当作自然语言文本）。 */
function parseTerminalToolLine(line: string): { text: string; info: { name: string; target?: string } } | null {
  const match = line.match(TERMINAL_TOOL_LINE)
  if (!match) return null
  const name = match[1]!
  const target = (match[2] ?? match[3] ?? '').replace(/\s+/g, ' ').trim() || undefined
  return { text: target ? `${name}(${target})` : name, info: { name, ...(target ? { target } : {}) } }
}

/** 终端摘录指纹：只用来判断「画面有没有变化」，不做安全用途。 */
export function snippetFingerprint(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0
  return hash.toString(16)
}

/**
 * 从 Agent 的会话记录里生成语义化摘要。
 * 主内容是 assistant 自己的话（连续重复的压成一条）；工具调用不再逐条回放，
 * 只把最后一条文本之后的动作折叠成一行「动作概要」。
 */
export function extractSessionSnippet(events: SessionEvent[], opts: { maxLines?: number; maxChars?: number } = {}): string {
  const maxLines = opts.maxLines ?? 4
  const maxChars = opts.maxChars ?? 1200

  const textEvents: Array<{ at: string; text: string; count: number }> = []
  let lastTextIndex = -1
  events.forEach((event, index) => {
    if (event.kind !== 'text') return
    const body = event.text.replace(/\s+/g, ' ').trim()
    if (!body) return
    lastTextIndex = index
    const last = textEvents.at(-1)
    if (last && last.text === body) {
      last.count += 1
      last.at = event.at
    } else {
      textEvents.push({ at: event.at, text: body, count: 1 })
    }
  })

  const recentTools = events.slice(lastTextIndex + 1).filter(event => event.kind === 'tool')
  const actionSummary = summarizeToolActions(recentTools)

  const lines = textEvents.slice(-maxLines).map(event => {
    const time = clockOf(event.at)
    const truncated = event.text.length <= 180 ? event.text : `${event.text.slice(0, 180)}…`
    return `${time ? `[${time}] ` : ''}${truncated}${event.count > 1 ? ` ×${event.count}` : ''}`
  })
  if (actionSummary) lines.push(`动作概要：${actionSummary}`)
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
  const activeStage = ticket.stage === 'running'
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
  // 摘要按行渲染成列表：语义摘要不是原始日志，代码块只会让「动作概要」更像噪音。
  const snippetLines = (info.snippet || '(没有可读输出)').replace(/```/g, "'''").split('\n')
  lines.push('', `**最新进展（语义摘要 · ${sourceLabel}）**`, ...snippetLines.filter(Boolean).map(line => `- ${line}`))
  if (info.unchanged) lines.push('', `与上次巡检相比，${sourceLabel}没有新变化。`)
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
 * 服务编排：把 AgentLoop、上报轮询、Effects、PR 跟踪与 WorkerRuntime 接在一起。
 * 本身不持有终端状态；重启后靠 recover() 与 Orca 对账。
 */
export class RouterService {
  readonly store: Store
  readonly engine: Engine
  readonly loop: AgentLoop
  readonly config: AppConfig
  private decisionEngine: DecisionEngine
  private runtimes: RuntimeRegistry
  private clock: Clock
  private logger: Logger
  private poller: { scan(): number; reset?: () => void }
  private effects: EffectsProcessor
  private prTracker: PrTracker
  private git: CommandRunner
  private sender: OutboundSender
  private readonly channels?: ChannelRegistry
  /** 卡片回调事件流没启动成功的通道；auto 模式下选择题退化为序号回复。 */
  private readonly cardActionsUnavailable = new Set<string>()
  private timers: NodeJS.Timeout[] = []
  private running = false
  private idleAfterMs: number
  private staleAfterMs: number
  /** Claude Code 会话记录目录；用于给 Orca 工单补 sessionId。 */
  private claudeProjectsDir?: string
  private idle = new Map<string, { turn: number; nudgedAt: number | null; stale: boolean; blocked?: boolean; transferred?: boolean }>()
  private ticking = false
  /** 每条输入已经投递过几次；用于区分并发去重与串行重投。 */
  private deliveryAttempts = new Map<string, number>()
  /** queued/rejected 后的退避截止时间，避免每秒拉起一次 Agent 查询。 */
  private deliveryCooldown = new Map<string, number>()
  /** 每个工单最近一次真正发起投递时的最大输入 seq；用于区分「同一批重试」与「新输入」。 */
  private deliveryAttemptedSeq = new Map<string, number>()
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
  /** 闲置治理的计时基线（服务启动时刻）：启动前就已无进展的工单从启动时重新计时。 */
  private retentionBaselineMs = 0
  /** 关单后工作区的保留期与扫描间隔。 */
  private workspace: WorkspaceSettings
  /** 防止上一轮回收扫描还没结束、下一轮又进来。 */
  private workspaceSweeping = false

  constructor(opts: RouterServiceOptions) {
    this.store = opts.store
    this.engine = opts.engine
    this.config = opts.config
    this.runtimes = opts.runtimes ?? new RuntimeRegistry(new Map([[opts.runtime.id, opts.runtime]]), opts.runtime.id)
    this.clock = opts.clock ?? { now: () => new Date().toISOString() }
    // 工单日志统一补上下文：任何带 ticketId 的日志都会带上群、发起人与运行时。
    this.logger = withFieldContext(opts.logger ?? noopLogger, 'ticketId', ticketId => this.contextOf(ticketId))
    this.prTracker = opts.prTracker
    this.git = opts.git ?? realRunner('git')
    this.idleAfterMs = opts.idleAfterMs ?? 120_000
    this.staleAfterMs = opts.staleAfterMs ?? 300_000
    this.claudeProjectsDir = opts.claudeProjectsDir
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
    this.workspace = opts.config.workspace ?? {
      enabled: true,
      keepHours: 24,
      sweepMinutes: 30,
    }
    this.decisionEngine = opts.decisionEngine
    // 旧版「自定义人格文件路径」迁移到内置规范存储；原文件保留，失败不阻断启动。
    const migration = migrateLegacySoul(opts.config.home)
    if (migration.error) this.logger.warn('spec:migration-failed', { message: migration.error })
    else if (migration.imported) this.logger.info('spec:migrated', { source: migration.source, spec: 'router.soul' })
    this.loop = new AgentLoop({
      engine: opts.engine,
      decisionEngine: opts.decisionEngine,
      clock: this.clock,
      logger: this.logger,
      home: opts.config.home,
      batchWindowMs: opts.agentLoopOptions?.batchWindowMs ?? 8000,
      dispatch: dispatchSettingsOf(opts.config),
      replyAlwaysChats: replyAlwaysChatsOf(opts.config),
      sessionsEnabled: opts.config.router.session.enabled,
      sessionKeyScope: opts.config.router.session.keyScope,
      persona: opts.config.router.persona,
      ...(opts.onDecisionAudit ? { onAudit: opts.onDecisionAudit } : {}),
      ...(opts.intakeEngine
        ? {
            intake: {
              llm: opts.intakeEngine,
              settings: { forChat: (chatId: string) => this.intakeSettingsOf(opts, chatId) },
              resolveProjectPath: this.intakeProjectPathOf(opts),
            },
          }
        : {}),
    })
    this.poller = opts.poller ?? new ReportPoller({
      workersDir: join(opts.config.home, 'workers'),
      onState: (state, meta) => {
        // 证据门禁需要查 git / PR，异步执行；失败不能丢掉这条上报，分类型落日志。
        void this.ingestWorkerState(state, meta ?? undefined).catch(error => this.handleIngestError(state, error))
      },
      onError: (ticketId, error) => this.logger.error('report:invalid', { ticketId, message: error.message }),
    })
    this.sender = opts.sender ?? { send: async () => {} }
    this.channels = opts.channels
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
      const runtime = this.runtimeFor(assignment)
      try {
        await runtime.stop(this.refOf(assignment), 'ticket-stopped')
      } catch (error) {
        // 终端句柄属于当时签发它的 Orca 服务；服务重启 / 终端早已关闭时永远关不掉。
        // 这种失败重试再多次也不会成功，只会无限刷 effect:failed，所以吞掉并记一次。
        if (!isStaleHandleError(error)) throw error
        this.logger.info('worker:stop-stale', { ticketId, handle: assignment.handle, runtime: assignment.runtimeId })
        return
      }
      this.log('worker:stopped', ticketId, { handle: assignment.handle })
    })
    effects.register('launch-worker', async payload => {
      const ticket = this.store.getTicket(String(payload.ticketId ?? ''))
      if (!ticket || ticket.stage === 'done') return
      await this.launch(ticket)
    })
    effects.register('cleanup-workspace', async (payload, item) => {
      await this.cleanupWorkspace(String(payload.ticketId ?? ''), item.attempts)
    })
  }

  /** 把 Assignment 折成运行时可消费的中立引用。 */
  private refOf(assignment: Assignment): WorkerRef {
    return {
      handle: assignment.handle,
      ticketId: assignment.ticketId,
      ...(assignment.workdir ? { workdir: assignment.workdir } : {}),
    }
  }

  private workspaceRefOf(assignment: Assignment): { ticketId: string; workdir: string; repo?: string } {
    const repo = this.store.getTicket(assignment.ticketId)?.repo
    return { ticketId: assignment.ticketId, workdir: assignment.workdir, ...(repo ? { repo } : {}) }
  }

  /** intake 用：优先注入的解析器，其次按 Orca 仓库清单解析；两者都没有就只做对话分析。 */
  private intakeProjectPathOf(opts: RouterServiceOptions): (project: { name: string; repo: string }) => Promise<string | undefined> {
    if (opts.resolveIntakeProjectPath) return opts.resolveIntakeProjectPath
    // 没有 orca 也能解析 path:/abs 这类直接选择器；只有 name:/id: 选择器才需要 orca。
    const resolve = createRepoPathResolver({ ...(opts.orca ? { orca: opts.orca } : {}) })
    return async project => (await resolve(project.repo)) ?? (project.name ? resolve(project.name) : undefined)
  }

  /**
   * 某个群的需求分析配置。
   *
   * 管理员取解析后的 open_id：配置里写邮箱时原始条目是邮箱，
   * 拿邮箱去比 open_id 永远匹配不上，终审就没人能过。
   */
  private intakeSettingsOf(opts: RouterServiceOptions, chatId: string): IntakeChatSettings {
    const chat = opts.config.feishu.chats.find(item => item.chat === chatId)
    const intake = chat?.intake
    return {
      enabled: intake?.enabled ?? false,
      approvers: opts.intakeApprovers?.[chatId] ?? [],
      maxQuestions: intake?.maxQuestions ?? DEFAULT_CHAT_INTAKE.maxQuestions,
      codeAccess: intake?.codeAccess ?? DEFAULT_CHAT_INTAKE.codeAccess,
    }
  }

  /** 按 assignment 的 runtimeId 取运行时；旧工单不会被新默认运行时接管。 */
  private runtimeFor(assignment: Assignment): WorkerRuntime {
    return this.runtimes.get(assignment.runtimeId)
  }

  /** 读一次中立活性；没有能力或查询失败时返回 null。 */
  private async statusOf(assignment: Assignment): Promise<AgentStatus | null> {
    const runtime = this.runtimeFor(assignment)
    if (!runtime.status) return null
    try {
      return await runtime.status(this.refOf(assignment))
    } catch (error) {
      // 查询失败按「未知」处理，但必须留痕：否则空闲判定会静默失效。
      this.logger.warn('worker:status-failed', {
        ticketId: assignment.ticketId,
        handle: assignment.handle,
        runtime: assignment.runtimeId,
        message: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  /** 生成「在终端恢复最新会话」的命令；数据来自共享 meta + 静态运行时映射。 */
  async resumeHint(ticketId: string): Promise<ResumeHint | null> {
    const assignment = this.store.latestAssignment(ticketId)
    // pending / 刚手工重绑时 handle 为空，此时旧 meta 不可信。
    if (!assignment?.handle) return null

    const meta = readWorkerMeta(join(this.config.home, 'workers'), ticketId)
    if (!meta) return null

    // meta 属于上一运行时/上一派工时，不能拿来给本次派工拼命令。
    const metaRuntime = typeof meta.runtime === 'string' ? meta.runtime : ''
    if (metaRuntime && normalizeRuntimeId(metaRuntime) !== normalizeRuntimeId(assignment.runtimeId)) {
      return null
    }

    const workdir = (typeof meta.workdir === 'string' && meta.workdir) || assignment.workdir
    if (!workdir) return null

    const runtimeId = metaRuntime || assignment.runtimeId
    let sessionId = typeof meta.sessionId === 'string' && meta.sessionId ? meta.sessionId : undefined
    // 恢复命令要用「真正在跑的那个 Agent」的语法：meta 里记了就用它，
    // 其次看配置，最后看这个 workdir 里到底是哪个 Agent 留下了会话。
    let agentId = typeof meta.agent === 'string' ? meta.agent : ''
    if (normalizeRuntimeId(runtimeId) === ORCA_RUNTIME_ID) {
      const configured = agentId || this.orcaAgentId()
      if (!sessionId) {
        // Orca 的 meta 只记录终端句柄；按 workdir 从 Agent 自己的会话记录里补出真实 session id。
        // 找不到记录时 resume 模块会退回 orca terminal switch。
        const resolved = resolveSession(workdir, configured, {
          ...(this.claudeProjectsDir ? { roots: { claude: this.claudeProjectsDir } } : {}),
        })
        sessionId = resolved?.reader.latestSessionId(workdir) ?? undefined
        agentId = resolved?.profile.id ?? configured
      } else {
        agentId = configured
      }
    }
    const handle = (typeof meta.handle === 'string' && meta.handle) || assignment.handle

    return buildResumeHint(
      runtimeId,
      {
        workdir,
        sessionId,
        handle,
        ...(agentId ? { agentId } : {}),
      },
      { workdirExists: existsSync(workdir) },
    )
  }

  /** Orca 派工时用的 Agent；没配置时取选项声明的默认值。 */
  private orcaAgentId(): string {
    return runtimeOptionString(this.config.runtime.options, ORCA_RUNTIME_ID, 'agent')
  }

  /**
   * 面板「批量清理工作区」：按运行时分组列出仍存在于磁盘上的工单工作区。
   *
   * 只看每张工单最新一次派工，避免已经被重派替换掉的旧目录被误当成在用；
   * 只有「已关闭工单 + 目录仍在 + 运行时可回收 + 没被其它在办工单占用」才标记为可清理。
   */
  listWorkspaces(): WorkspaceOverviewView {
    const latestByTicket = new Map<string, Assignment>()
    for (const assignment of this.store.listAssignments()) {
      if (!assignment.workdir) continue
      // listAssignments 按派工时间倒序，首条即该工单的最新派工。
      if (!latestByTicket.has(assignment.ticketId)) latestByTicket.set(assignment.ticketId, assignment)
    }

    const rows: Array<{ assignment: Assignment; ticket: Ticket; workdir: string }> = []
    const inUse = new Set<string>()
    for (const assignment of latestByTicket.values()) {
      const ticket = this.store.getTicket(assignment.ticketId)
      if (!ticket) continue
      const workdir = resolve(assignment.workdir)
      if (!this.isWorkspaceOnDisk(workdir)) continue
      if (ticket.stage !== 'done') inUse.add(workdir)
      rows.push({ assignment, ticket, workdir })
    }

    const groups = new Map<string, WorkspaceRuntimeGroupView>()
    for (const { assignment, ticket, workdir } of rows) {
      const runtimeId = normalizeRuntimeId(assignment.runtimeId)
      const runtime = this.runtimes.has(runtimeId) ? this.runtimes.get(runtimeId) : null
      const supported = Boolean(runtime?.removeWorkspace)
      const cleanable = ticket.stage === 'done' && supported && !inUse.has(workdir)
      const entry: WorkspaceEntryView = {
        assignmentId: assignment.id,
        ticketId: ticket.id,
        title: ticket.title,
        stage: ticket.stage,
        runtimeId,
        workdir,
        startedAt: assignment.startedAt,
        closedAt: ticket.closedAt ?? '',
        cleanable,
        ...(cleanable ? {} : {
          reason: ticket.stage !== 'done'
            ? '工单未关闭，工作区可能仍在使用'
            : !runtime
              ? '当前服务未注册该运行时'
              : !supported
                ? '该运行时不支持自动回收工作区'
                : '目录被其它在办工单占用',
        }),
      }
      const group = groups.get(runtimeId) ?? {
        runtimeId,
        label: workspaceRuntimeLabel(runtimeId),
        isDefault: normalizeRuntimeId(this.config.runtime.default) === runtimeId,
        supported,
        entries: [],
        cleanableCount: 0,
      }
      group.entries.push(entry)
      if (cleanable) group.cleanableCount += 1
      groups.set(runtimeId, group)
    }

    // 组顺序跟随运行时注册表（内置 → ACP 目录），历史 / 未注册 id 追加在后。
    const known = new Map(this.runtimes.ids().map((id, index) => [normalizeRuntimeId(id), index]))
    const runtimes = [...groups.values()].sort((a, b) => {
      const left = known.get(a.runtimeId) ?? Number.MAX_SAFE_INTEGER
      const right = known.get(b.runtimeId) ?? Number.MAX_SAFE_INTEGER
      return left === right ? a.runtimeId.localeCompare(b.runtimeId) : left - right
    })
    for (const group of runtimes) {
      // 可清理的排前面；其余保持派工时间倒序。
      group.entries.sort((a, b) => Number(b.cleanable) - Number(a.cleanable))
    }
    return {
      runtimes,
      cleanableCount: runtimes.reduce((sum, group) => sum + group.cleanableCount, 0),
    }
  }

  /**
   * 按勾选的工单批量回收工作区；每个工单交给它自己的运行时处理：
   * Orca 关终端 + 移除 worktree，Claude Code 删 agent view + 删 worktree，ACP 直接删 worktree。
   *
   * 不传 force：脏工作区交给 provider 拒绝，返回的 skipped 里带原因给面板展示。
   */
  async cleanupWorkspaces(request: WorkspaceCleanupRequest): Promise<WorkspaceCleanupResultView> {
    const overview = this.listWorkspaces()
    const result: WorkspaceCleanupResultView = { removed: [], skipped: [] }
    const ticketIds = [...new Set((request.ticketIds ?? []).map(String).filter(Boolean))]
    let targets: WorkspaceEntryView[] = []

    if (ticketIds.length > 0) {
      const byTicket = new Map(overview.runtimes.flatMap(group => group.entries).map(entry => [entry.ticketId, entry]))
      for (const ticketId of ticketIds) {
        const entry = byTicket.get(ticketId)
        if (!entry) {
          result.skipped.push({ ticketId, workdir: '', reason: '没有找到仍在磁盘上的工作区' })
          continue
        }
        if (!entry.cleanable) {
          result.skipped.push({ ticketId, workdir: entry.workdir, reason: entry.reason ?? '当前不可清理' })
          continue
        }
        targets.push(entry)
      }
    } else if (request.runtimeId?.trim()) {
      const id = normalizeRuntimeId(request.runtimeId.trim())
      if (!this.runtimes.has(id)) {
        throw new WorkerRuntimeError('runtime:unknown', `未知的 Worker 运行时: ${request.runtimeId}`)
      }
      targets = (overview.runtimes.find(group => group.runtimeId === id)?.entries ?? []).filter(entry => entry.cleanable)
    } else {
      throw new Error('请至少勾选一个工单，或指定要清理的运行时')
    }

    for (const entry of targets) {
      const assignment = this.store.getAssignment(entry.assignmentId)
      if (!assignment?.workdir) continue
      const runtimeId = normalizeRuntimeId(assignment.runtimeId)
      const runtime = this.runtimes.has(runtimeId) ? this.runtimes.get(runtimeId) : null
      if (!runtime?.removeWorkspace) {
        result.skipped.push({ ticketId: entry.ticketId, workdir: entry.workdir, reason: '该运行时不支持自动回收工作区' })
        continue
      }
      try {
        // 先关终端 / 停会话再删目录；早已不存在时 stop 失败不影响后续回收。
        if (assignment.handle) {
          try {
            await runtime.stop(this.refOf(assignment), 'workspace-cleanup')
          } catch (error) {
            this.logger.warn('workspace:bulk-stop-failed', {
              runtimeId,
              ticketId: entry.ticketId,
              handle: assignment.handle,
              message: error instanceof Error ? error.message : String(error),
            })
          }
        }
        await runtime.removeWorkspace(this.workspaceRefOf(assignment))
        this.store.markWorkspaceRemoved(entry.ticketId, this.clock.now())
        result.removed.push({ ticketId: entry.ticketId, workdir: entry.workdir })
        this.log('workspace:bulk-removed', entry.ticketId, { runtimeId, workdir: entry.workdir })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        result.skipped.push({ ticketId: entry.ticketId, workdir: entry.workdir, reason })
        this.logger.warn('workspace:bulk-skip', {
          runtimeId,
          ticketId: entry.ticketId,
          workdir: entry.workdir,
          reason,
        })
      }
    }
    this.logger.info('workspace:bulk-cleanup', {
      requested: ticketIds.length,
      removed: result.removed.length,
      skipped: result.skipped.length,
    })
    return result
  }

  /**
   * 定时任务：回收「已关闭工单」残留的 workspace。
   *
   * 关单只停 worker、不删目录；目录在这里按保留期统一回收（用户也可以随时在面板手动回收）。
   * 判定复用 `listWorkspaces()`：目录仍在磁盘 + 工单已关闭 + 运行时支持回收 + 没被在办工单占用；
   * 这里额外要求关单时间已经超过保留期。
   */
  async sweepClosedWorkspaces(nowMs: number = Date.parse(this.clock.now())): Promise<void> {
    if (!this.workspace.enabled || this.workspaceSweeping) return
    this.workspaceSweeping = true
    try {
      const keepMs = this.workspace.keepHours * 3_600_000
      const due = this.listWorkspaces().runtimes
        .flatMap(group => group.entries)
        .filter(entry => {
          if (!entry.cleanable || !entry.closedAt) return false
          const closedAt = Date.parse(entry.closedAt)
          return Number.isFinite(closedAt) && nowMs - closedAt >= keepMs
        })
        .map(entry => entry.ticketId)
      if (due.length === 0) return
      const result = await this.cleanupWorkspaces({ ticketIds: due })
      // 脏目录回收不掉时告诉发起人一次，避免目录一直留着却没人知道。
      for (const skipped of result.skipped) {
        const ticket = this.store.getTicket(skipped.ticketId)
        if (!ticket) continue
        this.notify(
          ticket,
          `工单「${ticket.title}」已关闭，但对应的 workspace 未能自动回收：${skipped.reason}\n`
          + '请在 Orca / git worktree 中确认（可能有未提交改动或目录已被占用），也可以在面板「清理工作区」里手动处理。',
          `workspace:sweep-skip:${skipped.ticketId}`,
        )
      }
      this.logger.info('workspace:sweep', {
        due: due.length,
        removed: result.removed.length,
        skipped: result.skipped.length,
        keepHours: this.workspace.keepHours,
      })
    } catch (error) {
      this.logger.warn('workspace:sweep-failed', {
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.workspaceSweeping = false
    }
  }

  /** 目录存在且不是根目录 / home：避免脏数据把系统目录交给 provider 回收。 */
  private isWorkspaceOnDisk(workdir: string): boolean {
    if (!workdir || !workdir.startsWith('/')) return false
    const abs = resolve(workdir)
    if (abs === '/') return false
    if (this.config.home && abs === resolve(this.config.home)) return false
    if (abs === resolve(homedir())) return false
    return existsSync(abs)
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
    // 闲置治理计时基线：服务启动前就已经闲置的工单不补发通知，计时从启动时刻重新开始。
    const baseline = Date.parse(this.clock.now())
    this.retentionBaselineMs = Number.isFinite(baseline) ? baseline : Date.now()
    this.logger.info('retention:baseline', {
      baselineAt: new Date(this.retentionBaselineMs).toISOString(),
      openTickets: this.store.listOpenTickets().length,
    })
    await this.recover()
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
    every(60_000, () => this.sweepQuestions())
    if (this.config.router.session.enabled) {
      every(60_000, async () => { await this.decisionEngine.evictIdleSessions?.(Date.now()) })
      if (this.config.router.session.retentionDays > 0) {
        every(this.config.router.session.cleanupIntervalHours * 3_600_000, async () => { await this.cleanupChatSessions() })
      }
    }
    if (this.progressSyncMs > 0) every(this.progressSyncMs, () => this.syncProgress())
    if (this.progressProbeMs > 0) every(this.progressProbeMs, () => this.probeProgress())
    if (this.retention.enabled) every(this.retention.sweepMinutes * 60_000, () => this.sweepRetention())
    if (this.workspace.enabled) every(this.workspace.sweepMinutes * 60_000, () => this.sweepClosedWorkspaces())
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    this.running = false
    void this.decisionEngine.disposeAllSessions?.().catch(() => {})
  }

  /**
   * 清理 /new 之后超过保留期的旧 session 文件。
   * 只删 superseded 且路径位于 sessions 根目录下的文件，审计记录保留。
   */
  async cleanupChatSessions(): Promise<number> {
    const session = this.config.router.session
    if (!session.enabled || session.retentionDays <= 0) return 0
    const root = resolve(session.dir || join(this.config.home, 'sessions'))
    const nowMs = Date.parse(this.clock.now())
    const baseMs = Number.isFinite(nowMs) ? nowMs : Date.now()
    const before = new Date(baseMs - session.retentionDays * 86_400_000).toISOString()
    let removed = 0
    for (const record of this.store.listSupersededChatSessions(before)) {
      const file = resolve(record.sessionFile)
      if (!file.startsWith(`${root}/`)) {
        this.logger.warn('session:cleanup:skip', { file, root })
        continue
      }
      try {
        rmSync(file, { force: true })
        this.store.markChatSessionPurged(record.sessionFile, this.clock.now())
        removed += 1
      } catch (error) {
        this.logger.warn('session:cleanup:failed', {
          file,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (removed > 0) this.logger.info('session:cleanup', { removed })
    return removed
  }

  // ---------- 派工 ----------

  /** 把所有 todo 阶段、且还有并发额度的工单派出去。 */
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
      if (ticket.stage !== 'todo') continue
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
    const waiting = this.store.listOpenTickets().filter(ticket => ticket.stage === 'todo')
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
    // 旧工单沿用创建时的运行时；新工单用默认运行时。
    const latest = this.store.latestAssignment(ticket.id)
    const runtimeId = latest?.runtimeId && this.runtimes.has(latest.runtimeId)
      ? normalizeRuntimeId(latest.runtimeId)
      : this.runtimes.default().id
    const runtime = this.runtimes.get(runtimeId)
    const assignment = this.engine.startAssignment(ticket.id, {
      runtimeId,
      handle: '',
      workdir: '',
    })
    // 进展同步从派工这一刻起算：首次派工用起点标记，重启重派则沿用/回落到最新报告。
    if (this.store.getCursor(progressCursorKey(ticket.id)) === null) {
      const latest = this.store.latestReport(ticket.id)
      this.store.setCursor(progressCursorKey(ticket.id), latest?.id ?? PROGRESS_FROM_START, this.clock.now())
    }
    const workerDir = join(this.config.home, 'workers', ticket.id)
    mkdirSync(workerDir, { recursive: true })
    const statePath = join(workerDir, 'state.json')
    const eventsPath = join(workerDir, 'events.log')
    const branchName = workBranch(ticket)
    // 授权范围用研判结论（mandate.scope），不是标题：标题只有一句话，
    // scope 才带「允许做什么 / 不允许做什么」的口径。
    const mandate = this.store.getMandate(ticket.mandateId)
    const scope = mandate?.scope?.trim() || ticket.title
    const skillMode = this.config.worker.skill.mode
    const skill = skillMode === 'path' ? workerSkillSnapshot(this.config.home) : undefined
    // inline 是回滚开关：旧会话仍能拿到完整手册，行为与拆分前一致。
    const contract = skillMode === 'path'
      ? buildWorkerBrief({
          ticketId: ticket.id,
          title: ticket.title,
          scope,
          ...(ticket.request ? { request: ticket.request } : {}),
          ...(ticket.requestActorName ? { requestActorName: ticket.requestActorName } : {}),
          ...(ticket.requestAt ? { requestAt: ticket.requestAt } : {}),
          repo: ticket.repo,
          branch: ticket.branch,
          workBranch: branchName,
          workdir: '',
          workerDir,
          skillDir: workerSkillDir(this.config.home),
          ...(skill ? { skill: { name: skill.name, version: skill.version, sha256: skill.sha256 } } : {}),
          ...(ticket.request ? { requestPath: join(workerDir, 'request.md') } : {}),
          attachments: ticket.attachments ?? [],
        })
      : runtime.id === ORCA_RUNTIME_ID
        ? buildWorkerPrompt({
            ticket,
            mandateScope: scope,
            statePath,
            eventsPath,
            repo: ticket.repo,
            branch: ticket.branch,
            workBranch: branchName,
            workdir: '',
            home: this.config.home,
          })
        : buildNeutralContract({
            ticketId: ticket.id,
            title: ticket.title,
            scope,
            repo: ticket.repo,
            branch: ticket.branch,
            workBranch: branchName,
            workdir: '',
            statePath,
            eventsPath,
            attachments: ticket.attachments ?? [],
            home: this.config.home,
          })
    // 原话可能很长，落盘一份供 worker 读全文。
    if (ticket.request) {
      try {
        writeFileSync(join(workerDir, 'request.md'), ticket.request, 'utf8')
      } catch (error) {
        this.logger.warn('launch:request-write-failed', {
          ticketId: ticket.id,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const ctx: WorkerContext = {
      ticket,
      assignment,
      workdir: '',
      report: { statePath, eventsPath },
      brief: {
        ticketId: ticket.id,
        title: ticket.title,
        scope,
        workBranch: branchName,
        contract,
      },
      tools: this.config.worker.tools,
    }
    try {
      const started = await runtime.start(ctx)
      const updated: Assignment = { ...assignment, handle: started.handle, workdir: started.workdir }
      this.store.updateAssignment(updated)
      this.engine.refreshStage(ticket.id)
      this.clearLaunchFailure(ticket.id)
      this.queueNotified.delete(ticket.id)
      this.log('launch', ticket.id, { handle: started.handle, workdir: started.workdir, skillMode })
      this.log('launch:skill', ticket.id, {
        mode: skillMode,
        ...(skill ? { name: skill.name, version: skill.version, sha256: skill.sha256 } : {}),
      })
      if (skill) this.recordSkillMeta(workerDir, skill)
      return updated
    } catch (error) {
      // launch 半成功：把已创建的 workdir 落库，后续 cleanup 才能回收。
      const failedWorkdir = error instanceof WorkerRuntimeError && typeof error.detail?.workdir === 'string'
        ? String(error.detail.workdir)
        : assignment.workdir
      this.store.updateAssignment({ ...assignment, workdir: failedWorkdir, status: 'ended', endedAt: this.clock.now() })
      if (failedWorkdir) this.enqueueWorkspaceCleanup(ticket, 'launch-failed')
      this.reportLaunchFailure(ticket, error)
      throw error
    }
  }

  /**
  * 把本次生效的技能指纹合并进 runtime 已写好的 meta.json。
  *
  * 各运行时在 start() 里先写自己的会话信息；这里只补字段，不覆盖已有内容。
  */
  private recordSkillMeta(workerDir: string, skill: WorkerSkillSnapshot): void {
    const path = join(workerDir, 'meta.json')
    // 没有 meta 说明运行时没真正记下会话；此时补建空壳会让 resumeHint 误判。
    if (!existsSync(path)) return
    try {
      const existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      writeFileSync(path, `${JSON.stringify({
        ...existing,
        skillName: skill.name,
        skillVersion: skill.version,
        skillSha256: skill.sha256,
        skillPath: skill.path,
      }, null, 2)}\n`, 'utf8')
    } catch (error) {
      this.logger.warn('launch:skill-meta-failed', {
        workdir: workerDir,
        detail: errorMessage(error),
      })
    }
  }

  /**
   * 派工失败统一收口：完整日志 + 转人工（释放并发额度）+ 飞书话题反馈。
   * 此前只把 assignment 标记 ended，工单会永远停在 running：既不再重试，又一直占着 maxWorkers。
   */
  private reportLaunchFailure(ticket: Ticket, error: unknown): void {
    const failure = describeLaunchError(error)
    const previous = this.loadLaunchFailure(ticket.id)
    const attempts = (previous?.attempts ?? 0) + 1
    const lastSeq = this.store.pendingInputs(ticket.id).reduce((max, input) => Math.max(max, input.seq), 0)
    this.saveLaunchFailure(ticket.id, { attempts, lastSeq, lastReason: failure.reason })

    // 运行时能说清原因时用它（例如「provider 与 model 要成对」），否则退回通用的仓库/分支兜底。
    const hint = failure.hint
      ?? `请确认项目「${ticket.repo}」与起始分支「${ticket.branch}」存在；修正后在本话题回复任意内容即可重试`
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
      ...(failure.providerCode ? { providerCode: failure.providerCode } : {}),
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
        ...(failure.providerCode ? [`错误码：${failure.providerCode}`] : []),
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
    } catch (error) {
      this.logger.warn('cursor:invalid', { key: launchFailureCursorKey(ticketId), message: error instanceof Error ? error.message : String(error) })
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
    return this.store.listOpenTickets().filter(t => t.stage === 'running').length
  }

  async deliverPendingInputs(): Promise<void> {
    for (const ticket of this.store.listOpenTickets()) {
      if (ticket.stage === 'done') continue
      let assignment = this.store.latestAssignment(ticket.id)
      const pending = this.store.pendingInputs(ticket.id)
      const unacked = this.store.unackedInputs(ticket.id)
      if (pending.length === 0 && unacked.length === 0) continue
      const nowMs = Date.parse(this.clock.now())
      const cooldownUntil = this.deliveryCooldown.get(ticket.id) ?? 0
      // 没有活着的 worker：新输入视为「重试派工」信号。
      // 这条路径有自己的 seq 水位去重，不能被投递退避挡住。
      if (!assignment || assignment.status === 'ended' || !assignment.handle) {
        await this.relaunchForInput(ticket)
        continue
      }
      // 只有「确实有新 seq 的输入」才允许立即投递；同一批 pending 必须走退避。
      // 否则 deliver 抛错时 input 仍是 pending，会绕过退避每轮重试（Claude 会反复 resume）。
      const maxPendingSeq = pending.at(-1)?.seq ?? 0
      const attemptedSeq = this.deliveryAttemptedSeq.get(ticket.id) ?? 0
      const hasNewerPending = maxPendingSeq > attemptedSeq
      if (!hasNewerPending && Number.isFinite(nowMs) && cooldownUntil > nowMs) continue
      // 已经送进终端、只是还没 ack 的输入不再重发原文：重发会把同一条消息重复灌进
      // worker 上下文（同一段话在 worker 侧出现多次，tk-85）。改成只等 ack，超时提示人工。
      this.noteUnackedInputs(ticket, unacked, nowMs)
      if (pending.length === 0) {
        continue
      }
      // 逐条投递：一条失败不影响其它输入，也能准确知道是哪条没送到。
      const runtime = this.runtimeFor(assignment)
      const delivered: Input[] = []
      for (const input of pending) {
        const attempt = (this.deliveryAttempts.get(input.id) ?? 0) + 1
        if (attempt > MAX_DELIVERY_ATTEMPTS) {
          // 重投到上限还没送出去：转人工，这条输入不再重投。
          this.store.expireInput(ticket.id, input.id)
          this.deliveryAttempts.delete(input.id)
          this.engine.setAttention(ticket.id, `输入 ${input.id} 已重投 ${MAX_DELIVERY_ATTEMPTS} 次仍未成功，请人工确认`)
          this.logger.warn('input:redeliver-giveup', { ticketId: ticket.id, inputId: input.id, attempt: MAX_DELIVERY_ATTEMPTS })
          continue
        }
        try {
          const receipt = await runtime.deliver(
            this.refOf(assignment),
            [{ id: input.id, kind: input.kind, text: input.text }],
            { attempt, redeliver: attempt > 1 },
          )
          if (receipt.status === 'queued') {
            // worker 只是忙，不算一次失败的投递尝试；否则长回合会被误判 giveup。
            this.deliveryCooldown.set(ticket.id, nowMs + 30_000)
            this.deliveryAttemptedSeq.set(ticket.id, Math.max(this.deliveryAttemptedSeq.get(ticket.id) ?? 0, input.seq))
            this.log('input:queued', ticket.id, { count: 1, inputId: input.id, reason: receipt.reason ?? 'runtime-busy' })
            break
          }
          if (receipt.status === 'rejected') {
            // Agent 停在交互式提示上（如 Codex 的版本更新浮层）：Router 代答不了，
            // 立刻转人工并通知话题，否则工单只会一直卡着没人知道。
            if (receipt.needsHuman) {
              this.engine.setAttention(
                ticket.id,
                `Agent 停在交互式提示上，需要人工处理${receipt.detail ? '：' + receipt.detail : ''}`,
              )
              // 同一轮里反复重投不重复打扰；下一轮再卡住才重新通知。
              const turn = this.store.latestReport(ticket.id)?.turn ?? 0
              this.notify(
                ticket,
                `工单「${ticket.title}」的 Agent 停在交互式提示上（例如 Codex 的版本更新选择），Router 无法代答，请到 Orca 终端手动选一下，处理完在本话题回复即可继续。`,
                `prompt-blocked:${ticket.id}:${turn}`,
              )
              this.logger.warn('input:prompt-blocked', {
                ticketId: ticket.id,
                inputId: input.id,
                reason: receipt.reason,
                attempt,
                detail: receipt.detail ?? '',
              })
            }
            if (receipt.retryable === false) {
              this.handleLostWorker(ticket, `input-rejected:${receipt.reason}`)
              break
            }
            this.deliveryCooldown.set(ticket.id, nowMs + (receipt.retryAfterMs ?? 60_000))
            this.logger.warn('input:rejected', { ticketId: ticket.id, inputId: input.id, reason: receipt.reason })
            break
          }
          // 送达：这条输入不再重投，计数清零。
          this.deliveryAttempts.delete(input.id)
          this.store.markInputsDelivered(ticket.id, [input.id], this.clock.now())
          this.deliveryAttemptedSeq.set(ticket.id, Math.max(this.deliveryAttemptedSeq.get(ticket.id) ?? 0, input.seq))
          delivered.push(input)
          if (receipt.handle && receipt.handle !== assignment.handle) {
            // 运行时接管了新会话（Claude resume fork）：持久化新 handle，后续 status/stop 才命中。
            const from = assignment.handle
            assignment = { ...assignment, handle: receipt.handle }
            this.store.updateAssignment(assignment)
            this.log('input:adopted-handle', ticket.id, {
              from,
              to: receipt.handle,
              ...(receipt.sessionId ? { sessionId: receipt.sessionId } : {}),
            })
          }
        } catch (error) {
          // 抛错也代表一次真实投递尝试：必须累计，否则重投上限永远触发不了。
          this.deliveryAttempts.set(input.id, attempt)
          this.deliveryAttemptedSeq.set(ticket.id, Math.max(this.deliveryAttemptedSeq.get(ticket.id) ?? 0, input.seq))
          const backoffMs = Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 10 * 60_000)
          this.deliveryCooldown.set(ticket.id, nowMs + backoffMs)
          // 终端被删掉时 send 会一直失败；先确认会话是否还在，别每秒重试。
          if (await this.workerGone(assignment)) {
            this.handleLostWorker(ticket, 'input-deliver-failed')
            break
          }
          this.logger.warn('input:deliver-failed', {
            ticketId: ticket.id,
            inputId: input.id,
            attempt,
            message: errorMessage(error),
          })
        }
      }
      if (delivered.length > 0) {
        this.log('input:delivered', ticket.id, {
          count: delivered.length,
          inputIds: delivered.map(item => item.id),
          text: preview(delivered.map(item => item.text).join(' / ')),
        })
      }
    }
  }

  /**
   * 已投递但一直没 ack 的输入：记一条 warn 提示人工看一眼。
   *
   * 不再把原文重投给 worker —— 同一段话重复灌进 worker 上下文只会污染它的判断（tk-85）。
   */
  private noteUnackedInputs(ticket: Ticket, unacked: Input[], nowMs: number): void {
    const oldest = unacked.at(0)
    if (!oldest) return
    const deliveredMs = Date.parse(oldest.deliveredAt ?? '')
    if (!Number.isFinite(deliveredMs) || nowMs - deliveredMs < UNACKED_TIMEOUT_MS) return
    const key = unackedNoticeCursorKey(oldest.id)
    if (this.store.getCursor(key) !== null) return
    this.store.setCursor(key, String(nowMs), this.clock.now())
    this.logger.warn('input:unacked-timeout', {
      ticketId: ticket.id,
      inputId: oldest.id,
      waitedMs: nowMs - deliveredMs,
    })
  }

  /**
   * 旧 worker 已结束、但有新输入时重新派工。
   *
   * 只对「上次失败 / 丢失之后新到的输入」触发，避免同一批积压输入每秒重试打爆 Orca。
   * 两个水位任一挡住都不许重建：
   *   - 派工失败：失败水位记录当时积压的最大 seq，同一批输入不再重试；
   *   - 重新派工：上一次为积压输入重建 worker 时处理到的 seq，同一批输入只重建一次。
   * worker 丢失时已投递未 ack 的输入会被标成 expired，不再算作「新输入」（tk-51）。
   */
  private async relaunchForInput(ticket: Ticket): Promise<void> {
    // 只认 pending：worker 丢失时已投递未 ack 的输入已经标成 expired，
    // 用户新发的消息才会是 pending 且 seq 更大。
    const pending = this.store.pendingInputs(ticket.id)
    const failure = this.loadLaunchFailure(ticket.id)
    const relaunchSeq = this.loadRelaunchSeq(ticket.id)
    const candidates = pending.filter(input => input.seq > relaunchSeq && input.seq > (failure?.lastSeq ?? 0))
    if (candidates.length === 0) return
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
      // 记下这次处理到的最大 seq：新 worker 仍投递失败时不会再触发一次重建。
      const maxSeq = candidates.reduce((max, input) => Math.max(max, input.seq), 0)
      this.saveRelaunchSeq(ticket.id, maxSeq)
      this.log('input:relaunch', ticket.id, { pending: pending.length })
    } catch {
      // launch() 内部已记录原因、转人工并通知发起人。
    }
  }

  /** 读取重新派工水位；没有记录时返回 0。 */
  private loadRelaunchSeq(ticketId: string): number {
    const raw = this.store.getCursor(relaunchCursorKey(ticketId))
    if (!raw) return 0
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : 0
  }

  private saveRelaunchSeq(ticketId: string, seq: number): void {
    this.store.setCursor(relaunchCursorKey(ticketId), String(seq), this.clock.now())
  }

  // ---------- 空闲与失联 ----------

  /**
   * 用中立 AgentStatus 判断 worker 是否空闲：
   * 长时间无活动 → nudge（仅支持的运行时）；仍然无响应 → 标 stale 并通知人。
   */
  async checkIdle(nowMs: number = Date.parse(this.clock.now())): Promise<void> {
    for (const ticket of this.store.listOpenTickets()) {
      if (ticket.stage !== 'running') continue
      const assignment = this.store.latestAssignment(ticket.id)
      if (!assignment?.handle || assignment.status === 'ended') continue
      const runtime = this.runtimeFor(assignment)
      if (!runtime.status) continue
      const status = await this.statusOf(assignment)
      const verdict = classifyAgentStatus(status)
      if (verdict === 'unknown') continue
      if (verdict === 'lost') {
        this.handleLostWorker(ticket, 'status-lost')
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

      if (verdict === 'transfer') {
        if (!current.transferred) {
          current.transferred = true
          this.store.setCursor(zombieCursorKey(ticket.id), String(nowMs), this.clock.now())
          this.engine.setAttention(ticket.id, 'worker 已退出且无法恢复，请人工确认')
          this.notify(ticket, `工单「${ticket.title}」的 worker 已退出且无法自动恢复，已转人工处理。`, `transfer:${ticket.id}:${turn}`)
          this.log('idle:transfer', ticket.id, {})
        }
        continue
      }

      if (status?.phase === 'blocked') {
        if (!current.blocked) {
          current.blocked = true
          const waitingFor = status.detail?.waitingFor ?? '权限/输入'
          this.engine.setAttention(ticket.id, `worker 正在等待人工处理：${waitingFor}`)
          this.notify(ticket, `工单「${ticket.title}」的 worker 正在等待人工处理（${waitingFor}），请到 Claude 会话或 Orca 终端确认。`, `blocked:${ticket.id}:${turn}`)
          this.log('idle:blocked', ticket.id, { detail: status.detail })
        }
        continue
      }

      // keep：用 lastActivityAt 判断是否 idle；没有时间戳就不主动 nudge。
      const lastActivity = Date.parse(status?.lastActivityAt ?? '')
      if (!Number.isFinite(lastActivity) || nowMs - lastActivity <= this.idleAfterMs) continue

      if (!current.nudgedAt) {
        if (runtime.nudge) {
          await runtime.nudge(this.refOf(assignment))
          current.nudgedAt = nowMs
          this.log('idle:nudge', ticket.id, { handle: assignment.handle })
        } else if (nowMs - lastActivity > this.idleAfterMs + this.staleAfterMs) {
          // 没有唤醒能力的运行时（Claude/Codex）：直接按活动时间判 stale。
          this.markIdleStale(ticket, nowMs)
        }
        continue
      }

      if (!current.stale && nowMs - current.nudgedAt > this.staleAfterMs) {
        this.markIdleStale(ticket, nowMs)
      }
    }
  }

  private markIdleStale(ticket: Ticket, nowMs: number): void {
    const state = this.idle.get(ticket.id)
    if (state?.stale) return
    if (state) state.stale = true
    // 标记为僵尸：闲置治理只转人工，不再提醒关单、不自动关闭。
    this.store.setCursor(zombieCursorKey(ticket.id), String(nowMs), this.clock.now())
    this.engine.setAttention(ticket.id, 'worker 无响应：长时间没有新的 state.json 上报，已标记 stale，请人工确认')
    this.notify(ticket, `工单「${ticket.title}」的 worker 无响应，已标记 stale，请到 Orca / Claude 会话确认。`, `stale:${ticket.id}`)
    this.log('idle:stale', ticket.id, {})
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
    const idleMs = this.retention.idleHours * 3_600_000
    const graceMs = this.retention.closeGraceHours * 3_600_000
    const zombieMs = this.retention.zombieHours * 3_600_000
    const lastProgress = this.lastProgressAt(ticket)
    // 启动基线：服务启动前就已经没有进展的工单，闲置计时从启动时刻重新开始，
    // 避免启动后的第一轮巡检把积压的工单一次性补发提醒 / 催办 / 关单通知。
    const idleSince = Math.max(lastProgress, this.retentionBaselineMs)

    // 1) 僵尸进程：先转人工，明确不自动关闭。
    if ((ticket.stage === 'running') && (await this.isZombie(ticket, nowMs, zombieMs, idleSince))) {
      this.markZombie(ticket)
      return
    }

    // 提醒/催办之后又有了新进展：清掉水位，这一轮不重复打扰。
    if (this.clearRetentionMarksOnProgress(ticket, lastProgress)) return

    // 3) 已经转过人工的僵尸工单：不再提醒、不再自动关闭，直到出现新的进展。
    if (this.store.getCursor(zombieCursorKey(ticket.id)) !== null) return

    if (nowMs - idleSince < idleMs) return

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
    // 启动前发出的提醒：不再补发，但关单时间跟着启动基线重排，
    // 和「新提醒」的节奏一致（启动后 idleHours + closeGraceHours 才关单）。
    const closeAt = this.retentionBaselineMs > 0
      ? Math.max(reminder.closeAt, this.retentionBaselineMs + idleMs + graceMs)
      : reminder.closeAt
    if (nowMs < closeAt) return
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
  private async isZombie(ticket: Ticket, nowMs: number, zombieMs: number, idleSince: number): Promise<boolean> {
    const assignment = this.store.latestAssignment(ticket.id)
    if (!assignment || assignment.status === 'ended') return false
    if (nowMs - idleSince < zombieMs) return false
    const runtime = this.runtimeFor(assignment)
    if (!assignment.handle || !runtime.status) return false
    const status = await this.statusOf(assignment)
    const verdict = classifyAgentStatus(status)
    if (verdict === 'unknown') return false
    if (verdict === 'lost' || verdict === 'transfer') return true
    if (status?.phase === 'blocked') return false
    const activity = Date.parse(status?.lastActivityAt ?? '')
    // 进程还活着但拿不到活动时间：不误判成僵尸。
    if (!Number.isFinite(activity)) return false
    return nowMs - activity >= zombieMs
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
    } catch (error) {
      this.logger.warn('cursor:invalid', { key: reminderCursorKey(ticketId), message: error instanceof Error ? error.message : String(error) })
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
      `如果还需要继续，请直接在本话题回复任意内容；否则 ${this.retention.closeGraceHours} 小时后将自动关闭，`
      + `workspace 会保留 ${this.workspace.keepHours} 小时后自动回收。`,
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
    // 关单只停 worker：目录保留，由定时任务按保留期回收（或用户手动回收）。
    this.enqueueStopWorker(closed, 'idle')
    this.notify(
      closed,
      `工单「${closed.title}」已 ${this.retention.idleHours} 小时无进展且 ${this.retention.closeGraceHours} 小时未回复，已自动关闭。`
      + `workspace 会保留 ${this.workspace.keepHours} 小时后自动回收，也可以随时手动回收。`,
      `retention:closed:${closed.id}`,
    )
    this.log('retention:closed', closed.id, { reason: 'idle' })
  }

  /**
   * 投递「只停 worker」的收尾任务：闲置超时自动关单走这里。
   * 目录不删 —— 关单和回收 workspace 是两件事，回收交给定时任务或用户手动触发。
   */
  private enqueueStopWorker(ticket: Ticket, source: string): void {
    const queued = this.store.enqueueEffect({
      id: `ef_stop_${ticket.id}`,
      key: `stop:${ticket.id}`,
      kind: 'stop-worker',
      payload: { ticketId: ticket.id },
      now: this.clock.now(),
    })
    // 队列按 id 去重，重复入队时不重复打日志。
    if (queued) this.log('worker:stop-queued', ticket.id, { source })
  }

  /**
   * 投递 workspace 回收任务。只有「人工停止」和「派工半成功」走这里：
   * 前者是用户明确表示不要这个目录了，后者是工单仍在办的脏目录。
   * 自动关单只停 worker，目录由定时任务（`sweepClosedWorkspaces`）按保留期回收。
   */
  private enqueueWorkspaceCleanup(ticket: Ticket, source: string): void {
    const suffix = ticket.closedAt ?? this.clock.now()
    const queued = this.store.enqueueEffect({
      id: `ef_cleanup_${ticket.id}_${suffix.replace(/[^0-9a-zA-Z]/g, '')}`,
      key: `cleanup-workspace:${ticket.id}:${suffix}`,
      kind: 'cleanup-workspace',
      payload: { ticketId: ticket.id },
      now: this.clock.now(),
    })
    // 队列去重时不重复打日志，避免 PR 轮询反复命中同一张单。
    if (queued) this.log('cleanup:queued', ticket.id, { source })
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
    const runtime = this.runtimeFor(assignment)
    if (assignment.handle) {
      try {
        await runtime.stop(this.refOf(assignment), 'workspace-cleanup')
      } catch (error) {
        this.logger.warn('cleanup:stop-failed', {
          ticketId,
          handle: assignment.handle,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (!assignment.workdir) return
    if (!runtime.removeWorkspace) {
      this.log('cleanup:no-remove-capability', ticketId, { workdir: assignment.workdir })
      return
    }
    try {
      // 不带 force：脏工作区交给 provider 拒绝，避免误删未提交改动。
      await runtime.removeWorkspace(this.workspaceRefOf(assignment))
      this.store.markWorkspaceRemoved(ticketId, this.clock.now())
      this.log('cleanup:worktree-removed', ticketId, { workdir: assignment.workdir })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isCleanupSkipError(message) || attempts >= 3) {
        this.logger.warn('cleanup:worktree-skipped', { ticketId, workdir: assignment.workdir, reason: message, attempts })
        if (ticket) {
          // 工作区没能自动回收时告诉发起人，避免以为代码已经清掉了。
          this.notify(
            ticket,
            `工单「${ticket.title}」已关闭，但对应的 workspace 未能自动回收：${message}\n请在 Orca / git worktree 中确认（可能有未提交改动或目录已被占用）。`,
            `cleanup-skip:${ticketId}`,
          )
        }
        return
      }
      throw error
    }
  }

  // ---------- 上报 ----------

  /**
   * 带证据门禁的上报入口：HTTP 与 state.json 兜底通道都走这里。
   * 门禁只拦 `ready`；`blocked` / `progress` 等原样放行。
   */
  async ingestWorkerState(state: WorkerStateFile, meta?: WorkerMeta): Promise<void> {
    await this.enforceUiEvidence(state)
    this.onWorkerState(state, meta)
  }

  /**
   * UI 工单报 ready 前检查 PR / MR 描述里的 Before / After 证据。
   * - mode=off / 非 ready / 非 UI 工单：直接放行；
   * - 无法判断（workdir 丢失、git / PR 查询失败）：放行并记 evidence-unverified，避免误杀；
   * - mode=warn：记 evidence-missing 但放行；
   * - mode=enforce：抛 ReportRejectedError，由 API 映射成 422。
   */
  private async enforceUiEvidence(state: WorkerStateFile): Promise<void> {
    const mode = this.config.worker.evidence.ui
    if (mode === 'off' || state.state !== 'ready') return
    const ticket = this.store.getTicket(state.ticketId)
    if (!ticket) return
    const assignment = (state.assignmentId ? this.store.getAssignment(state.assignmentId) : null)
      ?? this.store.latestAssignment(ticket.id)
    const decision = await evaluateUiEvidence(
      {
        state: state.state,
        summary: state.summary,
        prNumber: state.prNumber,
        prUrl: state.prUrl,
        ...(state.uiChange !== undefined ? { uiChange: state.uiChange } : {}),
      },
      {
        ticketId: ticket.id,
        repo: ticket.repo,
        branch: ticket.branch,
        ...(assignment?.workdir ? { workdir: assignment.workdir } : {}),
        mode,
      },
      {
        git: this.git,
        prView: (repo, number, hint) => this.prTracker.view(repo, number, hint),
      },
    )

    if (decision.unverified) {
      this.logger.warn('report:evidence-unverified', {
        ticketId: ticket.id,
        mode,
        unverified: decision.unverified,
        ...(decision.source ? { source: decision.source } : {}),
      })
      return
    }
    if (!decision.checked || !decision.ui) return

    if (decision.action === 'reject') {
      this.logger.warn('report:evidence-missing', decisionLogDetail(decision, { ticketId: ticket.id, mode }))
      throw new ReportRejectedError('evidence-missing', evidenceRejectedMessage(decision), {
        ticketId: ticket.id,
        missing: decision.missing,
        ...(decision.source ? { source: decision.source } : {}),
      })
    }
    if (decision.reason) {
      this.logger.warn('report:evidence-missing', decisionLogDetail(decision, { ticketId: ticket.id, mode }))
    }
  }

  /** 兜底通道没有 HTTP 响应可回：命中门禁时转人工，其他异常只记日志，不能丢上报。 */
  private handleIngestError(state: WorkerStateFile, error: unknown): void {
    if (error instanceof ReportRejectedError) {
      this.logger.warn('report:evidence-missing', {
        ticketId: state.ticketId,
        mode: this.config.worker.evidence.ui,
        action: 'reject',
        channel: 'state-file',
        message: error.message,
      })
      const ticket = this.store.getTicket(state.ticketId)
      if (ticket && ticket.stage !== 'done') {
        this.engine.setAttention(ticket.id, 'worker 上报 ready，但 UI 证据不足；请补齐 PR / MR 描述或确认接受')
        this.notify(
          ticket,
          `工单「${ticket.title}」的 worker 上报完成，但缺少 UI 的 Before / After 证据：${error.message}\n请补齐 PR / MR 描述后让 worker 重新上报，或在本话题确认是否接受。`,
          `evidence:${ticket.id}:${state.turn}`,
        )
      }
      return
    }
    this.logger.warn('report:ingest-failed', {
      ticketId: state.ticketId,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  /** Worker 通过 state.json 上报；poller 与测试都走这里。 */
  /**
   * 卡片按钮回调：把点选结果落成一条 Input，再回写卡片。
   *
   * 幂等：同一道题已答后重复点击只回写卡片，不再产生输入；过期或名单外直接拒绝。
   */
  async handleCardAction(action: CardAction): Promise<void> {
    const questionId = String(action.value.questionId ?? action.value.qid ?? '')
    if (!questionId) {
      this.logger.warn('question:rejected', { reason: 'missing-question', operator: action.operatorId, messageId: action.messageId })
      return
    }
    const question = this.store.getQuestion(questionId)
    if (!question) {
      this.logger.warn('question:rejected', { reason: 'unknown-question', questionId, operator: action.operatorId })
      return
    }
    const ticket = this.store.getTicket(question.ticketId)
    if (!ticket) {
      this.logger.warn('question:rejected', { reason: 'unknown-ticket', questionId, ticketId: question.ticketId })
      return
    }

    if (question.status === 'answered') {
      // 重复点击：卡片回写成已选，但不再投递第二条输入。
      await this.updateQuestionCard(ticket, question, question.answer?.split(',').filter(Boolean) ?? [], action, false)
      this.log('question:duplicate', ticket.id, { questionId, operator: action.operatorId })
      return
    }

    const now = this.clock.now()
    if (question.status === 'expired' || Date.parse(question.expiresAt) <= Date.parse(now)) {
      this.store.expireQuestion(questionId, now)
      await this.updateQuestionCard(ticket, question, [], action, true)
      this.log('question:rejected', ticket.id, { questionId, reason: 'expired', operator: action.operatorId })
      return
    }

    if (this.config.reply.ask.allow === 'requester') {
      const requester = this.store.getMandate(ticket.mandateId)?.actorId
      if (requester && requester !== action.operatorId) {
        // 名单外点击静默：只留审计日志，不给对方任何反馈。
        this.logger.warn('question:rejected', { ticketId: ticket.id, questionId, reason: 'not-requester', operator: action.operatorId })
        return
      }
    }

    const selected = selectedOptions(action.value)
    const unknown = selected.filter(id => !question.options.some(option => option.id === id))
    if (selected.length === 0 || unknown.length > 0) {
      this.logger.warn('question:rejected', { ticketId: ticket.id, questionId, reason: `invalid-option:${unknown.join(',') || 'none'}`, operator: action.operatorId })
      return
    }

    const labels = question.options
      .filter(option => selected.includes(option.id))
      .map(option => option.label)
    let input
    try {
      input = this.engine.deliverInput(ticket.id, {
        kind: 'followup',
        text: `问题「${question.prompt}」的答案：${labels.join('、')}（${selected.join(',')}）`,
        sourceKey: `question:${questionId}`,
      })
    } catch (error) {
      this.logger.warn('question:rejected', {
        ticketId: ticket.id,
        questionId,
        reason: 'input-failed',
        detail: errorMessage(error),
      })
      return
    }

    this.store.answerQuestion(questionId, selected.join(','), action.operatorId, now)
    await this.updateQuestionCard(ticket, question, selected, action, false)
    this.appendEventLog(ticket.id, { kind: 'question-answer', questionId, inputId: input.id, operator: action.operatorId, at: now })
    this.log('question:answered', ticket.id, {
      questionId,
      inputId: input.id,
      optionIds: selected,
      operator: action.operatorId,
    })
    // 用户正在等：立刻把答案投给 worker，不等下一轮 tick。
    void this.deliverPendingInputs().catch(error => {
      this.logger.warn('question:deliver-failed', { ticketId: ticket.id, questionId, detail: errorMessage(error) })
    })
  }

  /** 通道订阅卡片回调失败时登记降级，避免 auto 模式继续出无人能点的按钮。 */
  markCardActionsUnavailable(channelId: string): void {
    this.cardActionsUnavailable.add(channelId)
  }

  /** 到期未答的选择题：标 expired 并在话题里提醒一次，worker 下一轮自行决策。 */
  async sweepQuestions(): Promise<void> {
    const now = this.clock.now()
    const expired = this.store.expireQuestions(now, now)
    for (const question of expired) {
      const ticket = this.store.getTicket(question.ticketId)
      if (!ticket || ticket.stage === 'done') continue
      this.notify(
        ticket,
        `工单「${ticket.title}」的选择题已超时：${question.prompt}\nWorker 会在下一轮自行决策；如需重新选择，请直接回复说明。`,
        `question:expired:${question.id}`,
      )
      this.log('question:expired', ticket.id, { questionId: question.id, turn: question.turn })
    }
  }

  private async updateQuestionCard(
    ticket: Ticket,
    question: Question,
    selected: string[],
    action: CardAction,
    expired: boolean,
  ): Promise<void> {
    const adapter = this.channels?.get(ticket.channelId ?? DEFAULT_CHANNEL_ID)
    if (!adapter?.updateQuestionCard) {
      this.logger.warn('question:card-update-unavailable', {
        ticketId: ticket.id,
        questionId: question.id,
        channel: ticket.channelId ?? DEFAULT_CHANNEL_ID,
      })
      return
    }
    const replyQuestion: ReplyQuestion = {
      id: question.id,
      prompt: question.prompt,
      options: question.options,
      ...(question.multi ? { multi: true } : {}),
    }
    try {
      await adapter.updateQuestionCard({
        token: action.token,
        operatorId: action.operatorId,
        question: replyQuestion,
        selected,
        ...(expired ? { expired: true } : {}),
      })
    } catch (error) {
      this.logger.warn('question:card-update-failed', {
        ticketId: ticket.id,
        questionId: question.id,
        detail: errorMessage(error),
      })
    }
  }

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
    const replyPayload = state.replyPayload
    const reply = state.reply?.trim() || replyPayload?.fallbackText.trim() || ''
    const { report, ackedInputs } = this.engine.report(assignment.id, {
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
    // 只清真正落成 acked 的输入：worker 声称 ack 了但库里没匹配到时，
    // 清掉计数会让「重投 5 次放弃」永远触发不了（tk-51）。
    for (const id of ackedInputs) this.deliveryAttempts.delete(id)
    if (ackedInputs.length > 0) this.deliveryCooldown.delete(ticket.id)
    this.appendEventLog(ticket.id, { kind: 'report', state: state.state, turn: state.turn, at: state.updatedAt })
    this.log('report', ticket.id, {
      state: state.state,
      turn: state.turn,
      summary: preview(state.summary),
      ...(state.humanAction ? { humanAction: preview(state.humanAction) } : {}),
      ...(state.prNumber ? { pr: state.prNumber } : {}),
      ...(reply ? { replyChars: reply.length } : {}),
      ...(replyPayload ? { replyBlocks: replyPayload.blocks.length } : {}),
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
    if ((reply || replyPayload) && (state.state !== 'progress' || answersInput)) {
      // Worker 给了完整回复就原样发；正文里带文档链接 / PR 链接都照发，Router 不改写。
      const text = state.prUrl && !reply.includes(state.prUrl) ? `${reply}\n\nPR：${state.prUrl}` : reply
      if (replyPayload) {
        this.queuePayload(ticket, { ...replyPayload, fallbackText: text }, `reply:${ticket.id}:${reportKey}`, report.turn)
      } else {
        this.queueLong(ticket, '', text, `reply:${ticket.id}:${reportKey}`)
      }
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
   * 不依赖 worker 上报：定时读 worker 的会话记录 / Orca 终端，判断 worker 是否还在动，
   * 并把最近进展整理成语义摘要同步到工单话题。
   *
   * 覆盖两类场景：
   * - 执行中（running）但长时间没上报；
   * - 已 ready 进入 review/blocked 后，用户又发了新输入，worker 重新开工但阶段还没变。
   */
  async probeProgress(nowMs: number = Date.parse(this.clock.now())): Promise<void> {
    if (this.progressProbeMs <= 0 || this.probing) return
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
    const runtime = this.runtimeFor(assignment)
    if (!runtime.activity && !runtime.output) return

    const lastProgress = this.lastProgressAt(ticket)
    if (!lastProgress || nowMs - lastProgress < this.progressSilenceMs) return

    const record = this.readProbeRecord(ticket.id)
    const samePeriod = record !== null && record.lastProgressAt === lastProgress
    if (samePeriod && nowMs - record.lastPostAt < this.progressRepeatMs) return

    const status = await this.statusOf(assignment)
    if (status && !status.alive) return
    if (status?.phase === 'blocked') return

    // 首选 Agent 自己的结构化会话记录；没有（非 Claude / 文件未落盘）再退回输出尾部。
    const snapshot = assignment.workdir && runtime.activity
      ? await runtime.activity({ ref: this.refOf(assignment), opts: { maxEvents: 40 } })
      : null
    let snippet: string
    let source: 'session' | 'terminal'
    let lastActivityAt = Number.NaN
    if (snapshot && snapshot.events.length > 0) {
      snippet = extractSessionSnippet(snapshot.events)
      source = 'session'
      lastActivityAt = Date.parse(snapshot.at)
    } else {
      if (!runtime.output) return
      const output = await runtime.output(this.refOf(assignment), { limit: 60 })
      if (!output || output.status !== 'running') return
      snippet = extractTerminalSnippet(output.lines)
      source = 'terminal'
      lastActivityAt = status?.lastActivityAt ? Date.parse(status.lastActivityAt) : Number.NaN
    }

    const snippetHash = snippetFingerprint(snippet)
    const unchanged = samePeriod && record.snippetHash === snippetHash
    const count = samePeriod ? record.count + 1 : 1
    const lastOutputAt = status?.lastActivityAt ? Date.parse(status.lastActivityAt) : Number.NaN

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
    if (ticket.stage === 'running') return true
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
    } catch (error) {
      this.logger.warn('cursor:invalid', { key: probeCursorKey(ticketId), message: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  // ---------- 停止 ----------

  stopTicket(ticketId: string, reason: string): Ticket {
    const ticket = this.engine.stopTicket(ticketId, reason)
    // 人工停止是用户明确表达「不要这个目录了」：仍立即回收 workspace。
    // cleanup-workspace 会先停终端再删 worktree，比单独排 stop-worker 更完整。
    this.enqueueWorkspaceCleanup(ticket, 'stop')
    return ticket
  }

  // ---------- PR 闭环 ----------

  async trackPullRequests(): Promise<void> {
    for (const ticket of this.store.listOpenTickets()) {
      // 已合并的 PR 状态不会再变：工单保持开放，但没必要继续每 5 秒查一次。
      if (ticket.prState === 'merged') continue
      // 每张工单自带仓库，不再有全局 repo 兜底。
let repo = ticket.repo
      // 派工信息在下面多处要用（workdir 兜底、PR 查询提示），提前取一次。
      const assignment = this.store.latestAssignment(ticket.id)
      let prNumber = ticket.prNumber
      let prUrl = ticket.prUrl

      // 双保险之一：provider 直接给出的 PR 线索（Orca linkedPR），以及实际工作分支。
      let branch = ''
      if (!prNumber) {
        // 派工已结束或 worktree 被删时 provider 会返回 not-found，静默跳过，不要每 5 秒刷错误。
        if (assignment?.workdir && assignment.status !== 'ended') {
          const runtime = this.runtimeFor(assignment)
          // 本地路径仓库先解析成 owner/repo，否则 gh --repo 会失败。
          if ((repo.startsWith('/') || repo.startsWith('path:')) && runtime.repoSlug) {
            const slug = await runtime.repoSlug(this.refOf(assignment)).catch(error => {
              this.logger.warn('pr:repo-slug-failed', {
                ticketId: ticket.id,
                handle: assignment.handle,
                message: error instanceof Error ? error.message : String(error),
              })
              return null
            })
            if (slug) repo = slug
          }
          if (runtime.inspectWorkspace) {
            try {
              const workspace = await runtime.inspectWorkspace(this.workspaceRefOf(assignment))
              branch = workspace?.branch ?? ''
              const linked = workspace?.linkedPr
              if (linked && linked.number > 0) {
                prNumber = linked.number
                prUrl = linked.url || prUrl
                this.engine.updatePr(ticket.id, { number: prNumber, url: prUrl, state: 'open' })
                this.log('pr:linked', ticket.id, { number: prNumber, source: 'provider' })
              }
            } catch (error) {
              // worktree 不在了：等 gh 兜底或人工处理。
              this.logger.warn('pr:inspect-failed', {
                ticketId: ticket.id,
                handle: assignment.handle,
                message: error instanceof Error ? error.message : String(error),
              })
            }
          }
        }
      }

      // 双保险之二：按实际工作分支反查 PR/MR（没有 linkedPR 的运行时）。
      if (!prNumber && branch && repo) {
        const found = await this.prTracker.findByBranch(repo, branch, {
          ...(assignment?.workdir ? { cwd: assignment.workdir } : {}),
        })
        if (found) {
          prNumber = found.number
          prUrl = found.url || prUrl
          this.engine.updatePr(ticket.id, { number: prNumber, url: prUrl, state: found.state })
          this.log('pr:linked', ticket.id, { number: prNumber, source: 'branch' })
        }
      }

      // 双保险之三：gh / glab 查询。
      if (!prNumber || !repo) continue
      // repo 可能只是项目名或 path 选择器，不是 gh 要的 owner/name：
      // 把工单已有的 PR 链接和 workdir 一起传下去，避免状态永远停在 open。
      const hint = { ...(prUrl ? { url: prUrl } : {}), ...(assignment?.workdir ? { cwd: assignment.workdir } : {}) }
      const info = await this.prTracker.view(repo, prNumber, hint)
      if (!info) {
        this.warnPrTrackMiss(ticket, prNumber, repo)
        continue
      }

      const before = ticket.prState
      const updated = this.engine.updatePr(ticket.id, { number: info.number, url: info.url || ticket.prUrl, state: info.state })
      if (before !== info.state) this.log('pr:state', ticket.id, { from: before, to: info.state })

      // PR 终态不等于会话结束：合并或关闭后话题照常开着，用户追问还能接着推进。
      // 只有巡查判定长期无进展、或用户主动关闭时才会结束会话。
      if (before !== info.state && (info.state === 'merged' || info.state === 'closed') && updated.stage !== 'done') {
        appendEvent(join(this.config.home, 'workers', ticket.id, 'events.log'), { kind: 'pr', state: info.state, at: this.clock.now() })
        const label = info.state === 'merged' ? '已合并' : '已关闭'
        this.notify(
          updated,
          `工单「${updated.title}」的 PR ${info.url} ${label}。`
          + `工单保持开放，你在本话题继续回复就能接着推进；只有长期无进展被巡查关闭、或你主动关闭时才会结束会话。`,
          `pr:${ticket.id}:${info.state}`,
        )
      }
    }
  }

  /** 同一工单 + PR 只记一次查询失败，避免 5 秒轮询刷屏；状态恢复后清不掉也无妨。 */
  private warnPrTrackMiss(ticket: Ticket, prNumber: number, repo: string): void {
    const key = `pr:track-missed:${ticket.id}:${prNumber}`
    const now = this.clock.now()
    if (this.store.getCursor(key) !== null) return
    this.store.setCursor(key, now, now)
    this.logger.warn('pr:track-failed', {
      ticketId: ticket.id,
      prNumber,
      repo,
      message: 'PR/MR 状态查询无结果，工单会停在当前状态',
    })
  }

  // ---------- 重启对账 ----------

  async recover(): Promise<void> {
    for (const ticket of this.store.listOpenTickets()) {
      const assignment = this.store.latestAssignment(ticket.id)
      const runtime = assignment ? this.runtimeFor(assignment) : null
      if (assignment && assignment.status !== 'ended' && assignment.handle && runtime?.status) {
        const status = await this.statusOf(assignment)
        const verdict = classifyAgentStatus(status)
        if (verdict === 'unknown') continue
        if (verdict === 'lost') {
          this.handleLostWorker(ticket, 'recover')
          continue
        }
        if (verdict === 'transfer') {
          this.engine.setAttention(ticket.id, 'worker 已退出且无法自动恢复，请人工确认')
          this.notify(ticket, `工单「${ticket.title}」的 worker 已退出且无法自动恢复，已转人工处理。`, `recover:transfer:${ticket.id}`)
          continue
        }
        // ACP 等运行时的会话只存在内存里，重启后先接回；接不回才沿用 idle/stale 兜底。
        if (status?.phase === 'exited' && status.acceptingInput && runtime?.reattach) {
          const attached = await runtime.reattach(this.refOf(assignment)).catch(() => false)
          // 连接已恢复，重启前留下的 stale 提示不再成立；真闲置会在下一个巡检周期重新判。
          if (attached) this.engine.clearAttention(ticket.id)
          this.log('recover:reattach', ticket.id, { attached })
          // 接回来了不代表任务做完：worker 进程随服务一起死的那一轮可能停在半路。
          if (attached) await this.recoverInterruptedTurn(ticket, assignment, runtime)
        }
        this.log('recover:reuse', ticket.id, { handle: assignment.handle, phase: status?.phase })
        continue
      }
      if (ticket.stage !== 'done' && (!assignment || assignment.status === 'ended')) {
        if (ticket.stage === 'todo' || ticket.stage === 'running') {
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

  /**
   * 处理「worker 上一轮被服务重启打断」的情况。
   *
   * 只有 worker 进程随 Router 一起死的运行时（capabilities.agent.processExit=true）
   * 才需要：这类运行时重启后上一轮可能停在半路，任务并没有做完。
   * orca / claude-code 的 worker 活在自己的常驻服务里，重启期间照常干活，不该打扰。
   *
   * 两种处置（policy.interruptedRecovery 控制）：
   *   auto   —— 自动补一条输入，让 worker 自己检查现场后接着做；
   *   notify —— 发飞书提醒，等用户回复才恢复。
   */
  private async recoverInterruptedTurn(
    ticket: Ticket,
    assignment: Assignment,
    runtime: WorkerRuntime,
  ): Promise<void> {
    const mode = this.config.policy.interruptedRecovery
    if (mode === 'off') return
    // 进程不随 Router 死的运行时：任务没被打断，worker 还在跑，不需要恢复。
    if (!runtime.capabilities.agent.processExit) return
    if (!runtime.interruptedTurn) return

    const interrupted = await runtime.interruptedTurn(this.refOf(assignment)).catch(() => null)
    if (!interrupted) return

    const record = this.loadInterruptedRecord(ticket.id)
    // 同一个被中断的轮次只处理一次：反复重启不应反复恢复同一轮。
    if (record.turnIds.includes(interrupted.turnId)) return
    record.turnIds.push(interrupted.turnId)
    if (record.turnIds.length > 20) record.turnIds = record.turnIds.slice(-20)

    const summary = interrupted.summary
    this.logger.warn('recover:interrupted', {
      ticketId: ticket.id,
      turnId: interrupted.turnId,
      mode,
      autoRecovered: record.autoRecovered,
    })

    // 先告诉用户「任务被打断了」，无论后面是自动恢复还是等用户触发。
    this.notify(
      ticket,
      [
        `工单「${ticket.title}」的 worker 因服务重启被中断，上一轮没有跑完。`,
        ...(summary ? ['', `中断前已完成到：${summary}`] : []),
        '',
        '工作区未提交的改动都还在，回复「继续」即可从中断处接着做。',
      ].join('\n'),
      `recover:interrupted:${ticket.id}:${interrupted.turnId}`,
    )

    const canAutoRecover = mode === 'auto' && record.autoRecovered < this.config.policy.maxAutoRecover
    if (!canAutoRecover) {
      if (mode === 'auto') {
        // 自动恢复次数用完，降级为「等用户触发」，但要说明原因。
        this.notify(
          ticket,
          `工单「${ticket.title}」自动恢复次数已达上限（${this.config.policy.maxAutoRecover} 次），已改为等你回复「继续」再接着做。`,
          `recover:interrupted-cap:${ticket.id}:${interrupted.turnId}`,
        )
      }
      this.saveInterruptedRecord(ticket.id, record)
      return
    }

    // 自动恢复：补一条 retry 输入。走 deliverInput 才会落库，
    // 这样恢复动作可审计，且 worker 没 ack 时重启后还能再投一次。
    try {
      this.engine.deliverInput(ticket.id, {
        kind: 'retry',
        text: [
          '上一轮因服务重启被中断。',
          ...(summary ? [`中断前已完成到：${summary}。`] : []),
          '请先检查当前现场（文件可能只写了一半），判断哪些步骤需要重做，然后继续完成剩余部分。',
        ].join('\n'),
      })
      record.autoRecovered += 1
      this.saveInterruptedRecord(ticket.id, record)
      this.log('recover:auto-resume', ticket.id, { turnId: interrupted.turnId })
      // 恢复动作已经排上，提示用户一声。
      this.notify(
        ticket,
        `工单「${ticket.title}」已自动从中断处恢复，正在继续执行。`,
        `recover:auto-resumed:${ticket.id}:${interrupted.turnId}`,
      )
    } catch (error) {
      this.saveInterruptedRecord(ticket.id, record)
      this.logger.warn('recover:auto-resume-failed', {
        ticketId: ticket.id,
        turnId: interrupted.turnId,
        message: errorMessage(error),
      })
      this.notify(
        ticket,
        `工单「${ticket.title}」自动恢复失败，请回复「继续」手动接着做。`,
        `recover:auto-resume-failed:${ticket.id}:${interrupted.turnId}`,
      )
    }
  }

  /** 读取中断恢复水位；读不出来当作全新记录。 */
  private loadInterruptedRecord(ticketId: string): InterruptedRecord {
    const raw = this.store.getCursor(interruptedCursorKey(ticketId))
    if (!raw) return { turnIds: [], autoRecovered: 0 }
    try {
      const parsed = JSON.parse(raw) as Partial<InterruptedRecord>
      return {
        turnIds: Array.isArray(parsed.turnIds) ? parsed.turnIds.filter(id => typeof id === 'string') : [],
        autoRecovered: typeof parsed.autoRecovered === 'number' && parsed.autoRecovered >= 0 ? parsed.autoRecovered : 0,
      }
    } catch {
      return { turnIds: [], autoRecovered: 0 }
    }
  }

  private saveInterruptedRecord(ticketId: string, record: InterruptedRecord): void {
    this.store.setCursor(interruptedCursorKey(ticketId), JSON.stringify(record), this.clock.now())
  }

  /** 只把「确认丢失/不可恢复」判为 gone；查询失败不误杀。 */
  private async workerGone(assignment: Assignment): Promise<boolean> {
    const runtime = this.runtimeFor(assignment)
    if (!runtime.status) return false
    const status = await this.statusOf(assignment)
    const verdict = classifyAgentStatus(status)
    return verdict === 'lost' || verdict === 'transfer'
  }

  /**
   * Worker 会话已不存在：结束派工、转人工、取消线程订阅，只通知一次。
   * 找不到终端/后台会话不一定是被人删了，电脑重启、Orca 退出、进程退出都会导致；
   * 不自动重开新 worker——新会话没有原上下文，重跑等于从头再来。
   */
  private handleLostWorker(ticket: Ticket, reason: string): void {
    const assignment = this.store.latestAssignment(ticket.id)
    const lastSeq = this.store.listInputs(ticket.id).reduce((max, input) => Math.max(max, input.seq), 0)
    // 旧终端已经不在了：已投递但没 ack 的输入不会再有人确认，标记 expired 而不是
    // 一直停在 delivered——否则「未 ack 输入」会被当成待重投任务反复处理（tk-51）。
    // 之后只有用户新发的消息（pending、seq 更大）才会触发重新派工。
    const expired = this.store.expireUnackedInputs(ticket.id)
    if (assignment && assignment.status !== 'ended') {
      this.store.updateAssignment({ ...assignment, status: 'ended', endedAt: this.clock.now() })
    }
    const workdirNote = assignment?.workdir ? `工作区仍保留在 ${assignment.workdir}，未提交的改动可能还在。` : ''
    this.engine.setAttention(ticket.id, '执行会话已不存在（电脑重启、终端关闭或进程退出都会导致）')
    this.engine.unsubscribe(ticket.threadId, ticket.id)
    this.notify(
      ticket,
      `工单「${ticket.title}」的执行会话已不存在（电脑重启、终端关闭或进程退出都会导致），无法继续执行。${workdirNote}如果还需要继续，请在本话题里说明，我会重新开一张工单。`,
      `worker-lost:${ticket.id}`,
    )
    this.log('worker:lost', ticket.id, { handle: assignment?.handle ?? '', reason, lastSeq, expired })
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
        channelKind: ticket.channelId ?? DEFAULT_CHANNEL_ID,
        channelId: ticket.chatId,
        threadId: ticket.threadId.split(':').at(-1) ?? '',
        text: `${chunk}${suffix}`,
        now: Number.isFinite(base) ? new Date(base + index).toISOString() : this.clock.now(),
      })
    })
  }

  /** 结构化回复只发一条：卡片内部自行排版，切块会拆散图片与按钮。 */
  private queuePayload(ticket: Ticket, payload: ReplyPayload, key: string, turn: number): void {
    const prepared = this.prepareQuestion(ticket, payload, turn)
    this.store.enqueueOutbox({
      id: `ob_${key.replace(/[^a-zA-Z0-9:_-]/g, '_')}`,
      key,
      channelKind: ticket.channelId ?? DEFAULT_CHANNEL_ID,
      channelId: ticket.chatId,
      threadId: ticket.threadId.split(':').at(-1) ?? '',
      text: prepared.fallbackText,
      blocks: prepared.blocks,
      now: this.clock.now(),
    })
  }

  /**
   * 选择题入库：
   * - callback：生成稳定 questionId 并登记 Question，按钮点选后落成 Input；
   * - text：不登记 Question，题面写序号，用户回复会走普通的追问投递。
   *
   * 同一 turn 重复上报只刷新题面与到期时间，不重置已答状态。
   */
  private prepareQuestion(ticket: Ticket, payload: ReplyPayload, turn: number): ReplyPayload {
    const choice = choiceBlockOf(payload)
    if (!choice) return payload
    const mode = this.askModeOf(ticket)
    const questionId = choice.questionId || `q_${ticket.id}_${turn}`
    if (mode === 'text') return { ...payload, blocks: payload.blocks.map(block => block === choice ? { ...block, questionId, mode } : block) }

    const now = this.clock.now()
    const created = Date.parse(now)
    const expiresAt = new Date((Number.isFinite(created) ? created : Date.now()) + this.config.reply.ask.timeoutMs).toISOString()
    this.store.upsertQuestion({
      id: questionId,
      ticketId: ticket.id,
      assignmentId: this.store.latestAssignment(ticket.id)?.id ?? '',
      chatId: ticket.chatId,
      threadId: ticket.threadId,
      turn,
      prompt: choice.prompt,
      options: choice.options,
      multi: Boolean(choice.multi),
      status: 'open',
      createdAt: now,
      expiresAt,
    })
    this.log('question:asked', ticket.id, { questionId, turn, options: choice.options.length, mode })
    return { ...payload, blocks: payload.blocks.map(block => block === choice ? { ...block, questionId, mode } : block) }
  }

  private askModeOf(ticket: Ticket): 'callback' | 'text' {
    if (this.config.reply.ask.mode === 'text') return 'text'
    const channelId = ticket.channelId ?? DEFAULT_CHANNEL_ID
    if (this.cardActionsUnavailable.has(channelId)) return 'text'
    const adapter = this.channels?.get(channelId)
    return adapter?.capabilities.choices ? 'callback' : 'text'
  }

  private queue(ticket: Ticket, text: string, key: string): void {
    this.store.enqueueOutbox({
      id: `ob_${key.replace(/[^a-zA-Z0-9:_-]/g, '_')}`,
      key,
      channelKind: ticket.channelId ?? DEFAULT_CHANNEL_ID,
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
    // 事件日志是辅助排查用的，写不进去不能影响上报、派工与关单。
    try {
      const dir = join(this.config.home, 'workers', ticketId)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'events.log'), `${JSON.stringify(event)}\n`, 'utf8')
    } catch (error) {
      this.logger.warn('worker:event-log-failed', {
        ticketId,
        kind: String(event.kind ?? ''),
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private log(kind: string, ticketId: string, extra: Record<string, unknown>): void {
    this.logger.info(kind, { ticketId, ...extra })
  }

  /**
   * 工单日志的统一上下文：群、发起人、运行时。
   *
   * 「是 Orca 还是 Codex 在动」「这是哪个群、谁提的需求」这两件事，
   * 每一行工单日志都要能直接回答，不用再回查别的日志。
   */
  private contextOf(ticketId: string): Record<string, unknown> {
    return {
      ...this.store.ticketLogContext(ticketId),
      // 还没派工时退回默认运行时：日志里要能看出「这条链路该由谁跑」。
      runtime: this.runtimeOf(ticketId),
    }
  }

  /** 工单当前用的运行时；还没派工时退回默认运行时。 */
  private runtimeOf(ticketId: string): string {
    return this.store.latestAssignment(ticketId)?.runtimeId ?? this.runtimes.default().id
  }
}

export interface CreateServiceDeps {
  config: AppConfig
  runner: CommandRunner
  runtime: WorkerRuntime
  prTracker: PrTracker
  sender: OutboundSender
  logger: Logger
}

/** 旧版出站兼容层；生产路径已改为 `ChannelRouter`，这里仅保留导出。 */
export { createEffectsSender, type FeishuOutbound } from '@router-agent/channel-feishu'

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

/** 按钮 value 支持单选 `optionId` 与多选 `options` 两种形态。 */
function selectedOptions(value: Record<string, unknown>): string[] {
  if (Array.isArray(value.options)) return value.options.map(String).filter(Boolean)
  const single = value.optionId ?? value.option
  return single ? [String(single)] : []
}

export interface LaunchErrorDetail {
  reason: string
  /** 运行时给的处置建议；比通用兜底文案更贴近真实原因。 */
  hint?: string
  /** provider 包装成通用文案时保留的底层原因。 */
  cause?: string
  /** 启动结果未知时的重试句柄。 */
  operationId?: string
  code?: number
  /** provider 自己的错误码（如 Orca 的 agent_session_operation_unknown）。 */
  providerCode?: string
  args?: string
  stdout?: string
  stderr?: string
}

interface ProviderFailureDetail {
  orcaMessage?: string
  orcaCause?: string
  orcaOperationId?: string
  orcaCode?: string
  code?: number
  args?: string
  stdoutTail?: string
  stderrTail?: string
}

/**
 * 把运行时抛出的错误整理成可读、可审计的结构。
 * Orca 在 `--json` 模式下把错误体写在 stdout，stderr 通常为空；
 * 只取 stderr 会得到没有信息量的 `code=1`。
 */
export function describeLaunchError(error: unknown): LaunchErrorDetail {
  if (error instanceof WorkerRuntimeError) {
    const detail = error.detail ?? {}
    return {
      reason: error.reason,
      ...(typeof detail.hint === 'string' ? { hint: detail.hint } : {}),
      ...(error.cause ? { cause: error.cause } : {}),
      ...(typeof detail.operationId === 'string' ? { operationId: detail.operationId } : {}),
      ...(typeof detail.code === 'number' ? { code: detail.code } : {}),
      ...(typeof detail.providerCode === 'string' ? { providerCode: detail.providerCode } : {}),
      ...(typeof detail.args === 'string' ? { args: detail.args } : {}),
      ...(typeof detail.stdout === 'string' ? { stdout: detail.stdout } : {}),
      ...(typeof detail.stderr === 'string' ? { stderr: detail.stderr } : {}),
    }
  }
  // OrcaCommandError 等旧实现：结构匹配，不 import 具体类。
  const legacy = error as { message?: unknown; detail?: ProviderFailureDetail } | null
  if (legacy && typeof legacy === 'object' && legacy.detail && typeof legacy.detail === 'object') {
    const detail = legacy.detail
    return {
      reason: detail.orcaMessage ?? (error instanceof Error ? error.message : String(error)),
      ...(detail.orcaCause ? { cause: detail.orcaCause } : {}),
      ...(detail.orcaOperationId ? { operationId: detail.orcaOperationId } : {}),
      ...(typeof detail.code === 'number' ? { code: detail.code } : {}),
      ...(detail.orcaCode ? { providerCode: detail.orcaCode } : {}),
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
