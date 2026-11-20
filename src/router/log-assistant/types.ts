

import type { ChatModelConfig } from '#infra/chat.js'
import type { DiagnosisTool } from '../diagnosis-tools.js'
import type { Logger } from '#infra/logger.js'

export const MAX_ASSISTANT_EVIDENCE = 40

/**
 * 读取日志时一次回看的行数上限。
 *
 * 取 5000 而不是 500：服务繁忙时一小时内能写几千行日志，
 * 只看最后 500 行的话，早先的 error 会被 info 挤出去——
 * 排查助手给出的证据里一条错误都没有，用户上报 issue 时正文也就没有错误日志。
 */
export const READ_LIMIT = 5_000
/** 用户问题的字符上限，超出部分截断。 */
export const MAX_QUESTION_CHARS = 2_000

export interface LogAssistantQuestion {
  /** 用户描述的问题。 */
  question: string
  /** 面板上的级别过滤（all / info / warn / error）。 */
  level?: string
  /** 面板上的关键字过滤。 */
  keyword?: string
}

export interface LogEvidence {
  at: string
  level: string
  /** 事件名（域:动作）。 */
  message: string
  /** 事件里的关键字段摘要。 */
  detail?: string
  /** 事件里的原始字段；发给模型前按 key 脱敏。 */
  data?: Record<string, unknown>
}

export interface LogCause {
  /** 结论标题（人话，不带事件名）。 */
  title: string
  /** 为什么得出这个结论；属于补充细节，主界面默认折叠。 */
  detail: string
  /** 支撑这个结论的日志事件名；属于补充细节。 */
  events: string[]
  /** 模型给出的处置分类：config = 用户自己能改；defect = 应上报。 */
  category?: 'config' | 'defect'
}

/**
 * 一条排查结论。
 *
 * 分三段对应普通用户的三件事：
 * - `summary`：发生了什么（人话）；
 * - `actions`：现在该做什么（可执行的动作）；
 * - `details`：原始日志与专业术语（折叠起来，不打扰主流程）。
 */
export interface LogDiagnosis {
  /** 一句话结论：面向用户说明当前发生了什么。 */
  summary: string
  /** 可能的原因；每条都带人话标题，detail / events 属于补充细节。 */
  causes: LogCause[]
  /** 建议的下一步：用户照着做就行。 */
  actions: string[]
  /** 证据日志；属于补充细节。 */
  evidence: LogEvidence[]
  /** llm = 模型总结；rules = 规则降级。 */
  source: 'llm' | 'rules'
  /** 降级原因；正常总结时为空。 */
  degraded?: string
  /** 助手用到的工具，让用户知道结论是基于什么得出的。 */
  toolsUsed?: string[]
  /** 处置建议：配置类引导去改配置，缺陷类引导一键上报 issue。 */
  next?: LogNextStep[]
}

/**
 * 面板打开时先展示的「当前状态摘要」。
 *
 * 不用等用户点「分析」：面板一打开就把当前存在的异常、配置错误与配置遗漏摆出来，
 * 用户看完再决定要不要发起一次分析。
 */
export interface LogAssistantOverview {
  /** 窗口内的错误日志条数。 */
  errorCount: number
  /** 窗口内的警告日志条数。 */
  warnCount: number
  /** 窗口内最值得看的错误（人话摘要），同一类问题只列一条。 */
  issues: LogOverviewIssue[]
  /** 配置自检结果里不通过的项目。 */
  configIssues: LogOverviewConfigIssue[]
  /** 窗口说明：当前看的是哪段时间、哪个版本。 */
  window: { since: string; version: string }
}

/** 一条异常摘要：给人看的错误说明。 */
export interface LogOverviewIssue {
  /** 事件名。 */
  event: string
  /** 人话说明：这个错误意味着什么。 */
  title: string
  /** 补充细节：错误详情。 */
  detail?: string
  /** 发生时间。 */
  at: string
  /** 建议动作：用户下一步该做什么。 */
  action?: string
}

/** 一条配置问题：缺什么、去哪改。 */
export interface LogOverviewConfigIssue {
  /** 检查项名称。 */
  name: string
  /** 缺什么 / 错在哪。 */
  detail: string
  /** 改法。 */
  hint?: string
  /** 面板配置页分组 id；用户点「去修改」直接跳过去。 */
  section?: string
  /** 缺的具体配置项。 */
  items?: string[]
}

/** 处置建议。 */
export interface LogNextStep {
  /** config = 引导去改配置；issue = 一键上报 GitHub issue。 */
  kind: 'config' | 'issue'
  /** 按钮文案。 */
  label: string
  /** kind=config 时：配置页的 section id（sec-<id>），留空表示只跳到配置页。 */
  section?: string
  /** kind=issue 时：建议的 issue 标题。 */
  issueTitle?: string
}

export interface LogAssistant {
  diagnose(question: LogAssistantQuestion): Promise<LogDiagnosis>
  /** 面板打开时展示的当前状态摘要。 */
  overview(): LogAssistantOverview
  /** 模型是否配齐（决定面板提示「去配置模型」还是「模型总结」）。 */
  llmConfigured(): boolean
}

export interface LogAssistantOptions {
  /** 服务日志路径。 */
  logPath: string
  /** 当前版本号；用于判断日志是不是当前版本还在报。 */
  version?: string
  /** 配置自检结果（不联网的那部分）；面板用它指出配置遗漏。 */
  configChecks?: () => { name: string; status: 'ok' | 'warn' | 'fail'; detail: string; hint?: string; section?: string; items?: string[] }[]
  /** 研判模型配置；缺省时只走规则式降级。 */
  model?: ChatModelConfig | null
  /** 助手的只读工具（读配置 / 读本地代码）；缺省时模型只能看日志。 */
  tools?: DiagnosisTool[]
  logger?: Logger
  /** 测试注入点。 */
  fetchImpl?: typeof fetch
  /** 模型请求超时，默认 60s。 */
  timeoutMs?: number
  /** 时钟；测试可注入。 */
  now?: () => string
}
