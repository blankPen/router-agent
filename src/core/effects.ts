import type { EffectItem, OutboxItem, Store } from '../store/db.js'
import type { Clock } from './engine.js'
import { noopSink, preview, type EventSink } from './events.js'

export interface OutboxSender {
  send(item: OutboxItem): Promise<void>
}

export type EffectHandler = (payload: Record<string, unknown>, item: EffectItem) => Promise<void>

export interface EffectsProcessorOptions {
  store: Store
  sender: OutboxSender
  handlers?: Record<string, EffectHandler>
  clock?: Clock
  limit?: number
  onEvent?: EventSink
}

export interface TickResult {
  sent: number
  failed: number
  effects: number
  effectsFailed: number
}

/**
 * Outbox 顺序发送 + Effects 队列。
 * 单条失败只影响自己：错误记入 last_error，按指数退避重试。
 */
export class EffectsProcessor {
  private store: Store
  private sender: OutboxSender
  private handlers: Record<string, EffectHandler>
  private clock: Clock
  private limit: number
  private onEvent: EventSink

  constructor(opts: EffectsProcessorOptions) {
    this.store = opts.store
    this.sender = opts.sender
    this.handlers = { ...(opts.handlers ?? {}) }
    this.clock = opts.clock ?? { now: () => new Date().toISOString() }
    this.limit = opts.limit ?? 20
    this.onEvent = opts.onEvent ?? noopSink
  }

  /** 注册或替换一个 effect 处理器。 */
  register(kind: string, handler: EffectHandler): void {
    this.handlers[kind] = handler
  }

  async tick(): Promise<TickResult> {
    const result: TickResult = { sent: 0, failed: 0, effects: 0, effectsFailed: 0 }
    const now = this.clock.now()

    for (const item of this.store.claimOutbox(now, this.limit)) {
      try {
        await this.sender.send(item)
        this.store.succeedOutbox(item.id, this.clock.now())
        this.onEvent({ event: 'outbox:sent', key: item.key, channel: `${item.channelKind}:${item.channelId}`, text: preview(item.text) })
        result.sent += 1
      } catch (error) {
        this.store.failOutbox(item.id, errorText(error), this.clock.now())
        this.onEvent({ event: 'outbox:failed', key: item.key, attempt: item.attempts, error: errorText(error).slice(0, 200) })
        result.failed += 1
      }
    }

    for (const item of this.store.claimEffects(now, this.limit)) {
      const handler = this.handlers[item.kind]
      if (!handler) {
        this.store.failEffect(item.id, `effect:no-handler:${item.kind}`, this.clock.now())
        result.effectsFailed += 1
        continue
      }
      try {
        await handler(item.payload, item)
        this.store.succeedEffect(item.id, this.clock.now())
        this.onEvent({ event: 'effect:done', kind: item.kind, key: item.key })
        result.effects += 1
      } catch (error) {
        this.store.failEffect(item.id, errorText(error), this.clock.now())
        result.effectsFailed += 1
      }
    }

    return result
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
