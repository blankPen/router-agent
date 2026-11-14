/**
 * HTTP 事件来源：外部系统通过接口把事件注入进来。
 *
 * 来源本身不主动拉取；事件由面板 / API 调用 inject 推进来。
 * 结论回写走回调地址（配置里写死），外部系统自己决定怎么用。
 */
import type { EventSourceConfig } from '../../config.js'
import type { EventEnvelope, EventSource } from '#event/port.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'

export interface HttpEventSourceDeps {
  logger?: Logger
  /** 回调请求用的 fetch；测试注入。 */
  fetchImpl?: typeof fetch
  /** 当前时间；测试注入。 */
  now?: () => Date
}

/** HTTP 事件来源。 */
export class HttpEventSource implements EventSource {
  readonly id: string
  readonly kind = 'http'
  private config: EventSourceConfig
  private logger: Logger
  private fetchImpl: typeof fetch
  private now: () => Date
  /** 当前分钟窗口的计数；换分钟就重来。 */
  private window = { minute: 0, count: 0 }

  constructor(id: string, config: EventSourceConfig, deps: HttpEventSourceDeps = {}) {
    this.id = id
    this.config = config
    this.logger = deps.logger ?? noopLogger
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch
    this.now = deps.now ?? (() => new Date())
  }

  /** 每分钟条数上限；没配或配 0 表示不限。 */
  private rateLimitOf(): number {
    const limit = this.config.rateLimitPerMin ?? 0
    return Number.isFinite(limit) && limit > 0 ? limit : 0
  }

  /** 超量就拒掉：外部系统推太快时不该把队列冲垮。 */
  private checkRateLimit(): void {
    const limit = this.rateLimitOf()
    if (limit <= 0) return
    const minute = Math.floor(this.now().getTime() / 60_000)
    if (minute !== this.window.minute) {
      this.window = { minute, count: 0 }
    }
    if (this.window.count >= limit) {
      this.logger.warn('event:rate-limited', { sourceId: this.id, limit })
      throw new Error('event:rate-limited')
    }
    this.window.count += 1
  }

  /** 外部注入事件。 */
  inject(event: EventEnvelope): EventEnvelope {
    this.checkRateLimit()
    const externalId = (event.externalId ?? '').trim()
    if (!externalId) throw new Error('http:external-id-required')
    const title = (event.title ?? '').trim()
    const body = (event.body ?? '').trim()
    if (!title && !body) throw new Error('http:empty-event')
    return {
      externalId,
      title: title || externalId,
      body,
      ...(event.url ? { url: event.url } : {}),
      ...(event.raw === undefined ? {} : { raw: event.raw }),
      ...(event.receivedAt ? { receivedAt: event.receivedAt } : {}),
      ...(event.context ? { context: event.context } : {}),
    }
  }

  /** 结论回写：POST 到配置的回调地址。 */
  async publish(target: { externalId: string; url?: string }, text: string): Promise<void> {
    const callback = (this.config.options?.callbackUrl as string | undefined) ?? ''
    if (!callback) {
      this.logger.warn('event:writeback-unsupported', { sourceId: this.id, externalId: target.externalId })
      return
    }
    try {
      const res = await this.fetchImpl(callback, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: this.id, externalId: target.externalId, text }),
      })
      if (!res.ok) {
        this.logger.warn('event:writeback-failed', { sourceId: this.id, status: res.status })
      }
    } catch (error) {
      this.logger.warn('event:writeback-failed', { sourceId: this.id, message: errorMessage(error) })
    }
  }
}
