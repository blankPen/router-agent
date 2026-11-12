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