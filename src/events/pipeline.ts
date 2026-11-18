/**
 * 事件管线：事件进队列 → 决策 → 分级派发。
 *
 * 分级派发只有两条路：
 * - 直接开单：判定明确、落在当前时间窗、预算够 → 合成工单，交给现有 Worker 链路；
 * - 推人工：判定拿不准、命中风险、窗口/预算不允许 → 进待审核队列，通知 admin。
 *
 * 事件本身不绑定项目：归属项目与执行方式由决策模型一次判定产出。
 */
import type { AppConfig, EventSourceConfig, ProjectConfig } from '../config.js'
import { eventNotifyChat } from '../config.js'
import type { Engine } from '../core/engine.js'
import type { Store } from '../store/db.js'
import type { EventPriority, EventRecord, EventVerdict } from '#core/event.js'
import { normalizeEventPriority } from '#core/event.js'
import type { Ticket, Trigger } from '#core/model.js'
import { preview } from '#core/events.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import type { EventEnvelope, EventSource } from '#event/port.js'
import type { EventDecisionResult, EventDecisionService } from './decision.js'
import { findEventSkill } from './skills.js'
import { ruleForEvent, type EventRule } from './rules.js'

/** 事件判定最多重试几次；超过就标成失败态等人处理，不再无限重试。 */
export const MAX_EVENT_ATTEMPTS = 5

/** 一次判定的完整结果：结论 + 事件回填字段。 */
export interface EventDecisionOutcome {
  event: EventRecord
  verdict: EventVerdict
  basis: string
}

export interface EventPipelineDeps {
  store: Store
  engine: Engine
  /** 当前配置（面板改完立即生效）。 */
  config: () => AppConfig
  clock: () => string
  ids: (prefix: string) => string
  decision: EventDecisionService
  logger?: Logger
  /** 需要人工审核时回调（服务层据此通知 admin）。 */
  onReview?: (event: EventRecord, verdict: EventVerdict) => void | Promise<void>
  /** 派工成功后回调（服务层据此刷新面板）。 */
  onDispatched?: (event: EventRecord, ticket: Ticket) => void | Promise<void>
}

/** 面板上的事件操作。 */
export type EventAction = 'approve' | 'reject' | 'defer' | 'ignore' | 'retry' | 'priority'

/** 一次操作的结果。 */
export interface EventActionResult {
  event: EventRecord
  /** 操作后是否已经开出工单。 */
  ticketId?: string
}

export class EventPipeline {
  private store: Store
  private engine: Engine
  private config: () => AppConfig
  private clock: () => string
  private ids: (prefix: string) => string
  private decision: EventDecisionService
  private logger: Logger
  private onReview?: (event: EventRecord, verdict: EventVerdict) => void | Promise<void>
  private onDispatched?: (event: EventRecord, ticket: Ticket) => void | Promise<void>

  constructor(deps: EventPipelineDeps) {
    this.store = deps.store
    this.engine = deps.engine
    this.config = deps.config
    this.clock = deps.clock
    this.ids = deps.ids
    this.decision = deps.decision
    this.logger = deps.logger ?? noopLogger
    this.onReview = deps.onReview
    this.onDispatched = deps.onDispatched
  }

