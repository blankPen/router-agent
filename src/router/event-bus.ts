import type { Store, EventRecord, EventQueueRecord } from '../store/db.js'
import type { Engine } from '../core/engine.js'
import type { EventSettings } from '../config.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import {
  batchWindowAt,
  budgetState,
  eventRulesOf,
  eventSubjectValid,
  mergeTriage,
  tierOfPriority,
  windowAllows,
  type EventEnvelope,
  type EventModelAnswers,
  type EventRuleVerdict,
  type EventTier,
} from '#core/event.js'
import type { Trigger } from '#core/model.js'
import type { EventTriageBatchResult, EventTriagePort, EventTriageResult } from './event-triage.js'

/** 自产事件链的最大深度：超过就熔断，避免 A→B→A 自激。 */
export const MAX_EVENT_HOPS = 3

/** 预算触顶后仍值得花模型调用问一遍的优先级门槛（与 T0 同档）。 */
const URGENT_PRIORITY = 85

/** 本机面板的保留身份：没有具名身份，按本机放行处理。 */
export const LOCAL_OPERATOR = 'panel'

/** 派工目标：事件要落到哪个仓库与分支。 */
export interface DispatchPlan {
  repo: string
  branch: string
  project?: string
  /** 缺的信息（repo / branch）；非空时不能开单。 */
  missing: string[]
  /** 派工后的进展通知群；为空表示不往外发消息。 */
  chatId?: string
}

export interface EventBusOptions {
  store: Store
  engine: Engine
  /** 动态读配置：面板改完时间窗与预算立即生效。 */
  settings: () => EventSettings
  logger?: Logger
  clock?: { now(): string }
  ids?: { next(prefix: string): string }
  /** 判定层；缺省时只用规则层。 */
  triage?: EventTriagePort
  /** 把事件解析成派工目标；缺省时没有项目的事件一律待审。 */
  resolveDispatch?: (event: EventRecord) => DispatchPlan
  /** 待审核通知；缺省时只在面板里可见。 */
  notifyReview?: (event: EventRecord, queue: EventQueueRecord) => void | Promise<void>
  /** 本地时刻 'HH:MM'，用于时间窗判定。 */
  timeOfDay?: (now: string) => string
}

/** 入队结果。 */
export interface IngestOutcome {
  accepted: boolean
  eventId: string
  /** 幂等命中。 */
  duplicate: boolean
  /** 被拒绝的原因。 */
  reason?: string
}

/** 一轮处理的结果。 */
export interface TickOutcome {
  processed: number
  dispatched: number
  pending: number
  deferred: number
  dropped: number
  archived: number
}

/** 人工审核动作。 */
export type ReviewAction = 'approve' | 'reject' | 'defer'

/** 队列里待判定的一条事件：事件本体 + 规则层结论。 */
interface EventCandidate {
  event: EventRecord
  rule: EventRuleVerdict
}

/** 审核结果。 */
export interface ReviewOutcome {
  state: string
  ticketId?: string
  reason?: string
}

const defaultIds = { next: (prefix: string) => `${prefix}_${crypto.randomUUID()}` }

/** 同 lane 串行的重查间隔：在飞工单未完成时每隔这么久再判一次。 */
const LANE_RETRY_MS = 60_000

/**
 * 事件总线。
 *
 * 所有来源走同一条链路：入队 → 规则层 → 判定模型 → 融合 → 成本闸门 → 分级派发。
 * 来源只提供幂等键、基线优先级、成本档位与泳道，不决定处理方式。
 */
export class EventBus {
  private store: Store
  private engine: Engine
  private settings: () => EventSettings
  private logger: Logger
  private clock: { now(): string }
  private ids: { next(prefix: string): string }
  private triage?: EventTriagePort
  private resolveDispatch?: (event: EventRecord) => DispatchPlan
  private notifyReview?: (event: EventRecord, queue: EventQueueRecord) => void | Promise<void>
  private timeOfDay: (now: string) => string

