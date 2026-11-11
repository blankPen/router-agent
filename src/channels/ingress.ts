import type { Engine } from '../core/engine.js'
import type { Trigger } from '../core/model.js'
import type { Store } from '../store/db.js'
import { errorMessage, noopLogger, type Logger } from '../infra/logger.js'
import type { ChannelAdapter } from './port.js'

export interface ChannelIngressOptions {
  adapter: ChannelAdapter
  engine: Engine
  store: Store
  logger?: Logger
  /** 这条消息是否会被回复；决定是否加回执。 */
  shouldReply: (trigger: Trigger) => boolean
  /** 回执句柄落盘，回复成功后用于撤销。 */
  onAck?: (messageId: string, handle: string) => void
}

/**
 * 入站管线：归一化 -> 富化 -> 入库 -> 回执。
 *
 * 顺序与原先 CLI 内联逻辑保持一致：
 * - 图片消息需要下载识别，先加回执再富化；
 * - 其他消息先富化入库，再补回执；
 * - 重复投递只记日志，不重复回执。
 */
export class ChannelIngress {
  private readonly adapter: ChannelAdapter
  private readonly engine: Engine
  private readonly store: Store
  private readonly logger: Logger
  private readonly shouldReply: (trigger: Trigger) => boolean
  private readonly onAck?: (messageId: string, handle: string) => void

  constructor(opts: ChannelIngressOptions) {
    this.adapter = opts.adapter
    this.engine = opts.engine
    this.store = opts.store
    this.logger = opts.logger ?? noopLogger
    this.shouldReply = opts.shouldReply
    this.onAck = opts.onAck
  }

  handleRaw(raw: unknown): void {
    const result = this.adapter.normalize(raw)
    if (!result.trigger) {
      // 收到了但被过滤：把原因写进日志，否则用户只会看到「没反应」。
      this.logger.info('trigger:dropped', {
        channel: this.adapter.id,
        reason: result.dropped,
        chat: result.targetId,
        name: result.targetName,
        actor: result.actorId,
      })
      return
    }

    const base = result.trigger
    const willReply = this.shouldReply(base)
    const needsEnrichment = this.adapter.needsEnrichment?.(base) ?? false
    const canAck = this.adapter.capabilities.ack && Boolean(this.adapter.ack)

    if (canAck && willReply && needsEnrichment && !this.store.getReaction(base.externalId)) {
      this.react(base.externalId)
    }

    void (async () => {
      const trigger = this.adapter.enrich ? await this.adapter.enrich(base) : base
      const stored = this.engine.ingest(trigger)
      if (!stored) {
        // 重放 / 重复投递：消息已入库但被去重，日志里说清楚，避免误判成「消息丢了」。
        this.logger.info('trigger:duplicate', { channel: this.adapter.id, id: trigger.id, chat: trigger.chatId })
        return
      }
      const raw = trigger.raw as Record<string, unknown> | undefined
      const threadKeys = trigger.threadKeys ?? []
      this.logger.info('trigger:ingested', {
        channel: this.adapter.id,
        id: trigger.id,
        chat: trigger.chatId,
        addressed: trigger.addressed,
        quoted: Boolean(raw?.quote),
        images: Array.isArray(raw?.images) ? raw.images.length : 0,
        // 事件到底带了哪些线程标识：排查「消息没进工单」时先看 topic 是否为 true。
        threadKeys: threadKeys.length,
        topic: threadKeys.some(key => key.startsWith('omt_')),
      })
      // 纯附件在入库前已经加过，这里跳过避免重复。
      if (canAck && willReply && !needsEnrichment) this.react(trigger.externalId)
    })().catch(error => {
      this.logger.warn('trigger:ingest-failed', { channel: this.adapter.id, message: errorMessage(error) })
    })
  }

  private react(messageId: string): void {
    void this.adapter.ack!(messageId)
      .then(handle => {
        if (handle) this.onAck?.(messageId, handle)
      })
      .catch(error => {
        this.logger.warn('channel:ack-failed', {
          channel: this.adapter.id,
          messageId,
          message: errorMessage(error),
        })
      })
  }
}