  /**
   * 事件入队：同一来源的同一 externalId 只入一次。
   * 返回落库后的事件；重复事件返回已有那条。
   */
  ingest(sourceId: string, source: EventSourceConfig, envelope: EventEnvelope): EventRecord {
    const now = this.clock()
    const eventType = envelope.eventType ?? ''
    const rule = this.ruleOfEvent(this.config(), eventType)
    const event: EventRecord = {
      id: this.ids('evt'),
      sourceId,
      sourceKind: source.kind ?? 'event',
      externalId: envelope.externalId,
      title: envelope.title,
      body: envelope.body,
      ...(envelope.url ? { url: envelope.url } : {}),
      ...(envelope.raw === undefined ? {} : { raw: envelope.raw }),
      ...(envelope.context ? { context: envelope.context } : {}),
      receivedAt: envelope.receivedAt ?? now,
      status: rule ? 'pending' : 'undecided',
      execution: 'none',
      // 订阅是纯粹的：入队时不预设优先级与类型，判定阶段再定。
      priority: 'P3',
      eventType,
      ...(rule ? { ruleId: rule.id } : {}),
      needsReview: false,
      ...(!rule ? { reason: '未匹配到决策规则' } : {}),
      updatedAt: now,
      attempts: 0,
    }
    const inserted = this.store.insertEvent(event)
    if (!inserted) {
      // 重复事件按 (来源, externalId) 判定：来源保证同一事件的 externalId 稳定，
      // 命中即说明这条已经入过队，直接返回原记录，不改写它的内容与状态。
      const existing = this.store.getEventByExternalId(sourceId, envelope.externalId)
      if (existing) {
        this.logger.info('event:duplicate', { eventId: existing.id, sourceId, externalId: envelope.externalId })
        return existing
      }
    }
    this.logger.info('event:ingested', {
      eventId: event.id,
      sourceId,
      sourceKind: event.sourceKind,
      externalId: event.externalId,
      title: preview(event.title, 120),
      status: event.status,
      ruleId: event.ruleId,
    })
    if (!rule) {
      this.logger.info('event:rule-unmatched', { eventId: event.id, eventType, sourceId })
    }
    return event
  }

  /**
   * 处理一批待判定事件：判定 → 分级派发。
   * 判定失败、窗口不允许、预算用完都不丢事件，只是留在队列里等下一轮。
   */
  async tick(limit = 20): Promise<EventDecisionOutcome[]> {
    const outcomes: EventDecisionOutcome[] = []
    for (const event of this.store.claimPendingEvents(limit)) {
      try {
        const outcome = await this.process(event)
        if (outcome) outcomes.push(outcome)
      } catch (error) {
        this.logger.error('event:process-failed', {
          eventId: event.id,
          sourceId: event.sourceId,
          message: errorMessage(error),
        })
        this.markFailed(event, errorMessage(error))
      }
    }
    // 已判定但还没派出去的事件（顺延等待窗口的）：只重跑闸门，不重新判定。
    for (const event of this.store.listDecidedUndispatched(limit)) {
      try {
        const outcome = await this.retryDispatch(event)
        if (outcome) outcomes.push(outcome)
      } catch (error) {
        this.logger.error('event:process-failed', {
          eventId: event.id,
          sourceId: event.sourceId,
          message: errorMessage(error),
        })
      }
    }
    return outcomes
  }

  /**
   * 重试派发：事件已经判定过，只是当时窗口或配额没放行。
   * 这里复用原判定结论，不重新调模型 —— 判定一次就够，等的是窗口不是答案。
   */
  private async retryDispatch(event: EventRecord): Promise<EventDecisionOutcome | null> {
    const config = this.config()
    const verdict = this.verdictOf(event)
    const gate = this.gateOf(config, event)
    if (!gate.allowed) {
      const deferred = { ...event, execution: 'deferred' as const, reason: gate.reason, updatedAt: this.clock() }
      this.store.updateEvent(deferred)
      return { event: deferred, verdict, basis: event.basis ?? 'event-decision' }
    }
    const dispatched = await this.dispatch(deferred0(event), verdict)
    if (!dispatched) {
      const failed = { ...event, status: 'review' as const, needsReview: true, reason: '开单失败，转人工处理', updatedAt: this.clock() }
      this.store.updateEvent(failed)
      await this.onReview?.(failed, verdict)
      return { event: failed, verdict, basis: event.basis ?? 'event-decision' }
    }
    return dispatched
  }

  /** 从已判定的事件记录还原判定结论（不重新调模型）。 */
  private verdictOf(event: EventRecord): EventVerdict {
    return {
      actionable: true,
      priority: event.priority,
      eventType: event.eventType || 'event',
      project: event.project ?? '',
      skill: event.skill ?? '',
      repo: event.repo ?? '',
      branch: event.branch ?? '',
      needsReview: false,
      decided: true,
      reason: event.reason ?? '',
      confidence: event.confidence ?? 1,
      basis: event.basis ?? '',
    }
  }

