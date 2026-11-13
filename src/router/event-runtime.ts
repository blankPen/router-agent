import type { EventRecord, EventQueueRecord, Store } from '../store/db.js'
import type { Engine } from '../core/engine.js'
import type { AppConfig, EventSettings } from '../config.js'
import type { CommandRunner } from '#infra/process.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import type { EventEnvelope, EventSource } from '#core/event.js'
import { EventBus, type DispatchPlan } from './event-bus.js'
import { DEFAULT_CHANNEL_ID } from '#channel/port.js'
import { buildEventSources } from './event-sources.js'
import type { EventTriagePort } from './event-triage.js'

/** 事件总线的运行参数。 */
export interface EventRuntimeOptions {
  config: () => EventSettings
  store: Store
  engine: Engine
  /** gh 命令执行器；GitHub Issue 轮询来源用它。 */
  runner: CommandRunner
  /** 判定层；缺省时事件只走规则层（判定一律要人确认）。 */
  triage?: EventTriagePort
  logger?: Logger
  clock?: { now(): string }
  env?: NodeJS.ProcessEnv
  /** 把事件派到哪个仓库与分支；缺省时没有项目的事件一律待审。 */
  resolveDispatch?: (event: EventRecord) => DispatchPlan
  /** 待审核事件的通知出口。 */
  notifyReview?: (event: EventRecord, queue: EventQueueRecord) => void | Promise<void>
}

/**
 * 事件总线的运行时。
 *
 * 独立于 RouterService：Web-only 模式（还没配 LLM）下事件总线也要能收事件、跑判定，
 * 只是判定会降级到规则层并全部转人工。
 */
export class EventRuntime {
  readonly bus: EventBus
  private options: EventRuntimeOptions
  private logger: Logger
  private clock: { now(): string }
  private sources: Array<{ source: EventSource; intervalMs: number }> = []
  private timers: NodeJS.Timeout[] = []
  private polling = false

  constructor(options: EventRuntimeOptions) {
    this.options = options
    this.logger = options.logger ?? noopLogger
    this.clock = options.clock ?? { now: () => new Date().toISOString() }
    this.bus = new EventBus({
      store: options.store,
      engine: options.engine,
      settings: options.config,
      logger: this.logger,
      clock: this.clock,
      ...(options.triage ? { triage: options.triage } : {}),
      ...(options.resolveDispatch ? { resolveDispatch: options.resolveDispatch } : {}),
      ...(options.notifyReview ? { notifyReview: options.notifyReview } : {}),
    })
    this.sources = buildEventSources({
      config: options.config,
      store: options.store,
      runner: options.runner,
      env: options.env ?? process.env,
      logger: this.logger,
      clock: this.clock,
    }).map(source => ({
      source,
      intervalMs: options.config().sources.find(item => item.id === source.id)?.intervalMs ?? 15 * 60_000,
    }))
  }

  /** 启动队列处理与来源轮询。 */
  start(): void {
    this.logger.info('event:enabled', {
      sources: this.sources.map(item => item.source.id).join(',') || '(none)',
      queueDepth: this.options.store.eventQueueStats().total,
    })
    this.timers.push(setInterval(() => { void this.tick() }, 5_000))
    for (const item of this.sources) {
      this.timers.push(setInterval(() => { void this.poll(item.source) }, Math.max(item.intervalMs, 30_000)))
    }
    for (const timer of this.timers) timer.unref?.()
  }

  /** 停止所有定时器。 */
  stop(): void {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
  }

  /** 处理一轮队列。 */
  private async tick(): Promise<void> {
    try {
      const outcome = await this.bus.tick()
      if (outcome.processed > 0) {
        this.logger.info('event:tick', {
          processed: outcome.processed,
          dispatched: outcome.dispatched,
          pending: outcome.pending,
          deferred: outcome.deferred,
          dropped: outcome.dropped,
          archived: outcome.archived,
        })
      }
    } catch (error) {
      this.logger.error('event:tick-failed', { message: errorMessage(error) })
    }
  }

  /** 拉一次来源，把新事件推进队列。 */
  private async poll(source: EventSource): Promise<void> {
    if (!source.poll) return
    if (this.polling) return
    this.polling = true
    try {
      const events: EventEnvelope[] = await source.poll({ now: this.clock.now() })
      for (const event of events) {
        const result = await this.bus.ingest(event)
        if (!result.accepted && !result.duplicate) {
          this.logger.warn('event:ingest-rejected', { source: source.id, reason: result.reason ?? 'unknown' })
        }
      }
    } catch (error) {
      this.logger.warn('event:source-failed', { source: source.id, message: errorMessage(error) })
    } finally {
      this.polling = false
    }
  }
}

/**
 * 事件派工目标：按事件绑定的项目名解析仓库与起始分支。
 *
 * 解析不出来就返回缺口，让事件进待审核而不是硬派到一个错的仓库。
 */
export function dispatchPlanOf(config: AppConfig, event: EventRecord): DispatchPlan {
  const source = config.event?.sources.find(item => item.id === event.source)
  const notifyChat = source?.notifyChat || config.event?.notifyChat || ''
  const project = config.projects.find(item => item.name === event.project)
  if (!project) return { repo: '', branch: '', missing: ['repo'], project: event.project, chatId: notifyChat }
  const branch = project.defaultBranch
  return {
    repo: project.repo,
    branch,
    project: project.name,
    missing: branch ? [] : ['branch'],
    chatId: notifyChat,
  }
}

/** 待审核事件推给管理员；没配通知群时只在面板里可见。 */
export function notifyEventReview(
  store: Store,
  config: AppConfig,
  clock: { now(): string },
  logger: Logger,
  event: EventRecord,
  queue: EventQueueRecord,
): void {
  const chatId = config.event?.notifyChat || ''
  if (!chatId) return
  const text = [
    '**新事件待审核**',
    `来源：${event.source}`,
    `对象：${event.subject}`,
    `摘要：${event.summary}`,
    `判定依据：${queue.reason ?? ''}（优先级 ${queue.priority}）`,
    '面板「事件」页可以批准派单、驳回或延后。',
  ].join('\n')
  store.enqueueOutbox({
    id: `ob_event_review_${event.id}`,
    key: `event:review:${event.id}`,
    channelKind: DEFAULT_CHANNEL_ID,
    channelId: chatId,
    threadId: '',
    text,
    now: clock.now(),
  })
  logger.info('event:review-notified', { eventId: event.id, channelId: chatId })
}