  constructor(options: EventBusOptions) {
    this.store = options.store
    this.engine = options.engine
    this.settings = options.settings
    this.logger = options.logger ?? noopLogger
    this.clock = options.clock ?? { now: () => new Date().toISOString() }
    this.ids = options.ids ?? defaultIds
    this.triage = options.triage
    this.resolveDispatch = options.resolveDispatch
    this.notifyReview = options.notifyReview
    this.timeOfDay = options.timeOfDay ?? localTimeOfDay
  }

  /**
   * 收一条事件并入队。
   *
   * 幂等键是 (source, externalId)：外部重投不会产生第二条。
   */
  async ingest(envelope: EventEnvelope): Promise<IngestOutcome> {
    if (!eventSubjectValid(envelope.subject)) {
      this.logger.warn('event:dropped', { source: envelope.source, reason: 'event:invalid-subject' })
      return { accepted: false, eventId: envelope.id, duplicate: false, reason: 'event:invalid-subject' }
    }
    if (envelope.hops > MAX_EVENT_HOPS) {
      this.logger.warn('event:hops-exceeded', { source: envelope.source, hops: envelope.hops })
      return { accepted: false, eventId: envelope.id, duplicate: false, reason: 'event:hops-exceeded' }
    }
    const now = this.clock.now()
    const record: EventRecord = {
      id: envelope.id || this.ids.next('ev'),
      source: envelope.source,
      type: envelope.type,
      externalId: envelope.externalId,
      lane: envelope.lane,
      subject: envelope.subject,
      summary: envelope.summary,
      ...(envelope.detail ? { detail: envelope.detail } : {}),
      ...(envelope.detailRef ? { detailRef: envelope.detailRef } : {}),
      ...(envelope.link ? { link: envelope.link } : {}),
      actorId: envelope.actor.id,
      actorName: envelope.actor.name,
      actorType: envelope.actor.type,
      ...(envelope.chatId ? { chatId: envelope.chatId } : {}),
      ...(envelope.project ? { project: envelope.project } : {}),
      priorityHint: envelope.priorityHint,
      costClass: envelope.costClass,
      hops: envelope.hops,
      ...(envelope.parentEventId ? { parentEventId: envelope.parentEventId } : {}),
      receivedAt: envelope.receivedAt || now,
      ...(envelope.deadlineAt ? { deadlineAt: envelope.deadlineAt } : {}),
    }
    const inserted = this.store.insertEvent(record)
    if (!inserted) {
      this.logger.info('event:duplicate', { source: record.source, externalId: record.externalId })
      return { accepted: false, eventId: record.id, duplicate: true, reason: 'event:duplicate' }
    }
    this.store.insertEventQueue({
      eventId: record.id,
      lane: record.lane,
      priority: record.priorityHint,
      tier: '',
      state: 'queued',
      reason: 'event:ingested',
      decidedBy: 'rule',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    })
    this.logger.info('event:ingested', {
      eventId: record.id,
      source: record.source,
      type: record.type,
      lane: record.lane,
      priority: record.priorityHint,
    })
    return { accepted: true, eventId: record.id, duplicate: false }
  }