  /** 判定并派发一条事件。 */
  async process(event: EventRecord): Promise<EventDecisionOutcome | null> {
    const config = this.config()
    const source = config.events.sources[event.sourceId] ?? { enabled: false }
    const rule = this.ruleOfEvent(config, event.eventType)
    if (!rule) {
      const undecided: EventRecord = {
        ...event,
        status: 'undecided',
        execution: 'none',
        reason: '未匹配到决策规则',
        decidedAt: undefined,
        updatedAt: this.clock(),
      }
      this.store.updateEvent(undecided)
      this.logger.info('event:rule-unmatched', { eventId: event.id, eventType: event.eventType, sourceId: event.sourceId })
      return null
    }
    this.logger.info('event:rule-matched', {
      eventId: event.id,
      ruleId: rule.id,
      eventType: event.eventType,
      ruleVersion: rule.version,
    })
    const result = await this.decision.decide({
      event,
      source,
      rule,
      projects: this.projectsOf(config),
      decision: config.events.decision,
    })
    const verdict = result.verdict
    const decided: EventRecord = {
      ...event,
      status: verdict.actionable ? 'pending' : 'invalid',
      execution: 'none',
      priority: verdict.priority,
      eventType: verdict.eventType,
      ...(verdict.project ? { project: verdict.project } : {}),
      ...(verdict.repo ? { repo: verdict.repo } : {}),
      ...(verdict.branch ? { branch: verdict.branch } : {}),
      ...(verdict.skill ? { skill: verdict.skill } : {}),
      needsReview: verdict.needsReview,
      reason: verdict.reason,
      confidence: verdict.confidence,
      basis: result.basis,
      ruleId: rule.id,
      ruleVersion: rule.version,
      decidedAt: this.clock(),
      updatedAt: this.clock(),
      lastError: undefined,
    } as EventRecord

    if (!verdict.actionable) {
      this.store.updateEvent(decided)
      this.logger.info('event:invalid', { eventId: event.id, sourceId: event.sourceId, reason: preview(verdict.reason, 120) })
      return { event: decided, verdict, basis: result.basis }
    }

    // 判定没完成（模型失败等）：事件留在队列里等下一轮，不能派工也不能丢。
    if (!verdict.decided) {
      // 一直判不出来就停手：标成失败态等人处理，不无限重试烧钱。
      if (event.attempts >= MAX_EVENT_ATTEMPTS) {
        const failed = {
          ...decided,
          status: 'review' as const,
          execution: 'failed' as const,
          needsReview: true,
          reason: `判定连续失败 ${event.attempts} 次，转人工处理`,
          lastError: verdict.reason.slice(0, 300),
          updatedAt: this.clock(),
        }
        this.store.updateEvent(failed)
        this.logger.error('event:attempts-exceeded', {
          eventId: event.id,
          sourceId: event.sourceId,
          ruleId: rule.id,
          attempts: event.attempts,
          message: preview(verdict.reason, 120),
        })
        await this.onReview?.(failed, verdict)
        return { event: failed, verdict, basis: result.basis }
      }
      const waiting = { ...decided, status: 'pending' as const, execution: 'retry' as const, decidedAt: undefined, updatedAt: this.clock() }
      this.store.updateEvent(waiting)
      this.logger.warn('event:decision-incomplete', {
        eventId: event.id,
        sourceId: event.sourceId,
        ruleId: rule.id,
        reason: preview(verdict.reason, 120),
      })
      return { event: waiting, verdict, basis: result.basis }
    }

    // 需要人审：不派工，进待审核队列。
    if (verdict.needsReview) {
      const reviewed: EventRecord = { ...decided, status: 'review' }
      this.store.updateEvent(reviewed)
      this.logger.info('event:review-queued', {
        eventId: event.id,
        sourceId: event.sourceId,
        priority: reviewed.priority,
        reason: preview(verdict.reason, 120),
      })
      await this.onReview?.(reviewed, verdict)
      return { event: reviewed, verdict, basis: result.basis }
    }

    // 时间窗与预算：不允许自动执行时顺延，不丢事件。
    const gate = this.gateOf(config, decided)
    if (!gate.allowed) {
      const deferred = { ...decided, execution: 'deferred' as const, reason: gate.reason }
      this.store.updateEvent(deferred)
      this.logger.info('event:deferred', { eventId: event.id, sourceId: event.sourceId, reason: gate.reason })
      return { event: deferred, verdict, basis: result.basis }
    }

    const dispatched = await this.dispatch(deferred0(decided), verdict)
    if (!dispatched) {
      const failed = { ...decided, status: 'review' as const, needsReview: true, reason: '开单失败，转人工处理' }
      this.store.updateEvent(failed)
      await this.onReview?.(failed, verdict)
      return { event: failed, verdict, basis: result.basis }
    }
    return dispatched
  }

