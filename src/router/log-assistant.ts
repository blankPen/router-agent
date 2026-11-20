/**
 * 排查助手的对外入口。
 *
 * 实现按职责拆在同目录的多个文件里：
 *
 * - `types.ts`     —— 类型与常量；
 * - `evidence.ts` —— 挑证据、脱敏、分词；
 * - `symptoms.ts` —— 症状知识库与规则式排查；
 * - `model.ts`    —— 模型总结；
 * - `overview.ts` —— 面板总览；
 * - `index.ts`    —— 组装。
 *
 * 这里只做转出，导出名与拆分前完全一致，调用方不需要改 import。
 */
export {
  MAX_ASSISTANT_EVIDENCE,
  MAX_QUESTION_CHARS,
  READ_LIMIT,
} from './log-assistant/types.js'
export type {
  LogAssistant,
  LogAssistantOptions,
  LogAssistantOverview,
  LogAssistantQuestion,
  LogCause,
  LogDiagnosis,
  LogEvidence,
  LogNextStep,
  LogOverviewConfigIssue,
  LogOverviewIssue,
} from './log-assistant/types.js'
export {
  filterEntries,
  redactFields,
  selectEvidence,
  tokenize,
} from './log-assistant/evidence.js'
export {
  ensureEvidence,
  matchSymptoms,
  nextStepsFor,
  ruleDiagnosis,
} from './log-assistant/symptoms.js'
export type { SymptomHit } from './log-assistant/symptoms.js'
export { askModel, nextStepsFromCauses } from './log-assistant/model.js'
export { distinctIssues, overviewIssueOf } from './log-assistant/overview.js'
export { createLogAssistant } from './log-assistant/index.js'
