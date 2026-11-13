/**
 * 事件总线的领域内核：统一事件契约、确定性规则、判定融合与成本闸门。
 *
 * 这里的函数全是纯函数：不读时钟、不读配置、不碰 IO。
 * 时间窗与预算的判定结果只由入参决定，便于在测试里复现。
 */
import { isSmallTalk } from './admission.js'

/** 事件来源族：决定默认基线优先级与成本档位。 */
export type EventFamily = 'message' | 'issue' | 'webhook' | 'timer'

/** 处理档位：直派 / 审核 / 归档 / 丢弃。 */
export type EventTier = 't0' | 't1' | 't2' | 't3'

/** 队列状态机。 */
export type EventQueueState =
  | 'queued'
  | 'triaged'
  | 'ready'
  | 'dispatched'
  | 'pending_review'
  | 'deferred'
  | 'dropped'
  | 'expired'
  | 'archived'

/** 全部处理档位；配置与面板都用它校验取值。 */
export const EVENT_TIERS: readonly EventTier[] = ['t0', 't1', 't2', 't3']

/** 全部队列状态；面板筛选与统计都用它。 */
export const EVENT_QUEUE_STATES: readonly EventQueueState[] = [
  'queued',
  'triaged',
  'ready',
  'dispatched',
  'pending_review',
  'deferred',
  'dropped',
  'expired',
  'archived',
]

/** 成本档位：决定预算与批处理策略。 */
export type EventCostClass = 'free' | 'cheap' | 'llm' | 'heavy'

/** 事件发起者类型。 */
export type EventActorType = 'user' | 'bot' | 'system' | 'external'

/**
 * 统一事件契约。
 *
 * 所有来源都归一化成这个形状：来源只提供幂等键、基线优先级、成本档位与归属泳道，
 * **不决定处理方式**——是否处理、什么优先级、要不要人介入全部由判定层回答。
 */
export interface EventEnvelope {
  /** 内部事件号（Router 生成）。 */
  id: string
  /** 来源插件 id：feishu-message / ops-chat / github-issue / webhook / cron。 */
  source: string
  /** 事件类型，小写点分：user.message / issue.opened / timer.fired。 */
  type: string
  /** 来源侧稳定去重键；幂等三元组的第一段。 */
  externalId: string
  /** 出站回复通道：这条事件最终回哪个群 / 私聊。 */
  channelId?: string
  /** 对象标识，只允许 [A-Za-z0-9#._:/@-]；会进模型提示词。 */
  subject: string
  /** 一句话摘要（≤200 字）。 */
  summary: string
  /** 原文（不进提示词，只作资料）。 */
  detail?: string
  /** 原文引用（落文件路径），不进提示词。 */
  detailRef?: string
  /** 原始链接。 */
  link?: string
  /** 发起者。 */
  actor: { id: string; name: string; type: EventActorType }
  /** 归属群：消息类事件有，Issue / Webhook 一般没有。 */
  chatId?: string
  /** 绑定的项目；决定 repo / branch。 */
  project?: string
  /** 归属泳道：同一 lane 串行处理。 */
  lane: string
  /** 来源给出的基线优先级 0~100（只影响排序与插队，不决定 tier）。 */
  priorityHint: number
  /** 成本档位。 */
  costClass: EventCostClass
  receivedAt: string
  /** 最晚处理时间；超过即过期。 */
  deadlineAt?: string
  /** 自产事件链深度；只由 Router 写。 */
  hops: number
  /** 自产事件的父事件。 */
  parentEventId?: string
}

/**
 * 事件来源端口。
 *
 * 拉取型来源实现 `poll`；推送型来源实现 `start`，把事件交给 sink。
 * 两种方式产出的事件完全同构，后面走同一条判定链。
 *
 * 来源自己持有凭据与筛选口径：来源只提供「接什么、给什么基线」，
 * 是否处理、什么优先级、要不要人介入全部由判定层回答。
 */
export interface EventSource {
  readonly id: string
  readonly family: EventFamily
  /** 轮询一次，拉出这段时间内新增或变更的事件。 */
  poll?(ctx: { now: string }): Promise<EventEnvelope[]>
  /** 启动推送消费。 */
  start?(sink: (event: EventEnvelope) => void): Promise<void> | void
  /** 停止推送消费。 */
  stop?(): void
}