  /**
   * 开单：事件复用现有派工链路 —— 合成 Trigger，再走 Engine.decide 生成工单。
   * 这样工单、授权范围、Worker 派发全都沿用现状，不另造一套。
   */
  private async dispatch(event: EventRecord, verdict: EventVerdict): Promise<EventDecisionOutcome | null> {
    const trigger = this.triggerOf(event, verdict)
    if (!this.engine.ingest(trigger)) {
      // Trigger 已存在（同一事件重复处理）：不重复开单。
      const existing = this.store.listEvents({ sourceId: event.sourceId, limit: 500 }).find(item => item.triggerId === trigger.id)
      if (existing?.ticketId) {
        this.logger.info('event:already-dispatched', { eventId: event.id, ticketId: existing.ticketId })
        return { event: existing, verdict, basis: 'already-dispatched' }
      }
    }
    try {
      const outcome = this.engine.decide({
        triggerId: trigger.id,
        decision: 'accept',
        strength: 'inferred',
        reason: `事件判定：${verdict.priority} / ${verdict.eventType} / ${verdict.skill || '通用处理'} / ${verdict.reason || '按决策规则判定'}`,
        title: event.title,
        scope: this.scopeOf(event, verdict),
        request: this.requestOf(event, verdict),
        requestActorName: `事件来源 ${event.sourceId}`,
        rules: [event.basis ?? 'event-decision'],
        repo: verdict.repo,
        branch: verdict.branch,
      })
      if (!outcome.ticket) return null
      const dispatched: EventRecord = {
        ...event,
        status: 'pending',
        execution: 'none',
        ticketId: outcome.ticket.id,
        triggerId: trigger.id,
        updatedAt: this.clock(),
      }
      this.store.updateEvent(dispatched)
      this.logger.info('event:dispatched', {
        eventId: event.id,
        sourceId: event.sourceId,
        ticketId: outcome.ticket.id,
        priority: dispatched.priority,
        project: verdict.project,
        skill: verdict.skill,
      })
      await this.onDispatched?.(dispatched, outcome.ticket)
      return { event: dispatched, verdict, basis: event.basis ?? 'event-decision' }
    } catch (error) {
      this.logger.error('event:dispatch-failed', { eventId: event.id, message: errorMessage(error) })
      return null
    }
  }