  /** 处理一轮队列：先做不花钱的前置判断，再判定（可批量合并），最后分级派发。 */
  async tick(): Promise<TickOutcome> {
    const outcome: TickOutcome = { processed: 0, dispatched: 0, pending: 0, deferred: 0, dropped: 0, archived: 0 }
    const now = this.clock.now()
    const settings = this.settings()
    const requeued = this.store.requeueDueDeferred(now)
    if (requeued > 0) this.logger.info('event:requeued', { count: requeued })
    // 背压：队列等待数超过上限时丢弃最低分事件，而不是无限堆积。
    const depth = this.store.eventQueueDepth()
    if (settings.maxQueueDepth > 0 && depth > settings.maxQueueDepth) {
      const overflow = depth - settings.maxQueueDepth
      for (const eventId of this.store.lowestQueuedIds(overflow)) {
        this.logger.warn('event:dropped', { eventId, reason: 'event:queue-overflow' })
        this.settle(eventId, { state: 'dropped', tier: 't3', reason: 'event:queue-overflow' })
        outcome.dropped += 1
      }
    }
    const pending = this.store.pickEventQueue(now, 20)
    const candidates: EventCandidate[] = []
    for (const item of pending) {
      outcome.processed += 1
      const event = this.store.getEvent(item.eventId)
      if (!event) continue
      if (event.deadlineAt && Date.parse(event.deadlineAt) < Date.parse(now)) {
        this.logger.warn('event:expired', { eventId: event.id, deadlineAt: event.deadlineAt })
        this.settle(event.id, { state: 'expired', tier: item.tier || 't3', reason: 'event:expired' })
        continue
      }

      const rule = eventRulesOf({
        text: event.summary,
        isBot: event.actorType === 'bot',
        hasProject: Boolean(event.project),
        hasScope: Boolean(event.subject),
        priorityHint: event.priorityHint,
      })
      if (rule.outcome === 'drop') {
        this.logger.warn('event:dropped', { eventId: event.id, reason: rule.reason })
        this.settle(event.id, { state: 'dropped', tier: 't3', priority: rule.priority, reason: rule.reason })
        outcome.dropped += 1
        continue
      }

      // 同 lane 串行：该泳道已有未完成工单时延后，避免同一项目被多事件并发改代码。
      if (this.store.laneHasLiveTicket(item.lane, event.id)) {
        const notBefore = new Date(Date.parse(now) + LANE_RETRY_MS).toISOString()
        this.logger.info('event:lane-busy', { eventId: event.id, lane: item.lane, notBefore })
        this.settle(event.id, {
          state: 'deferred',
          tier: tierOfPriority(item.priority),
          priority: item.priority,
          reason: 'event:lane-busy',
          notBefore,
          decidedBy: 'rule',
        })
        outcome.deferred += 1
        continue
      }

      // 预算触顶后先别问模型：规则层认定高优先级且无需人介入的事件才值得继续。
      // 否则每条事件都要先花一次判定调用，预算反而拦不住成本。
      const used = this.usage(settings, now)
      const budget = budgetState(settings.budget, used)
      if (budget.exceeded && (rule.needsHuman || rule.priority < URGENT_PRIORITY)) {
        this.logger.warn('event:budget-exceeded', {
          eventId: event.id,
          reason: budget.reason,
          used: budget.reason === 'tokens' ? used.tokens : used.events,
          limit: budget.reason === 'tokens' ? settings.budget.dailyTokens : settings.budget.dailyEvents,
        })
        this.settle(event.id, {
          state: 'deferred',
          tier: tierOfPriority(rule.priority),
          priority: rule.priority,
          reason: 'event:budget-exceeded',
          notBefore: nextDayStart(now),
          decidedBy: 'rule',
        })
        outcome.deferred += 1
        continue
      }
      candidates.push({ event, rule })
    }

    const triaged = await this.triagePhase(candidates, settings, now)
    for (const candidate of candidates) {
      const triage = triaged.get(candidate.event.id)
      if (!triage) continue
      const state = await this.finish(candidate, triage, settings, now)
      if (state === 'dispatched') outcome.dispatched += 1
      else if (state === 'pending_review') outcome.pending += 1
      else if (state === 'deferred') outcome.deferred += 1
      else if (state === 'dropped') outcome.dropped += 1
      else if (state === 'archived') outcome.archived += 1
    }
    return outcome
  }

