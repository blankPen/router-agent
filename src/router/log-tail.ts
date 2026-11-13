/**
 * Web 面板「日志」页的读文件实现。
 *
 * 服务日志是 `~/.router-agent/logs/router-agent.log` 里的逐行 JSON（见 cli 的 createLogger）。
 * 面板要边看边跟，所以这里按**字节游标**增量读取：每次只读上次游标之后的新内容，
 * 既能跟实时日志，又不会每次把整个文件重新读一遍。
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { logDimensions } from '#core/events.js'

/** 面板单次回看的最大行数。 */
export const MAX_LOG_LINES = 1_000
/** 首次加载时从文件尾部回看的字节窗口。 */
const TAIL_WINDOW_BYTES = 256 * 1024
/** 单次增量读取的字节上限；还有剩余时前端按 nextCursor 继续拉。 */
const MAX_READ_BYTES = 512 * 1024
/** 排查助手回看日志的字节窗口：比面板大，保证错误日志不被 info 挤掉。 */
const ASSISTANT_WINDOW_BYTES = 4 * 1024 * 1024

export interface LogEntry {
  /** 写入时间（ISO 8601）；非 JSON 行或字段缺失时为空串。 */
  at: string
  /** info / warn / error；无法解析的行记为 raw。 */
  level: string
  /** 事件域（事件名的第一段），面板按它过滤。 */
  domain: string
  /** 事件动作（事件名冒号后的部分）。 */
  event: string
  /** 链路 ID：把同一条链路的日志串起来。 */
  trace?: string
  message: string
  /**
   * 写入这条日志时的 router-agent 版本号。
   *
   * 排查助手靠它判断「这条错误是不是当前版本还在报」：
   * 版本对不上的旧日志视为已修复，不再纳入排查范围。
   */
  version?: string
  /** at / level / message / 结构字段之外的业务字段。 */
  data?: Record<string, unknown>
}

export interface LogReadResult {
  path: string
  exists: boolean
  /** 当前文件大小（字节）。 */
  size: number
  /** 下次增量读取应带的游标。 */
  cursor: number
  entries: LogEntry[]
  /** 还有未返回的完整行，前端应立即继续拉取。 */
  more: boolean
  /** 文件被截断/轮转，游标失效，这一批是从头重新读的。 */
  reset?: boolean
}

/**
 * 读取日志。
 *
 * - 不带 `cursor`：首次加载，从文件尾部回看 `limit` 行。
 * - 带 `cursor`：只返回 `cursor` 之后新增的完整行。
 * - `cursor` 超出当前文件大小：说明文件被截断或轮转，从 0 重读并标记 `reset`。
 *
 * 只返回以换行结尾的完整行；末尾写了一半的行留到下次，避免把半行当一条日志。
 */
