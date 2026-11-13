/**
 * 面板「日志」页的多维过滤：级别 × 类别 × 域 × 动作 × 群 × 发起人 × 运行时 × 工单 × 追踪 × 关键字。
 *
 * 过滤与统计都放在纯函数里，面板只负责收集条件和渲染；
 * 「筛出哪些行」因此能被单测覆盖，不用对着 DOM 断言。
 */

/** 不限：某个维度没选时用它。 */
export const ALL_FILTER = 'all'

export interface LogFilter {
  /** 级别：all / info / warn / error / raw。 */
  level: string
  /** 类别：message（用户消息）/ event（内部状态）/ action（对外动作）。 */
  category: string
  /** 事件域（事件名第一段）。 */
  domain: string
  /** 事件动作（事件名冒号后的部分）。 */
  event: string
  /** 群 / 会话。 */
  chat: string
  /** 发起人。 */
  actor: string
  /** 运行时：orca / codex-app 等。 */
  runtime: string
  /** 工单。 */
  ticket: string
  /** 链路 ID：把同一条链路的日志聚在一起。 */
  trace: string
  /** 关键字：命中消息、维度或任一业务字段。 */
  keyword: string
}

export const EMPTY_FILTER: LogFilter = {
  level: ALL_FILTER,
  category: ALL_FILTER,
  domain: ALL_FILTER,
  event: ALL_FILTER,
  chat: ALL_FILTER,
  actor: ALL_FILTER,
  runtime: ALL_FILTER,
  ticket: ALL_FILTER,
  trace: ALL_FILTER,
  keyword: '',
}

/** 面板日志行里过滤用得到的字段。 */
export interface FilterableLogLine {
  level: string
  message: string
  category?: string
  domain?: string
  event?: string
  chat?: string
  /** 群名：下拉里显示名字，值仍是 ID。 */
  chatName?: string
  actor?: string
  /** 发起人名字：下拉里显示名字，值仍是 ID。 */
  actorName?: string
  runtime?: string
  ticket?: string
  trace?: string
  data?: Record<string, unknown>
}

export interface FilterOption {
  value: string
  /** 展示用的名字；没有就显示 value（群名、发起人名字）。 */
  label?: string
  count: number
}

/** 可以做分面计数的维度。 */
export type FilterDimension =
  | 'level'
  | 'category'
  | 'domain'
  | 'event'
  | 'chat'
  | 'actor'
  | 'runtime'
  | 'ticket'
  | 'trace'

/** 是否有生效的筛选条件；面板据此决定要不要显示「清除筛选」。 */
export function isFilterActive(filter: LogFilter): boolean {
  return Object.entries(filter).some(([key, value]) => (
    key === 'keyword' ? value.trim() !== '' : value !== ALL_FILTER
  ))
}

/** 按全部条件过滤日志行；各维度之间取交集。 */
export function filterLogLines<T extends FilterableLogLine>(lines: readonly T[], filter: LogFilter): T[] {
  const keyword = filter.keyword.trim().toLowerCase()
  return lines.filter(line => {
    if (filter.level !== ALL_FILTER && line.level !== filter.level) return false
    if (filter.category !== ALL_FILTER && line.category !== filter.category) return false
    if (filter.domain !== ALL_FILTER && line.domain !== filter.domain) return false
    if (filter.event !== ALL_FILTER && line.event !== filter.event) return false
    if (filter.chat !== ALL_FILTER && line.chat !== filter.chat) return false
    if (filter.actor !== ALL_FILTER && line.actor !== filter.actor) return false
    if (filter.runtime !== ALL_FILTER && line.runtime !== filter.runtime) return false
    if (filter.ticket !== ALL_FILTER && line.ticket !== filter.ticket) return false
    if (filter.trace !== ALL_FILTER && line.trace !== filter.trace) return false
    if (!keyword) return true
    return haystack(line).includes(keyword)
  })
}

/**
 * 某个维度的候选值与命中条数。
 *
 * 计数按「其它维度」的条件算：这个维度自己被排除，
 * 所以选上 tk-84 之后，级别按钮上的「全部」是这条链路的条数，而不是缓冲区总数。
 */
export function facetCounts(
  lines: readonly FilterableLogLine[],
  filter: LogFilter,
  dimension: FilterDimension,
): FilterOption[] {
  const counts = new Map<string, number>()
  const labels = new Map<string, string>()
  for (const line of filterLogLines(lines, { ...filter, [dimension]: ALL_FILTER })) {
    const value = line[dimension]
    if (!value) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
    const label = labelOf(line, dimension)
    if (label && !labels.has(value)) labels.set(value, label)
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count, ...(labels.get(value) ? { label: labels.get(value) } : {}) }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/** 群与发起人显示名字，ID 只作为值参与过滤。 */
function labelOf(line: FilterableLogLine, dimension: FilterDimension): string {
  if (dimension === 'chat') return line.chatName ?? ''
  if (dimension === 'actor') return line.actorName ?? ''
  return ''
}

function haystack(line: FilterableLogLine): string {
  return `${line.message} ${line.domain ?? ''} ${line.event ?? ''} ${line.category ?? ''} ${line.chat ?? ''} ${line.actor ?? ''} ${line.runtime ?? ''} ${line.ticket ?? ''} ${line.trace ?? ''} ${JSON.stringify(line.data ?? {})}`.toLowerCase()
}