  /** 面板操作：批准 / 驳回 / 延后 / 忽略 / 重试 / 改优先级。 */
  async apply(eventId: string, action: EventAction, options: { priority?: EventPriority; project?: string } = {}): Promise<EventActionResult | null> {
    const event = this.store.getEvent(eventId)
    if (!event) return null
    const now = this.clock()
    const config = this.config()

    if (action === 'priority') {
      const priority = normalizeEventPriority(options.priority ?? event.priority)
      const updated = { ...event, priority, updatedAt: now }
      this.store.updateEvent(updated)
      this.logger.info('event:priority-changed', { eventId, priority })
      return { event: updated }
    }

    if (action === 'reject' || action === 'ignore') {
      const updated = { ...event, status: 'invalid' as const, execution: 'none' as const, reason: action === 'reject' ? '人工驳回' : '人工忽略', updatedAt: now }
      this.store.updateEvent(updated)
      this.logger.info('event:ignored', { eventId, action })
      return { event: updated }
    }

    if (action === 'defer') {
      const updated = { ...event, status: 'pending' as const, execution: 'deferred' as const, reason: '人工延后', updatedAt: now }
      this.store.updateEvent(updated)
      this.logger.info('event:deferred', { eventId })
      return { event: updated }
    }

    if (action === 'retry') {
      const updated = { ...event, status: 'pending' as const, execution: 'none' as const, reason: '人工触发重试', updatedAt: now }
      this.store.updateEvent(updated)
      this.logger.info('event:retry', { eventId })
      return { event: updated }
    }

    // approve：人工拍板后直接开单，不再受时间窗限制。
    const project = options.project?.trim() || event.project || ''
    const projectConfig = this.projectsOf(config).find(item => item.name === project || item.repo === project)
    const verdict: EventVerdict = {
      actionable: true,
      priority: event.priority,
      eventType: event.eventType || 'event',
      project: projectConfig?.name ?? project,
      skill: event.skill ?? '',
      repo: projectConfig?.repo ?? event.repo ?? '',
      branch: projectConfig?.defaultBranch ?? event.branch ?? '',
      needsReview: false,
      decided: true,
      reason: '人工批准',
      confidence: 1,
      basis: 'human-approve',
    }
    if (!verdict.repo) {
      const updated = { ...event, status: 'review' as const, reason: '没有归属项目，无法开单', updatedAt: now }
      this.store.updateEvent(updated)
      return { event: updated }
    }
    const dispatched = await this.dispatch({ ...event, status: 'pending', needsReview: false, reason: '人工批准', updatedAt: now }, verdict)
    if (!dispatched) {
      const failed = { ...event, status: 'review' as const, reason: '开单失败，转人工处理', updatedAt: now }
      this.store.updateEvent(failed)
      return { event: failed }
    }
    return { event: dispatched.event, ...(dispatched.event.ticketId ? { ticketId: dispatched.event.ticketId } : {}) }
  }

  /** 时间窗与预算的闸门。 */
  private gateOf(config: AppConfig, event: EventRecord): { allowed: boolean; reason: string } {
    const policy = config.events.policy
    const window = windowOf(policy, event.priority, new Date(this.clock()))
    if (!window) {
      return { allowed: false, reason: `优先级 ${event.priority} 不在任何时间窗内，顺延等待` }
    }
    const globalLimit = policy.dailyEventLimit
    if (globalLimit > 0) {
      const total = this.store.countDispatchedEventsSince(null, startOfDay(this.clock()))
      // 已开出的工单数达到上限就顺延：配额管的是「今天最多自动执行多少条」。
      if (total >= globalLimit) {
        return { allowed: false, reason: `今日全局配额 ${globalLimit} 条已用完，顺延等待` }
      }
    }
    // 单来源每日上限只由策略统一决定，不写在订阅里。
    const sourceLimit = policy.perSourceDailyLimit
    if (sourceLimit > 0) {
      const since = startOfDay(this.clock())
      const count = this.store.countDispatchedEventsSince(event.sourceId, since)
      if (count >= sourceLimit) {
        return { allowed: false, reason: `来源 ${event.sourceId} 今日已达配额 ${sourceLimit} 条，顺延等待` }
      }
    }
    return { allowed: true, reason: '' }
  }

  /** 合成 Trigger：事件走现有派工链路的关键。 */
  private triggerOf(event: EventRecord, verdict: EventVerdict): Trigger {
    const now = this.clock()
    return {
      id: event.triggerId ?? `trg_event_${event.id}`,
      source: `event:${event.sourceId}`,
      externalId: event.externalId,
      threadId: `event:${event.sourceId}:${event.externalId}`,
      chatId: eventNotifyChat(this.config(), verdict.repo),
      chatName: event.sourceId,
      actorId: `event:${event.sourceId}`,
      actorName: `事件来源 ${event.sourceId}`,
      isBot: true,
      text: `${event.title}\n${event.body}`.trim(),
      addressed: 'none',
      receivedAt: event.receivedAt || now,
      disposition: 'pending',
      raw: { eventId: event.id, url: event.url },
    }
  }

