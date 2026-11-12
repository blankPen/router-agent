/**
 * 结构化日志的统一入口。
 *
 * 服务日志一行一个 JSON（`at` / `level` / `message` + 业务字段），
 * 面板日志页按 info / warn / error 三档过滤，所以这里只保留这三档。
 * 各模块只依赖这个接口，不直接碰文件，方便测试注入与将来换实现。
 */
export interface Logger {
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

/** 未注入日志实现时的空实现；关键链路不会因为「没传 logger」而崩。 */
export const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** 把任意异常折成一行可读文本；日志里不写堆栈，避免刷屏。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