/** 判定 spec：写死带版本号，配置只切换 Provider。 */
export const EVENT_TRIAGE_SPEC = {
  specId: 'event.triage.v1',
  specVersion: 1,
  questions: {
    needsHandling: '这条事件是否需要 Router 处理？',
    eventType: '事件属于哪一类：告警、缺陷、需求、信息、噪音？',
    priority: '处理优先级：立即、高、中、低？',
    needsHuman: '是否需要人工介入决策后才能执行？',
    projectRelated: '是否与目标项目相关？',
  },
  eventTypeOptions: ['alert', 'defect', 'request', 'info', 'noise'],
} as const

/** 判定模型的答案（全部归一化到 0~1）。 */
export interface EventModelAnswers {
  /** 是否需要处理。 */
  needsHandling: number
  /** 事件类型分数（0~1）。 */
  eventType: number
  /** 优先级分数（0~1）。 */
  priority: number
  /** 是否需要人介入。 */
  needsHuman: number
  /** 是否与目标项目相关。 */
  projectRelated: number
}

/** 是否需要处理的阈值。 */
export const NEEDS_HANDLING_THRESHOLD = 0.6

/** 是否需要人介入的阈值。 */
export const NEEDS_HUMAN_THRESHOLD = 0.5

/** 与项目相关的阈值（事件判定专用，避免与消息判定的同名常量混淆）。 */
export const EVENT_PROJECT_RELATED_THRESHOLD = 0.5

/** 低于该置信度一律进审核队列。 */
export const CONFIDENCE_THRESHOLD = 0.5

/** 规则层判定入参。 */
export interface EventRuleContext {
  /** 事件正文（摘要或原始文本）。 */
  text: string
  /** 是否是机器人。 */
  isBot?: boolean
  /** 发起人是否是管理员。 */
  isAdmin?: boolean
  /** 群消息处理范围。 */
  chatScope?: 'admins' | 'mention' | 'all'
  /** 是否寻址到机器人。 */
  addressed?: boolean
  /** 是否绑定了项目。 */
  hasProject?: boolean
  /** 判定是否能落成一句授权范围。 */
  hasScope?: boolean
  /** 幂等命中。 */
  duplicate?: boolean
  /** 基线优先级。 */
  priorityHint: number
  /** 预算是否耗尽。 */
  budgetExceeded?: boolean
  /** 当前时间窗是否放行。 */
  windowClosed?: boolean
}

/** 规则层结论。 */
export interface EventRuleVerdict {
  /** drop：丢弃；defer：延后；triage：交给决策模型。 */
  outcome: 'drop' | 'defer' | 'triage'
  /** 稳定的机器可读原因。 */
  reason: string
  /** 规则算出的优先级 0~100。 */
  priority: number
  /** 规则是否要求人介入。 */
  needsHuman: boolean
}

/** 生产告警关键词：命中即拉到最高优先级。 */
const SEVERITY0_PATTERN = /(线上|生产|故障|宕机|数据丢失|5xx|资损|阻塞发布)/i

/** 严重问题关键词：命中即提高优先级。 */
const SEVERITY1_PATTERN = /(疑似\s*bug|报错|异常|失败|崩溃|体验问题|数据不对)/i

/**
 * 规则层判定：形态、身份与预算这类不需要语义的事。
 *
 * 顺序即优先级：重复 > 机器人 > 噪声 > 群范围 > 预算 > 时间窗 > 人介入 > 优先级。
 * 命中「丢弃 / 延后」即返回，不再继续。
 */
