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

/**
 * 给日志器套一层固定上下文。
 *
 * 运行时适配器只知道自己是谁（orca / codex / claude-code），套一层之后
 * 它写的每条日志都带上 runtime，不用在每个调用点重复写；
 * 调用点自己传的字段优先于上下文。
 */
export function withContext(logger: Logger, context: Record<string, unknown>): Logger {
  return {
    info: (message, extra) => logger.info(message, { ...context, ...extra }),
    warn: (message, extra) => logger.warn(message, { ...context, ...extra }),
    error: (message, extra) => logger.error(message, { ...context, ...extra }),
  }
}

/**
 * 按日志里的一个字段自动补上下文。
 *
 * 工单日志散落在几十个调用点，逐个补「群 / 发起人 / 运行时」容易漏；
 * 这里按 ticketId 自动补齐，调用点只写自己知道的事。
 * 调用点自己传的字段优先于上下文。
 */
export function withFieldContext(
  logger: Logger,
  key: string,
  contextOf: (value: string) => Record<string, unknown>,
): Logger {
  const enrich = (extra?: Record<string, unknown>): Record<string, unknown> => {
    const value = extra?.[key]
    if (typeof value !== 'string' || !value) return extra ?? {}
    return { ...contextOf(value), ...extra }
  }
  return {
    info: (message, extra) => logger.info(message, enrich(extra)),
    warn: (message, extra) => logger.warn(message, enrich(extra)),
    error: (message, extra) => logger.error(message, enrich(extra)),
  }
}

/** 把任意异常折成一行可读文本；日志里不写堆栈，避免刷屏。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