  /**
   * 判定阶段。
   *
   * 命中批量窗口时，同 `source + type + project` 的事件合并成一次模型调用；
   * 批量调用失败就退回逐条判定——判定层不能自己吞掉错误。
   */
  private async triagePhase(
    candidates: EventCandidate[],
    settings: EventSettings,
    now: string,
  ): Promise<Map<string, EventTriageResult & { degraded: boolean }>> {
    const out = new Map<string, EventTriageResult & { degraded: boolean }>()
    const batchWindow = batchWindowAt(settings.windows, this.timeOfDay(now))
    if (!batchWindow) {
      for (const candidate of candidates) {
        const triage = await this.triageEvent(candidate.event)
        this.addTokens(triage.tokens ?? 0, now)
        out.set(candidate.event.id, triage)
      }
      return out
    }
    const groups = new Map<string, EventCandidate[]>()
    for (const candidate of candidates) {
      const key = `${candidate.event.source}|${candidate.event.type}|${candidate.event.project ?? ''}`
      const group = groups.get(key)
      if (group) group.push(candidate)
      else groups.set(key, [candidate])
    }
    for (const [key, group] of groups) {
      if (group.length < 2) {
        const candidate = group[0]!
        const triage = await this.triageEvent(candidate.event)
        this.addTokens(triage.tokens ?? 0, now)
        out.set(candidate.event.id, triage)
        continue
      }
      const batch = await this.triageBatch(group.map(candidate => candidate.event))
      if (!batch) {
        for (const candidate of group) {
          const triage = await this.triageEvent(candidate.event)
          this.addTokens(triage.tokens ?? 0, now)
          out.set(candidate.event.id, triage)
        }
        continue
      }
      this.addTokens(batch.tokens, now)
      this.logger.info('event:triage-batched', { group: key, count: group.length, tokens: batch.tokens })
      group.forEach((candidate, index) => {
        const result = batch.results[index]
        out.set(candidate.event.id, result ? { ...result, degraded: false } : this.degradedTriage(candidate.event))
      })
    }
    return out
  }

  /** 一次模型调用判一批事件；判定层不支持批量或调用失败时返回空，由上层退回逐条判定。 */
  private async triageBatch(events: EventRecord[]): Promise<EventTriageBatchResult | null> {
    if (!this.triage?.triageBatch) return null
    try {
      return await this.triage.triageBatch(events.map(event => ({
        subject: event.subject,
        summary: event.summary,
        type: event.type,
        source: event.source,
        ...(event.project ? { project: event.project } : {}),
      })))
    } catch (error) {
      this.logger.warn('event:triage-batch-failed', {
        count: events.length,
        detail: errorMessage(error).slice(0, 200),
      })
      return null
    }
  }

  /** 判定之后：融合结论、过闸门、按档位派发。 */
  private async finish(
    candidate: EventCandidate,
    triage: EventTriageResult & { degraded: boolean },
    settings: EventSettings,
    now: string,
  ): Promise<string> {
    const { event, rule } = candidate
    const merged = mergeTriage(
      { priority: rule.priority, needsHuman: rule.needsHuman, confidence: 1 },
      triage.answers,
    )
    const tier = merged.tier
    const priority = merged.priority

    const gate = this.gate(settings, tier, priority, now)
    if (gate.deferred) {
      this.logger.info('event:deferred', { eventId: event.id, notBefore: gate.notBefore, reason: gate.reason })
      return this.settle(event.id, {
        state: 'deferred',
        tier,
        priority,
        reason: gate.reason,
        notBefore: gate.notBefore,
        decidedBy: triage.degraded ? 'rule' : 'jev',
      })
    }

    this.logger.info('event:triaged', {
      eventId: event.id,
      tier,
      decidedBy: triage.degraded ? 'rule' : 'jev',
      reason: merged.reason,
      confidence: merged.confidence,
    })

    if (tier === 't0') return this.dispatch(event, tier, priority, merged.reason, triage)
    if (tier === 't1') return this.pending(event, tier, priority, merged.reason, triage)
    if (tier === 't2') return this.settle(event.id, { state: 'archived', tier, priority, reason: merged.reason })
    return this.settle(event.id, { state: 'dropped', tier, priority, reason: merged.reason })
  }

