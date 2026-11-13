/**
 * 决策内核：普通成员消息（UserMsgDecision，msg.user.v1）的纯规则部分。
 *
 * 只回答「要不要跟进、是什么类型、用什么方式处理」；
 * 动作与 toolScope 由固定路由表按身份映射派生，模型不能指定。
 * spec 写死在代码里带版本号，配置只切换 Provider，不允许改问题、枚举、阈值与路由表。
 */
import type { ToolScope } from './tool-scope.js'

export const USER_MSG_DECISION_SPEC = {
  specId: 'msg.user.v1',
  specVersion: 1,
  questions: {
    needsFollowup: '这条普通成员消息是否需要 Router 跟进处理？',
    kind: '这条消息属于哪一类：闲聊吐槽、咨询问题、需求反馈？',
    urgency: '这条消息的紧迫程度（0=不紧急，1=非常紧急）？',
  },
  /** kind 判定的档位（score 的 criteria）。 */
  kindCriteria: ['闲聊吐槽', '咨询问题', '需求反馈'],
} as const

export type MemberMessageKind = 'chat' | 'question' | 'issue'

/** 决策模型返回的原始答案（全部归一化到 0~1）。 */
export interface DecisionAnswers {
  /** 0~1：是否需要跟进。 */
  needsFollowup: number
  /** 0~1：类型分数，按三段映射到 chat / question / issue。 */
  kindScore: number
  /** 0~1：紧迫度。 */
  urgency: number
}

export type DecisionAction = 'ignore' | 'reply' | 'analysis'

export interface DecisionVerdict {
  specId: string
  specVersion: number
  kind: MemberMessageKind
  needsFollowup: boolean
  urgency: number
  confidence: number
  action: DecisionAction
  toolScope: ToolScope
  /** 决策层降级（Provider 失败走保守兜底）时置 true。 */
  degraded: boolean
}

/** 需要跟进的置信度阈值；默认宽松（不确定就放行）。 */
export const NEEDS_FOLLOWUP_THRESHOLD = 0.4

/** kind 分数分界：< 0.34 chat；[0.34, 0.66) question；>= 0.66 issue。 */
export const KIND_BANDS = { chat: 0.34, issue: 0.66 } as const

/** guardrail：类型分数落在分界带内时取副作用更小的标签（需求 > 咨询 > 闲聊）。 */
export const GUARDRAIL_EDGE_MARGIN = 0.12

/** 校验 Provider 答案；不合法返回原因，合法返回 null。 */
export function validateAnswers(answers: DecisionAnswers): string | null {
  const entries = [
    ['needsFollowup', answers.needsFollowup],
    ['kindScore', answers.kindScore],
    ['urgency', answers.urgency],
  ] as const
  for (const [name, value] of entries) {
    if (!Number.isFinite(value) || value < 0 || value > 1) return `${name}:概率越界`
  }
  return null
}

export function kindFromScore(score: number): MemberMessageKind {
  if (score < KIND_BANDS.chat) return 'chat'
  if (score < KIND_BANDS.issue) return 'question'
  return 'issue'
}

/** guardrail：只朝更保守方向移动，避免边界误判把真实需求当闲聊放掉。 */
export function guardedKind(score: number): MemberMessageKind {
  const kind = kindFromScore(score)
  if (kind === 'chat' && score >= KIND_BANDS.chat - GUARDRAIL_EDGE_MARGIN) return 'question'
  if (kind === 'question' && score >= KIND_BANDS.issue - GUARDRAIL_EDGE_MARGIN) return 'issue'
  return kind
}

/**
 * 置信度：取关键项的最小值（缺一个高置信，整体就降）。
 * kindScore 的置信度 = 到最近分界线的距离 / 半带宽（0.34）归一。
 */
export function confidenceOf(answers: DecisionAnswers): number {
  const followupConf = answers.needsFollowup >= NEEDS_FOLLOWUP_THRESHOLD ? answers.needsFollowup : 1 - answers.needsFollowup
  const edges = [0, KIND_BANDS.chat, KIND_BANDS.issue, 1]
  const margin = Math.min(...edges.map(edge => Math.abs(answers.kindScore - edge)))
  const kindConf = margin / KIND_BANDS.chat
  return Math.min(followupConf, kindConf, answers.urgency)
}

/** 固定路由表：由答案与身份派生动作与 toolScope。 */
export function routeVerdict(answers: DecisionAnswers, toolScope: ToolScope): DecisionVerdict {
  const needsFollowup = answers.needsFollowup >= NEEDS_FOLLOWUP_THRESHOLD
  const kind = guardedKind(answers.kindScore)
  const action: DecisionAction = !needsFollowup ? 'ignore' : kind === 'issue' ? 'analysis' : 'reply'
  return {
    specId: USER_MSG_DECISION_SPEC.specId,
    specVersion: USER_MSG_DECISION_SPEC.specVersion,
    kind,
    needsFollowup,
    urgency: answers.urgency,
    confidence: confidenceOf(answers),
    action,
    toolScope,
    degraded: false,
  }
}

/** Provider 失败时的保守兜底：当最坏情况（需要跟进、疑似需求）处理，避免静默丢需求。 */
export function fallbackVerdict(toolScope: ToolScope): DecisionVerdict {
  return {
    specId: USER_MSG_DECISION_SPEC.specId,
    specVersion: USER_MSG_DECISION_SPEC.specVersion,
    kind: 'issue',
    needsFollowup: true,
    urgency: 0.5,
    confidence: 0,
    action: 'analysis',
    toolScope,
    degraded: true,
  }
}
