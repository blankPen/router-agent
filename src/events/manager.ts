/**
 * 事件总线管理器：按订阅装配 watcher、驱动轮询、跑决策管线、回写结论。
 *
 * 订阅来自自动化任务（`automation.tasks[].trigger.kind = 'event'`）：
 * 没有订阅就没有事件 —— 来源不再持有「订阅了哪些事件」。
 *
 * 事件链路与飞书消息链路只在「派工 → Worker」处汇合：
 * 事件判定后合成工单，之后完全沿用现有派工与 Worker 流程。
 */
import type { AppConfig, EventSourceConfig } from '../config.js'
import type { Store } from '../store/db.js'
import type { EventPriority, EventRecord } from '#core/event.js'
import type { EventEnvelope } from '#event/port.js'
import type { EventOptionField } from '#event/plugins/types.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import type { CommandRunner } from '#infra/process.js'
import type { EventAction, EventPipeline } from './pipeline.js'
import { GithubEventSource } from './sources/github.js'
import { FeishuEventWatcher } from './feishu-watcher.js'
import { groupBySource, subscriptionsOf, type ResolvedSubscription } from './subscriptions.js'
import type { EventSink, EventWatcher } from './watcher.js'

/** 面板展示用的来源视图。 */
export interface EventSourceView {
  id: string
  kind: string
  enabled: boolean
  /** 来源自己声明的字段（插件）或内置字段说明。 */
  fields: Array<{ key: string; label: string; kind: string; hint?: string; options?: string[] }>
  /** 最近一次拉取结果摘要。 */
  status: 'idle' | 'ok' | 'error' | 'unsupported'
  message?: string
  lastPolledAt?: string
  /** 内置来源还是自定义插件。 */
  builtin: boolean
  /** 占位来源：开关能开但还不产出事件（飞书群消息仍走 channel 链路）。 */
  placeholder?: boolean
  /** 自定义来源插件的 npm 包名或本地路径。 */
  package?: string
  /** 这个来源当前有多少条订阅。 */
  subscriptions?: number
}

/** 事件来源的字段说明；内置来源写在这里，插件来源用插件自己声明的。 */
const BUILTIN_FIELDS: Record<string, EventSourceView['fields']> = {
  // GitHub 来源的字段由面板的仓库订阅区单独渲染，不走通用设置弹窗。
  github: [],
  feishu: [],
}

export interface EventManagerDeps {
  store: Store
  pipeline: EventPipeline
  /** 当前配置（面板改完立即生效）。 */
  config: () => AppConfig
  clock: () => string
  /** 执行外部命令的运行器（GitHub 来源用 gh）。 */
  runner: CommandRunner
  logger?: Logger
  /** 决策管线每轮间隔；测试注入。 */
  tickMs?: number
  /** 订阅清单；宿主注入（默认从配置里的自动化任务推导）。 */
  subscriptions?: () => ResolvedSubscription[]
}

interface SourceRuntime {
  /** 来源配置 id；决定事件的 sourceId。 */
  sourceId: string
  /** 来源种类。 */
  kind: string
  /** 覆盖的 watcher。 */
  watcher: EventWatcher
}

/** 事件总线管理器。 */
export class EventManager {
  private store: Store
  private pipeline: EventPipeline
  private config: () => AppConfig
  private clock: () => string
  private runner: CommandRunner
  private logger: Logger
  private tickMs: number
  private subscriptionsFn: () => ResolvedSubscription[]
  /** 来源 id → 运行态。 */
  private runtimes = new Map<string, SourceRuntime>()
  /** 轮询定时器：key 是 `来源 id:订阅 id`。 */
  private timers = new Map<string, ReturnType<typeof setInterval>>()
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private status = new Map<string, { status: EventSourceView['status']; message?: string; lastPolledAt?: string }>()
  /** 插件来源 id → 插件声明的可配置项。 */
  private pluginOptions: Record<string, EventOptionField[]> = {}
  private running = false

