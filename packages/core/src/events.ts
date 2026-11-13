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

/** 日志事件的三个维度：域（事件名前缀）、动作（事件名后半段）与链路 ID。 */
export interface LogDimensions {
  domain: string
  event: string
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
  const trace = text(fields.trace) ?? pickTrace(fields)
  return { domain, event, ...(trace ? { trace } : {}) }
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
