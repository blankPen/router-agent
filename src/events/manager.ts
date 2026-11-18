/**
 * 事件总线管理器：装配来源、驱动轮询、跑决策管线、回写结论。
 *
 * 事件链路与飞书消息链路只在「派工 → Worker」处汇合：
 * 事件判定后合成工单，之后完全沿用现有派工与 Worker 流程。
 */
import type { AppConfig, EventSourceConfig } from '../config.js'
import type { Store } from '../store/db.js'
import type { EventPriority, EventRecord } from '#core/event.js'
import type { EventEnvelope, EventSource } from '#event/port.js'
import { loadEventPlugins } from '#event/plugins/loader.js'
import type { EventOptionField } from '#event/plugins/types.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import type { CommandRunner } from '#infra/process.js'
import type { EventAction, EventPipeline } from './pipeline.js'
import { FeishuEventSource } from './sources/feishu.js'
import { GithubEventSource } from './sources/github.js'
import { ruleEventTypes } from './rules.js'

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
  private sources = new Map<string, EventSource>()
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
  }

  /** 启动：装配来源并开始轮询与管线 tick。 */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    await this.reloadSources()
    const activated = this.store.activateUndecidedEvents(
      ruleEventTypes(this.config().events.rules, this.config().events.decision.fallbackToPrompt ? this.config().events.decision.prompt : undefined),
      this.clock(),
    )
    if (activated > 0) this.logger.info('event:rule-activated', { ruleId: 'startup', activated })
    this.tickTimer = setInterval(() => {
      void this.runTick()
    }, this.tickMs)
    this.logger.info('event:manager-started', { sources: this.sources.size })
  }

  /** 停止：停掉所有轮询与来源。 */
  stop(): void {
    this.running = false
    for (const timer of this.timers.values()) clearInterval(timer)
    this.timers.clear()
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = null
    for (const source of this.sources.values()) {
      try {
        source.stop?.()
      } catch (error) {
        this.logger.warn('event:source-stop-failed', { sourceId: source.id, message: errorMessage(error) })
      }
    }
    this.sources.clear()
    this.logger.info('event:manager-stopped', {})
  }

  /** 重新装配来源（配置变更后调用）。 */
  async reloadSources(): Promise<void> {
    for (const timer of this.timers.values()) clearInterval(timer)
    this.timers.clear()
    for (const source of this.sources.values()) {
      try {
        source.stop?.()
      } catch (error) {
        this.logger.warn('event:source-stop-failed', { sourceId: source.id, message: errorMessage(error) })
      }
    }
    this.sources.clear()

    const config = this.config()
    if (!config.events.enabled) {
      this.logger.info('event:manager-disabled', {})
      return
    }

    for (const [id, source] of Object.entries(config.events.sources)) {
      if (!source.enabled) continue
      const built = this.buildSource(id, source)
      if (!built) continue
      this.sources.set(id, built)
    }

    // 自定义来源插件：只有配置里写了 plugin 的来源 id 才会加载。
    const plugins = await loadEventPlugins(
      { home: config.home, events: { sources: pluginEntriesOf(config) } },
      { home: config.home, logger: this.logger, runner: bin => ({ run: async () => ({ code: 127, stdout: '', stderr: `事件插件不支持命令 ${bin}` }) }) },
    )
    for (const failure of plugins.failures) {
      this.logger.error('event:plugin-failed', { sourceId: failure.id, message: failure.message })
    }
    for (const source of plugins.sources) {
      this.sources.set(source.id, source)
    }
    this.pluginOptions = plugins.optionsById

    for (const [id, source] of this.sources) {
      const interval = this.intervalOf(id)
      if (typeof source.poll !== 'function') {
        this.status.set(id, { status: 'ok', message: '推送型来源，由来源自己拉取' })
        continue
      }
      const timer = setInterval(() => {
        void this.pollSource(id, source)
      }, interval)
      this.timers.set(id, timer)
      void this.pollSource(id, source)
    }
    this.logger.info('event:sources-loaded', { count: this.sources.size })
  }

  /** 面板用：来源列表。 */
  listSources(): EventSourceView[] {
    const config = this.config()
    const out: EventSourceView[] = []
    for (const [id, source] of Object.entries(config.events.sources)) {
      const status = this.status.get(id)
      const fields = source.plugin
        ? pluginFieldsOf(this.pluginOptions[id])
        : (BUILTIN_FIELDS[source.kind ?? ''] ?? [])
      out.push({
        id,
        kind: source.kind ?? (source.plugin ? 'plugin' : 'event'),
        enabled: source.enabled,
        fields,
        status: status?.status ?? (source.enabled ? 'idle' : 'unsupported'),
        ...(status?.message ? { message: status.message } : {}),
        ...(status?.lastPolledAt ? { lastPolledAt: status.lastPolledAt } : {}),
        builtin: !source.plugin,
        // 占位来源（飞书）：开关能开但不产出事件，标注出来免得以为配了就能用。
        ...(source.kind === 'feishu' ? { placeholder: true } : {}),
        ...(source.plugin ? { package: source.plugin } : {}),
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

  /** 面板用：按规则聚合事件命中分布。 */
  countEventRules(): Record<string, Record<string, number>> {
    return this.store.countEventsByRule()
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
    const source = this.sources.get(event.sourceId)
    if (!source?.publish) {
      this.logger.info('event:writeback-skipped', { eventId: event.id, sourceId: event.sourceId })
      return
    }
    try {
      await source.publish({ externalId: event.externalId, ...(event.url ? { url: event.url } : {}) }, text)
    } catch (error) {
      this.logger.warn('event:writeback-failed', { eventId: event.id, sourceId: event.sourceId, message: errorMessage(error) })
    }
  }

  /** 轮询一个来源并把事件入队。 */
  private async pollSource(id: string, source: EventSource): Promise<void> {
    if (!source.poll) return
    const config = this.config().events.sources[id]
    if (!config) return
    try {
      const envelopes = await source.poll()
      let count = 0
      for (const envelope of envelopes) {
        this.pipeline.ingest(id, config, envelope)
        count += 1
      }
      this.status.set(id, { status: 'ok', lastPolledAt: this.clock(), ...(count ? { message: `收到 ${count} 条事件` } : {}) })
    } catch (error) {
      this.status.set(id, { status: 'error', message: errorMessage(error).slice(0, 200), lastPolledAt: this.clock() })
      this.logger.warn('event:source-poll-failed', { sourceId: id, message: errorMessage(error) })
    }
  }

  /** 装配内置来源。 */
  private buildSource(id: string, config: EventSourceConfig): EventSource | null {
    switch (config.kind) {
      case 'github':
        return new GithubEventSource(id, config, {
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
        return new FeishuEventSource(id, config, { logger: this.logger })
      default:
        this.logger.warn('event:source-unsupported', { sourceId: id, kind: config.kind ?? '' })
        return null
    }
  }

  /** 轮询间隔：来源自己配的优先。 */
  private intervalOf(id: string): number {
    const configured = this.config().events.sources[id]?.intervalMs
    if (typeof configured === 'number' && configured > 0) return configured
    return 300_000
  }
}

/** 配置里声明了插件入口的来源条目。 */
function pluginEntriesOf(config: AppConfig): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, source] of Object.entries(config.events.sources)) {
    if (source.plugin) out[id] = source.plugin
  }
  return out
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