  /** 调判定模型；失败降级到「要人介入」，绝不静默丢弃事件。 */
  private async triageEvent(event: EventRecord): Promise<EventTriageResult & { degraded: boolean }> {
    if (!this.triage) return this.degradedTriage(event)
    try {
      const result = await this.triage.triage({
        subject: event.subject,
        summary: event.summary,
        type: event.type,
        source: event.source,
        ...(event.project ? { project: event.project } : {}),
      })
      return { ...result, degraded: false }
    } catch (error) {
      this.logger.warn('event:triage-failed', {
        eventId: event.id,
        detail: errorMessage(error).slice(0, 200),
      })
      return this.degradedTriage(event)
    }
  }

  /** 判定层的降级结论：一律「要人介入」，绝不静默丢弃事件。 */
  private degradedTriage(event: EventRecord): EventTriageResult & { degraded: boolean } {
    return {
      answers: { needsHandling: 1, eventType: 0.5, priority: event.priorityHint / 100, needsHuman: 1, projectRelated: 1 },
      eventTypeLabel: 'info',
      priorityLabel: 'medium',
      degraded: true,
    }
  }

  /** 成本闸门：时间窗先于预算；T0 超预算仍然放行（保响应）。 */
  private gate(
    settings: EventSettings,
    tier: EventTier,
    priority: number,
    now: string,
  ): { deferred: boolean; reason?: string; notBefore?: string } {
    // 归档与丢弃不消耗处理资源，不受时间窗与预算约束。
    if (tier === 't2' || tier === 't3') return { deferred: false }
    const window = windowAllows(settings.windows, tier, this.timeOfDay(now))
    if (!window.allowed) {
      return { deferred: true, reason: 'event:window-closed', notBefore: nextWindowStart(window.nextStart, now) }
    }
    const usage = this.usage(settings, now)
    const budget = budgetState(settings.budget, usage)
    if (budget.exceeded) {
      this.logger.warn('event:budget-exceeded', {
        reason: budget.reason,
        used: budget.reason === 'tokens' ? usage.tokens : usage.events,
        limit: budget.reason === 'tokens' ? settings.budget.dailyTokens : settings.budget.dailyEvents,
      })
      if (tier === 't0') return { deferred: false }
      return { deferred: true, reason: 'event:budget-exceeded', notBefore: nextDayStart(now) }
    }
    return { deferred: false }
  }

  /** 今日用量：事件数从库里数，token 数从游标里读。 */
  private usage(settings: EventSettings, now: string): { tokens: number; events: number } {
    const day = dayKey(now)
    const tokens = Number(this.store.getCursor(`event:tokens:${day}`) ?? 0)
    const events = this.store.countEventsSince(dayStart(now))
    void settings
    return { tokens, events }
  }

  /** 把本次判定消耗的 token 记到当日游标；预算闸门按它算账。 */
  private addTokens(tokens: number, now: string): void {
    if (tokens <= 0) return
    const key = `event:tokens:${dayKey(now)}`
    const current = Number(this.store.getCursor(key) ?? 0)
    const next = current + tokens
    this.store.setCursor(key, String(next), now)
    this.logger.info('event:tokens-used', { tokens, day: dayKey(now), total: next })
  }

