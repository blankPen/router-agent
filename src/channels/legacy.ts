import { shouldSendAsText } from '../sources/feishu.js'

/**
 * 旧版出站兼容层。
 *
 * 生产路径已经改为 `ChannelRouter`（按通道注册表分发）；这里保留
 * `createEffectsSender` 供既有嵌入用法与测试使用，避免一次性破坏外部调用。
 * 新代码不要再用它。
 */
export interface FeishuOutbound {
  reply(messageId: string, text: string, idempotencyKey: string): Promise<void>
  send(chatId: string, text: string, idempotencyKey: string): Promise<void>
  sendCard(chatId: string, markdown: string, idempotencyKey: string): Promise<void>
  replyCard(messageId: string, markdown: string, idempotencyKey: string): Promise<void>
}

export interface LegacyOutboxItem {
  channelKind: string
  channelId: string
  threadId: string
  text: string
  key: string
}

export function createEffectsSender(sender: FeishuOutbound): { send(item: LegacyOutboxItem): Promise<void> } {
  return {
    async send(item) {
      if (item.channelKind !== 'feishu') return
      const text = item.text.trim()
      if (!text) return
      // 简单消息走纯文本：不开卡片，少一次渲染、少一类兼容问题。
      if (shouldSendAsText(text)) {
        if (item.threadId) await sender.reply(item.threadId, text, item.key)
        else await sender.send(item.channelId, text, item.key)
        return
      }
      // 其余走互动卡片：Markdown 先在 feishuCard 内归一化，卡片失败时 Sender 内部降级为 post。
      if (item.threadId) await sender.replyCard(item.threadId, text, item.key)
      else await sender.sendCard(item.channelId, text, item.key)
    },
  }
}