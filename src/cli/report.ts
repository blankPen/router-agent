// `ra report` 的旧入口：实现已合并进 ra reply，别名保持参数与导出不变。
export { runReply as runReport, readContentArg } from './reply.js'
export type { ReplyOptions as ReportOptions } from './reply.js'
export type { ReplyDeps as ReportDeps } from './reply.js'