  /** 派工：合成一条 Trigger 走既有开单路径。 */
  private async dispatch(
    event: EventRecord,
    tier: EventTier,
    priority: number,
    reason: string,
    triage: EventTriageResult & { degraded: boolean },
  ): Promise<string> {
    const plan = this.resolveDispatch?.(event) ?? { repo: '', branch: '', missing: ['repo'] }
    if (plan.missing.length > 0 || !plan.repo) {
      this.logger.info('event:pending-review', { eventId: event.id, reason: 'event:dispatch-incomplete' })
      return this.pending(event, 't1', priority, 'event:dispatch-incomplete', triage)
    }
    const acceptMode = this.engine.policy().acceptMode
    if (acceptMode === 'off') {
      return this.settle(event.id, { state: 'dropped', tier, priority, reason: 'event:accept-off' })
    }
    if (acceptMode === 'observe') {
      return this.settle(event.id, { state: 'archived', tier, priority, reason: 'event:observe-mode' })
    }

    const now = this.clock.now()
    // 派工必须幂等：同一事件重试时不能开出第二张工单。
    // 触发消息按 (source, external_id) 唯一，命中就说明这个事件之前派过。
    const existing = this.store.getTriggerByExternal(event.source, event.externalId)
    const linked = existing ? this.store.listSubscriptions(existing.threadId)[0] : undefined
    if (linked) {
      this.store.updateEventQueue(event.id, {
        state: 'dispatched',
        tier,
        priority,
        reason,
        decidedBy: triage.degraded ? 'rule' : 'jev',
        ticketId: linked.ticketId,
        updatedAt: now,
      })
      this.logger.info('event:dispatched', {
        eventId: event.id,
        ticketId: linked.ticketId,
        project: event.project ?? '',
        reused: true,
      })
      return 'dispatched'
    }
    const trigger: Trigger = {
      id: `trg_event_${event.id}`,
      source: event.source,
      externalId: event.externalId,
      threadId: `event:${event.id}`,
      chatId: plan.chatId ?? '',
      chatName: plan.chatId ?? event.source,
      actorId: event.actorId,
      actorName: event.actorName,
      isBot: event.actorType === 'bot',
      text: `${event.subject}：${event.summary}`,
      addressed: 'direct',
      receivedAt: event.receivedAt,
      disposition: 'pending',
    }
    this.engine.ingest(trigger)
    const outcome = this.engine.decide({
      // 触发消息已存在时复用它：insert 会被唯一约束忽略，但记录得用旧的那条。
      triggerId: existing?.id ?? trigger.id,
      decision: 'accept',
      strength: 'inferred',
      reason,
      title: event.summary.slice(0, 80),
      scope: scopeOf(event, triage.eventTypeLabel),
      repo: plan.repo,
      branch: plan.branch,
      owner: { actorId: event.actorId, actorName: event.actorName },
    })
    if (!outcome.ticket) {
      this.logger.warn('event:pending-review', { eventId: event.id, reason: 'event:ticket-not-created' })
      return this.pending(event, 't1', priority, 'event:ticket-not-created', triage)
    }
    this.store.updateEventQueue(event.id, {
      state: 'dispatched',
      tier,
      priority,
      reason,
      decidedBy: triage.degraded ? 'rule' : 'jev',
      ticketId: outcome.ticket.id,
      updatedAt: now,
    })
    this.logger.info('event:dispatched', {
      eventId: event.id,
      ticketId: outcome.ticket.id,
      project: event.project ?? '',
    })
    return 'dispatched'
  }

  /** 进待审核队列并通知管理员。 */
  private async pending(
    event: EventRecord,
    tier: EventTier,
    priority: number,
    reason: string,
    triage: EventTriageResult & { degraded: boolean },
  ): Promise<string> {
    const now = this.clock.now()
    this.store.updateEventQueue(event.id, {
      state: 'pending_review',
      tier,
      priority,
      reason,
      decidedBy: triage.degraded ? 'rule' : 'jev',
      updatedAt: now,
    })
    this.logger.info('event:pending-review', { eventId: event.id, reason })
    if (this.notifyReview) {
      try {
        await this.notifyReview(event, this.store.getEventQueue(event.id)!)
      } catch (error) {
        // 通知失败不影响主流程：事件仍留在面板待办里。
        this.logger.warn('event:review-notify-failed', { eventId: event.id, detail: errorMessage(error).slice(0, 200) })
      }
    }
    return 'pending_review'
  }

  /** 落定队列状态。 */
  private settle(
    eventId: string,
    patch: { state: string; tier: string; priority?: number; reason?: string; notBefore?: string; decidedBy?: string },
  ): string {
    const now = this.clock.now()
    this.store.updateEventQueue(eventId, {
      state: patch.state,
      tier: patch.tier,
      ...(patch.priority === undefined ? {} : { priority: patch.priority }),
      ...(patch.reason === undefined ? {} : { reason: patch.reason }),
      ...(patch.notBefore === undefined ? {} : { notBefore: patch.notBefore }),
      ...(patch.decidedBy === undefined ? {} : { decidedBy: patch.decidedBy }),
      updatedAt: now,
    })
    return patch.state
  }