export function eventRulesOf(ctx: EventRuleContext): EventRuleVerdict {
  const priority = ctx.priorityHint
  if (ctx.duplicate) return { outcome: 'drop', reason: 'event:duplicate', priority, needsHuman: false }
  if (ctx.isBot) return { outcome: 'drop', reason: 'event:bot-ignored', priority, needsHuman: false }
  if (isSmallTalk(ctx.text)) return { outcome: 'drop', reason: 'event:noise', priority, needsHuman: false }
  if (ctx.chatScope === 'admins' && !ctx.isAdmin) {
    return { outcome: 'drop', reason: 'event:scope-admins', priority, needsHuman: false }
  }
  if (ctx.chatScope === 'mention' && !ctx.isAdmin && !ctx.addressed) {
    return { outcome: 'drop', reason: 'event:scope-mention', priority, needsHuman: false }
  }
  if (ctx.budgetExceeded) return { outcome: 'defer', reason: 'event:budget-exceeded', priority, needsHuman: false }
  if (ctx.windowClosed) return { outcome: 'defer', reason: 'event:window-closed', priority, needsHuman: false }

  let boosted = priority
  if (ctx.isAdmin) boosted = Math.max(boosted, 90)
  if (SEVERITY0_PATTERN.test(ctx.text)) boosted = Math.max(boosted, 95)
  else if (SEVERITY1_PATTERN.test(ctx.text)) boosted = Math.max(boosted, 75)

  if (!ctx.hasProject) {
    return { outcome: 'triage', reason: 'event:project-unbound', priority: boosted, needsHuman: true }
  }
  if (!ctx.hasScope) {
    return { outcome: 'triage', reason: 'event:scope-undecidable', priority: boosted, needsHuman: true }
  }
  return { outcome: 'triage', reason: 'event:to-triage', priority: boosted, needsHuman: false }
}

/** 融合后的判定结论。 */
export interface MergedTriage {
  tier: EventTier
  /** 最终优先级 0~100。 */
  priority: number
  /** 稳定的机器可读原因。 */
  reason: string
  /** 整体置信度。 */
  confidence: number
  /** 判定来源。 */
  decidedBy: 'rule' | 'jev'
}

/**
 * 融合规则层与决策模型。
 *
 * tier 由「是否处理 / 是否相关 / 要不要人 / 置信度」决定，与来源无关；
 * 优先级取规则与模型的较高者（保守），只影响排序与插队。
 */
export function mergeTriage(
  rule: { priority: number; needsHuman: boolean; confidence: number },
  model: EventModelAnswers,
): MergedTriage {
  const modelPriority = Math.round(model.priority * 100)
  const priority = Math.max(rule.priority, modelPriority)
  const confidence = Math.min(rule.confidence, modelConfidenceOf(model))
  if (model.needsHandling < NEEDS_HANDLING_THRESHOLD) {
    return { tier: 't3', priority, reason: 'event:not-handled', confidence, decidedBy: 'jev' }
  }
  if (model.projectRelated < EVENT_PROJECT_RELATED_THRESHOLD) {
    return { tier: 't2', priority, reason: 'event:unrelated', confidence, decidedBy: 'jev' }
  }
  if (rule.needsHuman) {
    return { tier: 't1', priority, reason: 'event:rule-needs-human', confidence, decidedBy: 'jev' }
  }
  if (model.needsHuman >= NEEDS_HUMAN_THRESHOLD) {
    return { tier: 't1', priority, reason: 'event:needs-human', confidence, decidedBy: 'jev' }
  }
  if (confidence < CONFIDENCE_THRESHOLD) {
    return { tier: 't1', priority, reason: 'event:low-confidence', confidence, decidedBy: 'jev' }
  }
  return { tier: 't0', priority, reason: 'event:ready', confidence, decidedBy: 'jev' }
}

/** 模型答案自身的置信度：关键项到阈值的距离取最小值。 */
export function modelConfidenceOf(model: EventModelAnswers): number {
  const handling = model.needsHandling >= NEEDS_HANDLING_THRESHOLD
    ? model.needsHandling
    : 1 - model.needsHandling
  const human = model.needsHuman >= NEEDS_HUMAN_THRESHOLD ? model.needsHuman : 1 - model.needsHuman
  const related = model.projectRelated >= EVENT_PROJECT_RELATED_THRESHOLD
    ? model.projectRelated
    : 1 - model.projectRelated
  return Math.min(handling, human, related, model.priority)
}

/** 优先级分数 → 处理档位。 */
export function tierOfPriority(priority: number): EventTier {
  if (priority >= 85) return 't0'
  if (priority >= 60) return 't1'
  if (priority >= 35) return 't2'
  return 't3'
}

