/**
 * 事件总线的领域定义：队列记录、判定结论、策略配置。
 *
 * 事件与工单的区别：事件是「为什么开始干」，工单是「要干的活」。
 * 事件本身不绑定项目，归属项目与执行方式由决策模型一次判定产出。
 */

/** 事件优先级：P0 重要且紧急 … P4 明确无效（噪声）。 */
export type EventPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4'

/** 优先级从高到低，数字越小越优先。 */
export const EVENT_PRIORITIES: readonly EventPriority[] = ['P0', 'P1', 'P2', 'P3', 'P4']

/** 队列里的业务状态。待审核是四类业务状态之一。 */
export type EventStatus = 'pending' | 'review' | 'done' | 'invalid'

/** 执行态：与业务状态并行记录，用来表达「为什么还没做完」。 */
export type EventExecution = 'none' | 'deferred' | 'retry' | 'failed'

/** 归一化优先级；认不出的值按 P3（不重要不紧急）处理。 */
export function normalizeEventPriority(value: unknown): EventPriority {
  const text = String(value ?? '').trim().toUpperCase()
  return (EVENT_PRIORITIES as readonly string[]).includes(text) ? (text as EventPriority) : 'P3'
}

/** 归一化业务状态。 */
export function normalizeEventStatus(value: unknown): EventStatus {
  const text = String(value ?? '').trim()
  return text === 'pending' || text === 'review' || text === 'done' || text === 'invalid' ? text : 'pending'
}

/** 排队顺序：优先级高的先排；同级按到达时间早的先排。 */
export function compareEventPriority(a: EventPriority, b: EventPriority): number {
  return EVENT_PRIORITIES.indexOf(a) - EVENT_PRIORITIES.indexOf(b)
}

/** 决策模型一次判定的结论。 */
export interface EventVerdict {
  /** 要不要处理。false 时事件被判为无效（P4）。 */
  actionable: boolean
  priority: EventPriority
  /** 事件类型：bug / question / ci / digest / custom … */
  eventType: string
  /** 归属项目（项目名或仓库选择器）；空表示没选出来。 */
  project: string
  /** 执行方式（skill）；空表示交给通用流程。 */
  skill: string
  /** 派工目标仓库；由项目解析得到。 */
  repo: string
  /** 派工起始分支。 */
  branch: string
  /** 要不要人审。 */
  needsReview: boolean
  /** 判定理由（人可读，面板直接展示）。 */
  reason: string
  /** 置信度 0~1；低于阈值一律转人工。 */
  confidence: number
  /** 判定依据（命中的规则或 prompt 摘要）。 */
  basis: string
}

/** 一条事件在队列里的完整状态。 */
export interface EventRecord {
  id: string
  /** 来源实例 id（配置里的订阅 id）。 */
  sourceId: string
  /** 来源种类：github / http / schedule / 自定义插件 id。 */
  sourceKind: string
  /** 来源自己的事件 id；同一来源内唯一，用于幂等。 */
  externalId: string
  title: string
  body: string
  /** 事件在来源侧的链接（回写时用）。 */
  url?: string
  /** 来源原始载荷，便于审计与回放。 */
  raw?: unknown
  receivedAt: string
  status: EventStatus
  execution: EventExecution
  priority: EventPriority
  eventType: string
  /** 归属项目（判定产物）。 */
  project?: string
  /** 派工目标仓库。 */
  repo?: string
  /** 派工起始分支。 */
  branch?: string
  /** 执行方式（skill）。 */
  skill?: string
  /** 要不要人审。 */
  needsReview: boolean
  /** 判定理由。 */
  reason?: string
  /** 置信度 0~1。 */
  confidence?: number
  /** 判定时使用的决策 prompt 版本。 */
  promptVersion?: number
  /** 判定时命中的规则名或 'model'。 */
  basis?: string
  /** 开出的工单 id。 */
  ticketId?: string
  /** 合成出来的 Trigger id（事件复用现有派工链路时用）。 */
  triggerId?: string
  /** 判定完成时间。 */
  decidedAt?: string
  updatedAt: string
  /** 判定 / 执行尝试次数。 */
  attempts: number
  /** 最近一次失败原因。 */
  lastError?: string
}

/** 高低峰时间窗。优先级在窗口内才允许自动执行。 */
export interface EventWindow {
  /** HH:mm。 */
  start: string
  /** HH:mm；可以跨零点（start > end 表示跨天）。 */
  end: string
  /** 这个窗口允许自动执行的优先级。 */
  priorities: EventPriority[]
}

/** 事件管线的全局策略：时间窗、预算、审核通知。 */
export interface EventPolicySettings {
  /** 高峰时段：只做这几档。 */
  peak: EventWindow
  /** 低峰时段：批量做低优任务。 */
  offPeak: EventWindow
  /** 每日 token 上限；0 表示不限。 */
  dailyTokenBudget: number
  /** 单来源每日事件条数上限；0 表示不限。 */
  perSourceDailyLimit: number
  /** 待审核事件是否推送给管理员。 */
  reviewNotify: boolean
  /** 审核通知发到哪个会话（飞书 chat id）；空表示只落面板。 */
  reviewChatId: string
}

/** 决策策略配置：判定依据（自然语言 prompt）与护栏。 */
export interface EventDecisionSettings {
  /** 判定用哪个模型：jev 优先，llm 用同一份 spec 模拟，rule 只用规则。 */
  provider: 'jev' | 'llm' | 'rule'
  /** 自然语言判定规则：写清哪类事件归哪个项目、走哪个 skill、多急算急。 */
  prompt: string
  /** 置信度低于该值一律转人工审核。 */
  confidenceThreshold: number
  /** 判定失败或选不中时的兜底：review 转人工，pending 留队。 */
  fallback: 'review' | 'pending'
}

/** 决策 prompt 的版本号；每次改动 +1，历史判定可回放。 */
export interface EventDecisionPrompt {
  version: number
  text: string
  updatedAt: string
}