  /** 授权范围：写清允许做什么、不允许做什么，Worker 照着做。 */
  private scopeOf(event: EventRecord, verdict: EventVerdict): string {
    const skill = verdict.skill ? findEventSkill(verdict.skill) : undefined
    const rule = this.ruleOfEvent(this.config(), event.eventType, event.ruleId)
    const lines = [
      `处理事件「${event.title}」（${verdict.eventType} / ${verdict.priority}）。`,
      `归属项目：${verdict.project || '（未指定）'}。`,
      skill ? `处理方式：${skill.name}（${skill.id}）——${skill.hint}。` : '处理方式：先补齐信息，再出方案。',
      rule?.workflowPrompt ? `执行流程：${rule.workflowPrompt}` : '',
      `授权范围：只处理本事件范围内的事；不改本仓库以外的代码；不碰生产环境与对外发布。`,
    ]
    return lines.filter(Boolean).join('\n')
  }

  /** 传给 Worker 的原始请求：事件正文 + 判定结论。 */
  private requestOf(event: EventRecord, verdict: EventVerdict): string {
    const lines = [
      `事件标题：${event.title}`,
      event.body ? `事件正文：\n${event.body}` : '',
      `事件类型：${verdict.eventType}；优先级：${verdict.priority}`,
      verdict.project ? `归属项目：${verdict.project}` : '',
      verdict.skill ? `处理方式：${verdict.skill}` : '',
      event.url ? `来源链接：${event.url}` : '',
      verdict.reason ? `判定理由：${verdict.reason}` : '',
    ]
    return lines.filter(Boolean).join('\n')
  }

  /** 候选项目清单：按当前默认运行时取。 */
  private projectsOf(config: AppConfig): ProjectConfig[] {
    return config.runtime.default === 'orca' ? config.projects : (config.runtime.projects?.[config.runtime.default] ?? [])
  }

  /** 按事件类型取规则；ruleId 优先，规则被删后回落到当前类型匹配。 */
  private ruleOfEvent(config: AppConfig, eventType: string, ruleId?: string): EventRule | undefined {
    const byId = ruleId ? config.events.rules.find(rule => rule.id === ruleId) : undefined
    return byId ?? ruleForEvent(config.events.rules, eventType)
  }

  /** 判定失败：标成失败态，保留记录等人处理。 */
  private markFailed(event: EventRecord, reason: string): void {
    this.store.updateEvent({
      ...event,
      execution: 'failed',
      lastError: reason.slice(0, 300),
      updatedAt: this.clock(),
    })
  }
}

/** 去掉 undefined 字段，避免把旧值抹成 null。 */
function deferred0(event: EventRecord): EventRecord {
  const next = { ...event }
  delete (next as { lastError?: string }).lastError
  return next
}

/**
 * 当前时间落在哪个窗口；没有匹配窗口返回 null。
 *
 * `at` 是注入的时刻，不给就用真实时间。
 * 走注入值，测试才能确定性地断言窗口判定，不随跑测时刻与时区漂移。
 */
export function windowOf(policy: AppConfig['events']['policy'], priority: EventPriority, at?: Date): { name: string } | null {
  const time = at ?? new Date()
  if (Number.isNaN(time.getTime())) return null
  const minutes = time.getHours() * 60 + time.getMinutes()
  const inWindow = (start: string, end: string): boolean => {
    const from = parseHhmm(start)
    const to = parseHhmm(end)
    if (from === null || to === null) return false
    return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to
  }
  if (policy.peak.priorities.includes(priority) && inWindow(policy.peak.start, policy.peak.end)) {
    return { name: 'peak' }
  }
  if (policy.offPeak.priorities.includes(priority) && inWindow(policy.offPeak.start, policy.offPeak.end)) {
    return { name: 'off-peak' }
  }
  return null
}

/** 解析 HH:mm；不合法返回 null。 */
export function parseHhmm(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

/** 当天零点（ISO），用于按日配额统计。 */
export function startOfDay(now: string): string {
  const at = new Date(now)
  if (Number.isNaN(at.getTime())) return now
  at.setHours(0, 0, 0, 0)
  return at.toISOString()
}
