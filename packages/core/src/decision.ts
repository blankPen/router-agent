/**
 * 决策内核：普通成员消息（UserMsgDecision，msg.user.v2）的纯规则部分。
 *
 * 只回答「要不要跟进、是什么类型、是否与项目相关、用什么方式处理」；
 * 动作与 toolScope 由固定路由表按身份映射派生，模型不能指定。
 * spec 写死在代码里带版本号，配置只切换 Provider，不允许改问题、枚举、阈值与路由表。
 */
import type { ToolScope } from './tool-scope.js'

export const USER_MSG_DECISION_SPEC = {
  specId: 'msg.user.v2',
  specVersion: 2,
  questions: {
    needsFollowup: '这条普通成员消息是否需要 Router 跟进处理？',
    msgType: '这条消息属于哪一类：闲聊、吐槽、咨询、需求反馈？',
    projectRelated: '这条消息是否与本群绑定的项目相关？',
    urgency: '这条消息的紧迫程度（0=不紧急，1=非常紧急）？',
  },
  /** msgType 的档位（score 的 criteria）。 */
  msgTypeOptions: ['chitchat', 'grumble', 'consult', 'feedback'],
} as const

export type MemberMessageKind = 'chitchat' | 'grumble' | 'consult' | 'feedback'

export const MEMBER_MESSAGE_KINDS: readonly MemberMessageKind[] = ['chitchat', 'grumble', 'consult', 'feedback']

/** 决策模型返回的原始答案（概率与分数全部归一化到 0~1）。 */
export interface DecisionAnswers {
  /** 0~1：是否需要跟进。 */
  needsFollowup: number
  /** 0~1：消息类型分数，四档（chitchat / grumble / consult / feedback）。 */
  msgTypeScore: number
  /** 0~1：是否与本群绑定的项目相关。 */
  projectRelated: number
  /** 0~1：紧迫度。 */
  urgency: number
}

export type DecisionAction = 'ignore' | 'observe' | 'reply' | 'analysis'

export interface DecisionVerdict {
  specId: string
  specVersion: number
  msgType: MemberMessageKind
  needsFollowup: boolean
  projectRelated: boolean
  urgency: number
  confidence: number
  action: DecisionAction
  toolScope: ToolScope
  /** 决策层降级（Provider 失败走保守兜底）时置 true。 */
  degraded: boolean
}

/** 需要跟进的置信度阈值；低于一律忽略（默认宽松：不确定就放行）。 */
export const NEEDS_FOLLOWUP_THRESHOLD = 0.6

/** 需求反馈是否与本群项目相关的判定阈值。 */
export const PROJECT_RELATED_THRESHOLD = 0.5

/** msgType 四档在 0~1 上的分界：chitchat < 0.25 ≤ grumble < 0.5 ≤ consult < 0.75 ≤ feedback。 */
export const MSG_TYPE_BOUNDS = { chitchat: 0.25, grumble: 0.5, consult: 0.75 } as const

/** guardrail：类型分数落在分界带内时取副作用更大的标签（越靠后越接近处理）。 */
export const GUARDRAIL_EDGE_MARGIN = 0.12

/** 校验 Provider 答案；不合法返回原因，合法返回 null。 */
export function validateAnswers(answers: DecisionAnswers): string | null {
  const numbers: Array<[string, number]> = [
    ['needsFollowup', answers.needsFollowup],
    ['msgTypeScore', answers.msgTypeScore],
    ['projectRelated', answers.projectRelated],
    ['urgency', answers.urgency],
  ]
  for (const [name, value] of numbers) {
    if (!Number.isFinite(value) || value < 0 || value > 1) return `${name}:概率越界`
  }
  return null
}

/** score 归一化值（0~1）→ 档位下标（0~3），映射到 msgType。 */
export function msgTypeFromScore(score: number): MemberMessageKind {
  const index = Math.min(MEMBER_MESSAGE_KINDS.length - 1, Math.max(0, Math.round(score * (MEMBER_MESSAGE_KINDS.length - 1))))
  return MEMBER_MESSAGE_KINDS[index]!
}

/** guardrail：只朝副作用更大的方向移动，避免边界误判把真实需求当闲聊放掉。 */
export function guardedMsgType(score: number): MemberMessageKind {
  const kind = msgTypeFromScore(score)
  if (kind === 'chitchat' && score >= MSG_TYPE_BOUNDS.chitchat - GUARDRAIL_EDGE_MARGIN) return 'grumble'
  if (kind === 'grumble' && score >= MSG_TYPE_BOUNDS.grumble - GUARDRAIL_EDGE_MARGIN) return 'consult'
  if (kind === 'consult' && score >= MSG_TYPE_BOUNDS.consult - GUARDRAIL_EDGE_MARGIN) return 'feedback'
  return kind
}

/**
 * 置信度：取关键项的最小值（缺一个高置信，整体就降）。
 * msgType 的置信度 = 到最近分界线的距离 / 半带宽（0.25）归一。
 */
export function confidenceOf(answers: DecisionAnswers): number {
  const followupConf = answers.needsFollowup >= NEEDS_FOLLOWUP_THRESHOLD ? answers.needsFollowup : 1 - answers.needsFollowup
  const edges = [0, MSG_TYPE_BOUNDS.chitchat, MSG_TYPE_BOUNDS.grumble, MSG_TYPE_BOUNDS.consult, 1]
  const margin = Math.min(...edges.map(edge => Math.abs(answers.msgTypeScore - edge)))
  const typeConf = margin / MSG_TYPE_BOUNDS.chitchat
  const projectConf = answers.projectRelated >= PROJECT_RELATED_THRESHOLD ? answers.projectRelated : 1 - answers.projectRelated
  return Math.min(followupConf, typeConf, projectConf, answers.urgency)
}

/** 固定路由表：由答案与身份派生动作与 toolScope。 */
export function routeVerdict(answers: DecisionAnswers, toolScope: ToolScope): DecisionVerdict {
  const needsFollowup = answers.needsFollowup >= NEEDS_FOLLOWUP_THRESHOLD
  const msgType = guardedMsgType(answers.msgTypeScore)
  const projectRelated = answers.projectRelated >= PROJECT_RELATED_THRESHOLD
  let action: DecisionAction
  if (!needsFollowup || msgType === 'chitchat') action = 'ignore'
  else if (msgType === 'grumble') action = 'observe'
  else if (msgType === 'consult') action = 'reply'
  else action = projectRelated ? 'analysis' : 'ignore'
  return {
    specId: USER_MSG_DECISION_SPEC.specId,
    specVersion: USER_MSG_DECISION_SPEC.specVersion,
    msgType,
    needsFollowup,
    projectRelated,
    urgency: answers.urgency,
    confidence: confidenceOf(answers),
    action,
    toolScope,
    degraded: false,
  }
}

/** Provider 失败时的保守兜底：当最坏情况（需要跟进、需求反馈）处理，避免静默丢需求。 */
export function fallbackVerdict(toolScope: ToolScope): DecisionVerdict {
  return {
    specId: USER_MSG_DECISION_SPEC.specId,
    specVersion: USER_MSG_DECISION_SPEC.specVersion,
    msgType: 'feedback',
    needsFollowup: true,
    projectRelated: true,
    urgency: 0.5,
    confidence: 0,
    action: 'analysis',
    toolScope,
    degraded: true,
  }
}