  constructor(deps: EventManagerDeps) {
    this.store = deps.store
    this.pipeline = deps.pipeline
    this.config = deps.config
    this.clock = deps.clock
    this.runner = deps.runner
    this.logger = deps.logger ?? noopLogger
    this.tickMs = deps.tickMs ?? 30_000
    this.subscriptionsFn = deps.subscriptions ?? (() => subscriptionsOf(this.config()))
  }

  /** 启动：按订阅装配来源并开始轮询与管线 tick。 */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    await this.reloadSubscriptions()
    this.tickTimer = setInterval(() => {
      void this.runTick()
    }, this.tickMs)
    this.logger.info('event:manager-started', { sources: this.runtimes.size })
  }

  /** 停止：停掉所有轮询与来源。 */
  stop(): void {
    this.running = false
    for (const timer of this.timers.values()) clearInterval(timer)
    this.timers.clear()
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = null
    for (const runtime of this.runtimes.values()) {
      try {
        runtime.watcher.stop?.()
      } catch (error) {
        this.logger.warn('event:source-stop-failed', { sourceId: runtime.sourceId, message: errorMessage(error) })
      }
    }
    this.runtimes.clear()
    this.logger.info('event:manager-stopped', {})
  }

  /**
   * 重新装配订阅（配置变更后调用）。
   *
   * 装配粒度是**来源**：同一个来源的多个订阅共用一个 watcher；
   * poll 形态按订阅各拉各的（游标独立），realtime 形态按 EventKey 共享长连接。
   */
  async reloadSubscriptions(): Promise<void> {
    for (const timer of this.timers.values()) clearInterval(timer)
    this.timers.clear()
    for (const runtime of this.runtimes.values()) {
      try {
        runtime.watcher.stop?.()
      } catch (error) {
        this.logger.warn('event:source-stop-failed', { sourceId: runtime.sourceId, message: errorMessage(error) })
      }
    }
    this.runtimes.clear()

    const config = this.config()
    if (!config.events.enabled) {
      this.logger.info('event:manager-disabled', {})
      return
    }

    const grouped = groupBySource(this.subscriptionsFn().filter(subscription => subscription.enabled))
    for (const [source, subscriptions] of grouped) {
      const runtime = this.buildRuntime(source, subscriptions)
      if (!runtime) continue
      this.runtimes.set(runtime.sourceId, runtime)
      await this.startSubscriptions(runtime, subscriptions)
    }
    this.logger.info('event:sources-loaded', { count: this.runtimes.size })
  }

  /** 面板用：来源列表。 */
  listSources(): EventSourceView[] {
    const config = this.config()
    const out: EventSourceView[] = []
    const grouped = groupBySource(this.subscriptionsFn())
    for (const [id, source] of Object.entries(config.events.sources)) {
      const status = this.status.get(id)
      const fields = source.plugin
        ? pluginFieldsOf(this.pluginOptions[id])
        : (BUILTIN_FIELDS[source.kind ?? ''] ?? [])
      const subscriptions = grouped.get(source.kind ?? id)?.length ?? 0
      out.push({
        id,
        kind: source.kind ?? (source.plugin ? 'plugin' : 'event'),
        enabled: source.enabled,
        fields,
        status: status?.status ?? (source.enabled ? 'idle' : 'unsupported'),
        ...(status?.message ? { message: status.message } : {}),
        ...(status?.lastPolledAt ? { lastPolledAt: status.lastPolledAt } : {}),
        builtin: !source.plugin,
        ...(source.plugin ? { package: source.plugin } : {}),
        subscriptions,
      })
    }
    return out
  }

  /** 面板用：事件列表。 */
  listEvents(filter: { status?: string; priority?: string; sourceId?: string; limit?: number } = {}): EventRecord[] {
    return this.store.listEvents({
      ...(filter.status ? { status: filter.status as EventRecord['status'] } : {}),
      ...(filter.priority ? { priority: filter.priority as EventPriority } : {}),
      ...(filter.sourceId ? { sourceId: filter.sourceId } : {}),
      ...(filter.limit ? { limit: filter.limit } : {}),
    })
  }

  /** 面板用：按状态统计事件条数（不受列表 limit 影响）。 */
  countEvents(): Record<string, number> {
    return this.store.countEventsByStatus()
  }

  /** 面板用：按订阅（= 任务）聚合事件命中分布。 */
  countEventRules(): Record<string, Record<string, number>> {
    return this.store.countEventsBySubscription()
  }

  /** 面板用：事件操作。 */
  async apply(eventId: string, action: EventAction, options: { priority?: EventPriority; project?: string } = {}) {
    return this.pipeline.apply(eventId, action, options)
  }

  /** 跑一轮管线：判定新事件 + 回收已完成的工单结果。 */
  async runTick(): Promise<void> {
    // 总开关关着就不再判定与派发：已入队的事件留在队列里，开回来继续处理。
    if (!this.config().events.enabled) return
    try {
      await this.pipeline.tick()
      await this.settleDispatched()
    } catch (error) {
      this.logger.error('event:tick-failed', { message: errorMessage(error) })
    }
  }

  /** 工单做完后把结论回写到来源，并把事件标成已完成。 */
  private async settleDispatched(): Promise<void> {
    for (const event of this.store.listEvents({ status: 'pending', limit: 200 })) {
      if (!event.ticketId) continue
      const ticket = this.store.getTicket(event.ticketId)
      if (!ticket) continue
      if (ticket.stage !== 'done') continue
      const reports = this.store.listReports(ticket.id, 1)
      const summary = reports[0]?.reply?.trim() || reports[0]?.summary?.trim() || `工单 ${ticket.id} 已完成`
      await this.writeback(event, summary)
      this.store.updateEvent({
        ...event,
        status: 'done',
        execution: 'none',
        reason: '工单已完成，结论已回写来源',
        updatedAt: this.clock(),
      })
      this.logger.info('event:completed', { eventId: event.id, ticketId: ticket.id })
    }
  }

  /** 回写结论；没有回写能力的事件只落库，不假装做完了。 */
  private async writeback(event: EventRecord, text: string): Promise<void> {
    const subscription = this.subscriptionOf(event)
    const runtime = subscription ? this.runtimes.get(this.sourceIdOf(subscription)) : undefined
    if (!subscription || !runtime?.watcher.publish) {
      this.logger.info('event:writeback-skipped', { eventId: event.id, sourceId: event.sourceId })
      return
    }
    try {
      await runtime.watcher.publish(subscription, { externalId: event.externalId, ...(event.url ? { url: event.url } : {}) }, text)
    } catch (error) {
      this.logger.warn('event:writeback-failed', { eventId: event.id, sourceId: event.sourceId, message: errorMessage(error) })
    }
  }

  /** 轮询一条订阅并把事件入队。 */
  private async pollSubscription(runtime: SourceRuntime, subscription: ResolvedSubscription): Promise<void> {
    const poll = runtime.watcher.poll
    if (!poll) return
    try {
      const envelopes = await poll.call(runtime.watcher, subscription)
      let count = 0
      for (const envelope of envelopes) {
        this.ingest(runtime, subscription, envelope)
        count += 1
      }
      this.status.set(runtime.sourceId, {
        status: 'ok',
        lastPolledAt: this.clock(),
        ...(count ? { message: `收到 ${count} 条事件` } : {}),
      })
    } catch (error) {
      this.status.set(runtime.sourceId, {
        status: 'error',
        message: errorMessage(error).slice(0, 200),
        lastPolledAt: this.clock(),
      })
      this.logger.warn('event:source-poll-failed', {
        sourceId: runtime.sourceId,
        subscriptionId: subscription.id,
        message: errorMessage(error),
      })
    }
  }

  /** 事件入队：带上订阅 id，事件按任务归属。 */
  private ingest(runtime: SourceRuntime, subscription: ResolvedSubscription, envelope: EventEnvelope): void {
    this.pipeline.ingest(runtime.sourceId, runtime.kind, subscription, envelope)
  }

  /** 按来源装配 watcher。 */
  private buildRuntime(source: string, subscriptions: ResolvedSubscription[]): SourceRuntime | null {
    const kind = subscriptions[0]?.source ?? source
    const sourceId = this.sourceIdOf(subscriptions[0]!)
    const watcher = this.buildWatcher(kind)
    if (!watcher) {
      this.logger.warn('event:source-unsupported', { sourceId, kind })
      return null
    }
    return { sourceId, kind, watcher }
  }

  /** 内置 watcher。 */
  private buildWatcher(kind: string): EventWatcher | null {
    switch (kind) {
      case 'github':
        return new GithubEventSource({
          runner: this.runner,
          logger: this.logger,
          clock: this.clock,
          // 游标存在库里：重启后接着上次的增量拉，不重复入队。
          cursor: {
            get: key => this.store.getCursor(key),
            set: (key, value) => this.store.setCursor(key, value, this.clock()),
          },
        })
      case 'feishu':
        return new FeishuEventWatcher({ logger: this.logger, clock: this.clock })
      default:
        return null
    }
  }

  /** 启停这一批订阅。 */
  private async startSubscriptions(runtime: SourceRuntime, subscriptions: ResolvedSubscription[]): Promise<void> {
    if (runtime.watcher.mode === 'realtime') {
      const sink: EventSink = (subscription, envelope) => {
        this.ingest(runtime, subscription, envelope)
      }
      for (const subscription of subscriptions) {
        try {
          await runtime.watcher.subscribe?.(subscription, sink)
          this.logger.info('event:subscription-registered', {
            taskId: subscription.id,
            source: subscription.source,
            types: subscription.types,
          })
        } catch (error) {
          this.logger.warn('event:subscription-register-failed', {
            taskId: subscription.id,
            source: subscription.source,
            message: errorMessage(error),
          })
        }
      }
      return
    }
    // poll 形态：每个订阅一个定时器，游标互相独立。
    for (const subscription of subscriptions) {
      const key = `${runtime.sourceId}:${subscription.id}`
      const timer = setInterval(() => {
        void this.pollSubscription(runtime, subscription)
      }, this.intervalOf(runtime.sourceId))
      this.timers.set(key, timer)
      void this.pollSubscription(runtime, subscription)
      this.logger.info('event:subscription-registered', {
        taskId: subscription.id,
        source: subscription.source,
        types: subscription.types,
      })
    }
  }

  /** 事件的 sourceId：优先用配置里的来源条目 id，没有就用目录 id。 */
  private sourceIdOf(subscription: ResolvedSubscription): string {
    const sources = this.config().events.sources
    const match = Object.entries(sources).find(([, source]) => source.enabled && source.kind === subscription.source)
    return match?.[0] ?? subscription.source
  }

  /** 按事件上的订阅 id 取订阅。 */
  private subscriptionOf(event: EventRecord): ResolvedSubscription | undefined {
    if (!event.subscriptionId) return undefined
    return this.subscriptionsFn().find(item => item.id === event.subscriptionId)
  }

  /** 轮询间隔：来源自己配的优先。 */
  private intervalOf(sourceId: string): number {
    const configured = this.config().events.sources[sourceId]?.intervalMs
    if (typeof configured === 'number' && configured > 0) return configured
    return 300_000
  }
}

/**
 * 插件来源的字段：按插件自己声明的可配置项渲染。
 *
 * 插件没声明选项时不编造字段——面板弹窗会直接说「这个来源没有可配置项」。
 */
function pluginFieldsOf(fields: EventOptionField[] | undefined): EventSourceView['fields'] {
  return (fields ?? []).map(field => ({
    key: `options.${field.key}`,
    label: field.label,
    kind: field.kind,
    ...(field.hint ? { hint: field.hint } : {}),
    ...(field.options ? { options: field.options } : {}),
  }))
}
