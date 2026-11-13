/**
 * 面板「日志」页的多维过滤：级别 × 域 × 动作 × 链路 ID × 关键字。
 *
 * 过滤与统计都放在纯函数里，面板只负责收集条件和渲染；
 * 「筛出哪些行」因此能被单测覆盖，不用对着 DOM 断言。
 */

/** 不限：某个维度没选时用它。 */
export const ALL_FILTER = 'all'

export interface LogFilter {
  /** 级别：all / info / warn / error / raw。 */
  level: string
  /** 事件域（事件名第一段）。 */
  domain: string
  /** 事件动作（事件名冒号后的部分）。 */
  event: string
  /** 链路 ID：把同一条链路的日志聚在一起。 */
  trace: string
  /** 关键字：命中消息、维度或任一业务字段。 */
  keyword: string
}

export const EMPTY_FILTER: LogFilter = {
  level: ALL_FILTER,
  domain: ALL_FILTER,
  event: ALL_FILTER,
  trace: ALL_FILTER,
  keyword: '',
}

/** 面板日志行里过滤用得到的字段。 */
export interface FilterableLogLine {
  level: string
  message: string
  domain?: string
  event?: string
  trace?: string
  data?: Record<string, unknown>
}

export interface FilterOption {
  value: string
  count: number
}

/** 是否有生效的筛选条件；面板据此决定要不要显示「清除筛选」。 */
export function isFilterActive(filter: LogFilter): boolean {
  return filter.level !== ALL_FILTER
    || filter.domain !== ALL_FILTER
    || filter.event !== ALL_FILTER
    || filter.trace !== ALL_FILTER
    || filter.keyword.trim() !== ''
}

/** 按全部条件过滤日志行；各维度之间取交集。 */
export function filterLogLines<T extends FilterableLogLine>(lines: readonly T[], filter: LogFilter): T[] {
  const keyword = filter.keyword.trim().toLowerCase()
  return lines.filter(line => {
    if (filter.level !== ALL_FILTER && line.level !== filter.level) return false
    if (filter.domain !== ALL_FILTER && line.domain !== filter.domain) return false
    if (filter.event !== ALL_FILTER && line.event !== filter.event) return false
    if (filter.trace !== ALL_FILTER && line.trace !== filter.trace) return false
    if (!keyword) return true
    return haystack(line).includes(keyword)
  })
}

/** 可以做分面计数的维度。 */
export type FilterDimension = 'level' | 'domain' | 'event' | 'trace'

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
  for (const line of filterLogLines(lines, { ...filter, [dimension]: ALL_FILTER })) {
    const value = dimension === 'level' ? line.level : line[dimension]
    if (!value) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

function haystack(line: FilterableLogLine): string {
  return `${line.message} ${line.domain ?? ''} ${line.event ?? ''} ${line.trace ?? ''} ${JSON.stringify(line.data ?? {})}`.toLowerCase()
}