/** 时间窗配置。 */
export interface EventWindow {
  id: string
  /** 'HH:MM'，本地时间。 */
  from: string
  /** 'HH:MM'，本地时间；可以跨零点（22:00 → 06:00）。 */
  to: string
  /** 该窗口放行的档位。 */
  allow: EventTier[]
  /** 该窗口是否开启批量合并。 */
  batch?: boolean
}

/** 时间窗判定结果。 */
export interface WindowDecision {
  allowed: boolean
  /** 不放行时，下一个放行窗口的开始时间（'HH:MM'）。 */
  nextStart?: string
  /** 命中的窗口 id。 */
  windowId?: string
}

function minutesOf(time: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!match) return 0
  return Number(match[1]) * 60 + Number(match[2])
}

function formatMinutes(total: number): string {
  const wrapped = ((total % 1440) + 1440) % 1440
  const hours = Math.floor(wrapped / 60)
  const minutes = wrapped % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/** 窗口是否覆盖某个时刻（from <= to 不跨零点，from > to 跨零点）。 */
function windowCovers(window: EventWindow, current: number): boolean {
  const from = minutesOf(window.from)
  const to = minutesOf(window.to)
  if (from <= to) return current >= from && current < to
  return current >= from || current < to
}

/**
 * 当前时刻命中的批量合并窗口；没有就返回空。
 *
 * 批量只发生在窗口里：低峰窗口把同源事件合并成一次模型调用，
 * 高峰窗口不许合并——时间窗必须先于批量，否则批量会在高峰期偷偷跑。
 */
export function batchWindowAt(windows: EventWindow[], timeOfDay: string): EventWindow | undefined {
  const current = minutesOf(timeOfDay)
  return windows.find(window => window.batch === true && windowCovers(window, current))
}

/**
 * 时间窗判定。
 *
 * `timeOfDay` 是本地时间 'HH:MM'；窗口为空表示一直放行。
 * 不放行时给出下一个放行窗口的开始时间，供延后使用。
 */
export function windowAllows(windows: EventWindow[], tier: EventTier, timeOfDay: string): WindowDecision {
  if (windows.length === 0) return { allowed: true }
  const current = minutesOf(timeOfDay)
  for (const window of windows) {
    if (!window.allow.includes(tier)) continue
    if (windowCovers(window, current)) return { allowed: true, windowId: window.id }
  }
  let best: { start: number; id: string } | null = null
  for (const window of windows) {
    if (!window.allow.includes(tier)) continue
    const from = minutesOf(window.from)
    const delta = (from - current + 1440) % 1440
    if (!best || delta < best.start) best = { start: delta, id: window.id }
  }
  if (!best) return { allowed: false }
  const from = minutesOf(windows.find(window => window.id === best.id)?.from ?? '00:00')
  return { allowed: false, nextStart: formatMinutes(from), windowId: best.id }
}

/** 预算配置；0 或缺省表示不限制。 */
export interface EventBudget {
  dailyTokens?: number
  dailyEvents?: number
}

/** 预算用量。 */
export interface EventBudgetUsage {
  tokens: number
  events: number
}

/** 预算判定结果。 */
export interface BudgetState {
  exceeded: boolean
  reason?: 'tokens' | 'events'
}

/** 预算判定：任一上限被突破即为耗尽。 */
export function budgetState(budget: EventBudget, usage: EventBudgetUsage): BudgetState {
  const tokenLimit = budget.dailyTokens ?? 0
  const eventLimit = budget.dailyEvents ?? 0
  if (tokenLimit > 0 && usage.tokens >= tokenLimit) return { exceeded: true, reason: 'tokens' }
  if (eventLimit > 0 && usage.events >= eventLimit) return { exceeded: true, reason: 'events' }
  return { exceeded: false }
}

/** subject 白名单：只允许标识符字符，避免外部文本进提示词指令槽。 */
const SUBJECT_PATTERN = /^[A-Za-z0-9#._:/@-]+$/

/** subject 是否合法。 */
export function eventSubjectValid(subject: string): boolean {
  return subject.length > 0 && subject.length <= 200 && SUBJECT_PATTERN.test(subject)
}

/** 幂等键：(source, externalId)。 */
export function eventKey(source: string, externalId: string): string {
  return `${source}:${externalId}`
}
