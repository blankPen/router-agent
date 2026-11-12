import { noopLogger, type Logger } from '#infra/logger.js'
import type { ChannelRegistry } from './registry.js'

/** Outbox 交给通道层的最小字段集；与 store 的 OutboxItem 结构兼容。 */
export interface ChannelOutboxItem {
  channelKind: string
  channelId: string
  threadId: string
  text: string
  key: string
  originMessageId?: string
}

/**
 * 出站分发：按通道实例 ID 找到适配器，把中立消息交给它渲染与发送。
 *
 * 一期 `channelKind` 仍然是 `'feishu'`，与实例 ID 相同；接第二通道时
 * 由配置把实例 ID 与实现 ID 分开。未知通道按旧行为跳过并记日志，
 * 避免历史脏数据把 Outbox 卡死。
 */
export class ChannelRouter {
  constructor(
    private readonly registry: ChannelRegistry,
    private readonly logger: Logger = noopLogger,
  ) {}

  async send(item: ChannelOutboxItem): Promise<void> {
    const text = item.text.trim()
    if (!text) return
    const adapter = this.registry.get(item.channelKind)
    if (!adapter) {
      this.logger.warn('channel:not-registered', { channel: item.channelKind, target: item.channelId, key: item.key })
      return
    }
    await adapter.send({
      channelId: item.channelKind,
      targetId: item.channelId,
      ...(item.threadId ? { threadRef: item.threadId } : {}),
      text,
      format: 'markdown',
      idempotencyKey: item.key,
      ...(item.originMessageId ? { originMessageId: item.originMessageId } : {}),
    })
  }
}