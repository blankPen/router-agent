/** 结构化日志事件：由内核/队列/API 发出，由 CLI 统一落盘。 */
export interface LogEvent {
  event: string
  [key: string]: unknown
}

export type EventSink = (event: LogEvent) => void

/** 截断长文本，日志里保留可读的片段而不刷屏。 */
export function preview(value: unknown, max = 160): string {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max)}…` : single
}

export function noopSink(_event: LogEvent): void {
  // 未注入日志实现时什么都不做
}

/**
 * 日志类别：
 * - `message`：用户发来的消息，以及围绕这条消息的处理；
 * - `action`：Router / Worker 对外做过的动作（派工、投递、回复、上报、推进 PR）；
 * - `event`：内部状态变化（配置、会话、运行时、研判结论）。
 *
 * 面板按它区分「这是用户发来的消息，还是系统自己在动」。
 *
 * 字段名叫 category：kind 已经被业务占用了（需求类型、输入类型）。
 */
export type LogCategory = 'message' | 'event' | 'action'

/**
 * 按事件域推导类别；调用方可以用 `category` 字段显式覆盖。
 *
 * 消息类域是用户发来消息后的处理（接入、准入、需求识别），
 * 动作类域是 Router 对外做的事，其余一律算内部事件。
 */
const CATEGORY_BY_DOMAIN: Record<string, LogCategory> = {
  trigger: 'message',
  intake: 'message',
  launch: 'action',
  input: 'action',
  outbox: 'action',
  report: 'action',
  chat: 'action',
  pr: 'action',
  progress: 'action',
  cleanup: 'action',
  retention: 'action',
  idle: 'action',
}

/** 日志事件的维度：域、动作、类别与链路 ID。 */
export interface LogDimensions {
  domain: string
  event: string
  category: LogCategory
  trace?: string
}

/**
 * 链路 ID 的取值优先级：先工单，再触发 / 需求 / 输入，最后才是会话。
 * 同一段链路上的事件因此能被一个 ID 串起来（见 AGENTS.md 的「可还原用户轨迹」）。
 */
const TRACE_KEYS = ['ticketId', 'triggerId', 'intakeId', 'inputId', 'handle', 'threadId', 'id', 'chat']

/**
 * 从事件名（域:动作）与业务字段推出结构化维度。
 *
 * 日志行同时写 domain / event 与完整的 message，面板按维度过滤不用再切字符串；
 * 旧日志缺这些字段时也能补出来，所以读日志和写日志共用这一份推导。
 */
export function logDimensions(message: string, fields: Record<string, unknown> = {}): LogDimensions {
  const separator = message.indexOf(':')
  const domain = text(fields.domain) ?? (separator > 0 ? message.slice(0, separator) : message)
  const event = text(fields.event) ?? (separator > 0 ? message.slice(separator + 1) : '')
  // 类别字段叫 category：kind 已经被业务占用了（需求类型、输入类型）。
  const category = categoryOf(fields.category) ?? CATEGORY_BY_DOMAIN[domain] ?? 'event'
  const trace = text(fields.trace) ?? pickTrace(fields)
  return { domain, event, category, ...(trace ? { trace } : {}) }
}

/** 显式给的类别优先；不认识的值按内部事件算。 */
function categoryOf(value: unknown): LogCategory | undefined {
  return value === 'message' || value === 'event' || value === 'action' ? value : undefined
}

/**
 * 日志上下文：一行日志里「在哪个群、谁触发的、哪个运行时、哪张工单」。
 *
 * 排查时最常问的三句话是「谁在哪个群说的」「这是 Orca 还是 Codex 在动」
 * 「这是用户消息还是系统自己的动作」——这些都要在写日志时就带上，
 * 事后从日志里猜不出来。
 */
export interface LogContext {
  /** 群 / 会话 ID。 */
  chat?: string
  /** 群名（比 ID 好认）。 */
  chatName?: string
  /** 发起人 ID。 */
  actor?: string
  /** 发起人名字。 */
  actorName?: string
  /** 发起人类型：user（用户）/ bot（机器人）/ system（Router 自己）。 */
  actorType?: 'user' | 'bot' | 'system'
  /** 运行时：orca / codex-app / claude-code 等。 */
  runtime?: string
  /** 工单 ID。 */
  ticket?: string
}

/**
 * 从一条触发消息推导上下文。
 *
 * `isBot` 决定发起人类型：机器人发的消息和用户发的消息在日志里必须分得开，
 * 否则「用户没收到回复」这类问题根本无从判断。
 */
export function messageContext(trigger: {
  chatId: string
  chatName?: string
  actorId: string
  actorName?: string
  isBot?: boolean
}): LogContext {
  return {
    chat: trigger.chatId,
    ...(trigger.chatName ? { chatName: trigger.chatName } : {}),
    actor: trigger.actorId,
    ...(trigger.actorName ? { actorName: trigger.actorName } : {}),
    actorType: trigger.isBot ? 'bot' : 'user',
  }
}

/** 取第一个可定位字段作为链路 ID。 */
function pickTrace(fields: Record<string, unknown>): string | undefined {
  for (const key of TRACE_KEYS) {
    const value = fields[key]
    if (typeof value === 'string' && value) return value
    if (typeof value === 'number') return String(value)
  }
  return undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}
