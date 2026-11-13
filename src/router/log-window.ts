/**
 * 排查助手的日志窗口：只认「最近一段时间内、当前版本还在报」的错误。
 *
 * 两个条件同时成立才算数：
 *
 * 1. **时间窗口**：默认只看最近 3 小时。早于窗口的日志不再纳入排查——
 *    用户点「分析」时想看的是「现在还活着的问题」，不是三天前的历史。
 * 2. **版本一致**：日志里记着写入时的 router-agent 版本，版本对不上的旧日志
 *    视为已修复（用户升级过），排除掉。
 *
 * 两条规则合起来解决的是同一个诉求：**不要把已经修好的旧问题当成现在的问题**。
 */

/** 排查助手默认回看的时间窗口：3 小时。 */
export const DEFAULT_WINDOW_MS = 3 * 60 * 60 * 1000

export interface LogWindow {
  /** 窗口起点（ISO 8601）；早于它的日志被排除。 */
  since: string
  /**
   * 当前版本号；日志版本与之不同的被排除。
   *
   * 空串表示「不知道当前版本」：这时不做版本过滤——
   * 拿一个猜不到的版本去比，只会把所有日志都滤光。
   */
  version: string
}

export interface LogWindowOptions {
  /** 当前版本号；日志里没有版本号的行按「无法判断」处理，见 isInWindow。 */
  version: string
  /** 当前时间（ISO 8601）；测试可注入。 */
  now: string
  /** 窗口长度，默认 3 小时。 */
  windowMs?: number
}

/** 计算当前窗口。 */
export function logWindow(options: LogWindowOptions): LogWindow {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const since = new Date(new Date(options.now).getTime() - windowMs).toISOString()
  return { since, version: options.version }
}

/**
 * 一条日志是否在窗口内。
 *
 * - 时间解析不出来（老日志、raw 行）：**保留**。宁可多给一条也不要漏掉真正的错误，
 *   丢掉一条错误会让结论直接变成错的。
 * - 时间在窗口外：排除。
 * - 版本对不上：排除（升级后旧错误视为已修复）。
 * - 日志里没有版本号（升级前写的旧日志）：**保留**。没有版本信息不等于已修复，
 *   按「无法判断」处理更安全。
 */
export function isInWindow(entry: { at: string; version?: string }, window: LogWindow): boolean {
  const at = Date.parse(entry.at)
  if (Number.isNaN(at)) return true
  if (at < Date.parse(window.since)) return false
  if (window.version && entry.version && entry.version !== window.version) return false
  return true
}

/** 按窗口过滤日志，保留窗口内的条目。 */
export function filterByWindow<T extends { at: string; version?: string }>(
  entries: T[],
  window: LogWindow,
): T[] {
  return entries.filter(entry => isInWindow(entry, window))
}