export function readLogs(path: string, options: { cursor?: number; limit?: number } = {}): LogReadResult {
  const limit = clampLimit(options.limit)
  if (!path || !existsSync(path)) {
    return { path, exists: false, size: 0, cursor: 0, entries: [], more: false }
  }

  const size = statSync(path).size
  const requested = options.cursor
  const valid = requested !== undefined && Number.isFinite(requested) && requested >= 0

  if (valid && requested <= size) {
    const segment = readSegment(path, requested, MAX_READ_BYTES, size, false)
    return {
      path,
      exists: true,
      size,
      cursor: segment.next,
      entries: segment.lines.map(parseLine),
      more: segment.next < size,
    }
  }

  if (valid) {
    // 游标比文件还大：文件被截断/轮转，从头重读，让前端替换而不是追加。
    const segment = readSegment(path, 0, MAX_READ_BYTES, size, false)
    return {
      path,
      exists: true,
      size,
      cursor: segment.next,
      entries: segment.lines.map(parseLine),
      more: segment.next < size,
      reset: true,
    }
  }

  // 首次加载：从尾部窗口取最近 limit 行；窗口起点在文件中间时丢掉被截断的首行。
  const start = Math.max(0, size - TAIL_WINDOW_BYTES)
  const segment = readSegment(path, start, TAIL_WINDOW_BYTES, size, start > 0)
  return {
    path,
    exists: true,
    size,
    cursor: segment.next,
    entries: segment.lines.slice(-limit).map(parseLine),
    more: false,
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return 200
  return Math.min(Math.floor(limit), MAX_LOG_LINES)
}

/**
 * 排查助手专用：一次性回看较长的日志尾部。
 *
 * 面板的 readLogs 是为「边看边跟」设计的，窗口只有 256KB / 1000 行。
 * 助手要把结论与证据一起贴进 issue，需要更长的回看范围——
 * 否则服务一忙，最后 500 行全是 info，早先的 error 被挤出去，
 * 用户上报的 issue 正文里就一条错误日志都没有。
 */
export function readLogTail(path: string, options: { lines?: number; windowBytes?: number } = {}): LogEntry[] {
  if (!path || !existsSync(path)) return []
  const lines = Math.max(1, Math.floor(options.lines ?? 5_000))
  const windowBytes = Math.max(TAIL_WINDOW_BYTES, Math.floor(options.windowBytes ?? ASSISTANT_WINDOW_BYTES))
  const size = statSync(path).size
  const start = Math.max(0, size - windowBytes)
  const segment = readSegment(path, start, windowBytes, size, start > 0)
  return segment.lines.slice(-lines).map(parseLine)
}

/**
 * 读取 [start, start+maxBytes) 区间里的完整行。
 *
 * 全程按字节处理：0x0a 在 UTF-8 里不会出现在多字节字符中间，
 * 按字节找边界再转字符串，能避免把中文字符截成乱码。
 */
function readSegment(
  path: string,
  start: number,
  maxBytes: number,
  size: number,
  dropFirstLine: boolean,
): { lines: string[]; next: number } {
  const length = Math.min(size, start + maxBytes) - start
  if (length <= 0) return { lines: [], next: start }

  const buffer = Buffer.alloc(length)
  const fd = openSync(path, 'r')
  let read = 0
  try {
    read = readSync(fd, buffer, 0, length, start)
  } finally {
    closeSync(fd)
  }
  const chunk = buffer.subarray(0, read)

  let from = 0
  if (dropFirstLine) {
    const firstBreak = chunk.indexOf(0x0a)
    if (firstBreak < 0) return { lines: [], next: start }
    from = firstBreak + 1
  }

  const lastBreak = chunk.lastIndexOf(0x0a)
  if (lastBreak < from) return { lines: [], next: start + from }

  const lines = chunk.subarray(from, lastBreak).toString('utf8').split('\n').filter(line => line.length > 0)
  return { lines, next: start + lastBreak + 1 }
}

function parseLine(line: string): LogEntry {
  try {
    const parsed = JSON.parse(line) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      const data: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(record)) {
        if (key === 'at' || key === 'level' || key === 'message') continue
        // domain / event / trace / version 单独成字段，不混进业务字段里。
        if (key === 'domain' || key === 'event' || key === 'trace' || key === 'version') continue
        data[key] = value
      }
      const message = typeof record.message === 'string' ? record.message : ''
      // 旧日志没有结构字段时按事件名与业务字段补齐，面板照样能按维度过滤。
      const dimensions = logDimensions(message, record)
      return {
        at: typeof record.at === 'string' ? record.at : '',
        level: typeof record.level === 'string' ? record.level : 'info',
        domain: dimensions.domain,
        event: dimensions.event,
        ...(dimensions.trace ? { trace: dimensions.trace } : {}),
        message,
        ...(typeof record.version === 'string' && record.version ? { version: record.version } : {}),
        ...(Object.keys(data).length > 0 ? { data } : {}),
      }
    }
  } catch {
    // 非 JSON 行（旧日志、异常栈等）按原文展示，不影响后续行。
  }
  return { at: '', level: 'raw', domain: '', event: '', message: line }
}