  /** 人工审核：批准派单 / 驳回 / 延后。 */
  async review(eventId: string, action: ReviewAction, operator = 'unknown'): Promise<ReviewOutcome> {
    const event = this.store.getEvent(eventId)
    const queue = this.store.getEventQueue(eventId)
    if (!event || !queue) return { state: 'not-found' }
    // 审核人名单是最后一道闸：卡片按钮、API 带身份时走同一条判定。
    // 本机面板没有具名身份（operator = 'panel'），按「本机放行」处理。
    const approvers = this.settings().approvers
    if (approvers.length > 0 && operator !== LOCAL_OPERATOR && !approvers.includes(operator)) {
      this.logger.warn('event:review-forbidden', { eventId, operator })
      return { state: 'forbidden' }
    }
    if (action === 'reject') {
      this.settle(eventId, { state: 'dropped', tier: queue.tier || 't1', reason: 'event:review-rejected' })
      this.logger.info('event:review-rejected', { eventId, operator })
      return { state: 'dropped' }
    }
    if (action === 'defer') {
      const notBefore = new Date(Date.parse(this.clock.now()) + 3_600_000).toISOString()
      this.settle(eventId, { state: 'deferred', tier: queue.tier || 't1', reason: 'event:review-deferred', notBefore })
      this.logger.info('event:deferred', { eventId, notBefore, reason: 'event:review-deferred' })
      return { state: 'deferred', reason: 'event:review-deferred' }
    }
    const triage = await this.triageEvent(event)
    const state = await this.dispatch(event, 't0', queue.priority, 'event:review-approved', triage)
    if (state === 'dispatched') this.logger.info('event:review-approved', { eventId, operator, ticketId: queue.ticketId })
    return { state, ...(queue.ticketId ? { ticketId: queue.ticketId } : {}) }
  }
}

/** 授权范围：按判定出的事件类型落成一句人话。 */
function scopeOf(event: EventRecord, typeLabel: string): string {
  const subject = event.subject
  switch (typeLabel) {
    case 'alert': return `排查并处理 ${subject} 相关的告警：${event.summary}`
    case 'defect': return `定位并修复 ${subject} 描述的问题：${event.summary}`
    case 'request': return `实现 ${subject} 提出的需求：${event.summary}`
    default: return `处理 ${subject}：${event.summary}`
  }
}

/** 本地时刻的 'HH:MM'；时间窗判定按本地时间走。 */
function localTimeOfDay(now: string): string {
  const date = new Date(now)
  if (Number.isNaN(date.getTime())) return '00:00'
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 延后到下一个放行窗口的开始时刻。 */
function nextWindowStart(nextStart: string | undefined, now: string): string {
  if (!nextStart) return now
  const base = new Date(now)
  const [hour = '00', minute = '00'] = nextStart.split(':')
  base.setHours(Number(hour), Number(minute), 0, 0)
  if (base.getTime() <= Date.parse(now)) base.setDate(base.getDate() + 1)
  return base.toISOString()
}

/** 延后到第二天：预算是按天算的。 */
function nextDayStart(now: string): string {
  const base = new Date(now)
  base.setHours(0, 0, 0, 0)
  base.setDate(base.getDate() + 1)
  return base.toISOString()
}

/** 今天的起点（本地时间）。 */
function dayStart(now: string): string {
  const base = new Date(now)
  base.setHours(0, 0, 0, 0)
  return base.toISOString()
}

/** 今天的日期键（本地日历日）；跨零点按本地时间换日。 */
function dayKey(now: string): string {
  const base = new Date(now)
  const month = String(base.getMonth() + 1).padStart(2, '0')
  const day = String(base.getDate()).padStart(2, '0')
  return `${base.getFullYear()}-${month}-${day}`
}
