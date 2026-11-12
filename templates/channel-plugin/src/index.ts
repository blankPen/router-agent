import type { ChannelPlugin } from '@router-agent/channel'

/**
 * 最小通道插件：normalize() 把平台事件变成 Trigger，send() 把回复发出去。
 *
 * 配置里用 `channels.<id>` 声明入口；重启后在服务里按实例 id 路由 outbox。
 */
const plugin: ChannelPlugin = {
  kind: 'channel',
  meta: {
    id: 'example',
    name: 'Example Channel',
    hint: '说明这个通道如何接收消息、如何发送回复',
  },
  create(ctx) {
    return {
      id: 'example',
      kind: 'example',
      capabilities: {
        threadReply: false,
        ack: false,
        richText: false,
        documents: false,
        directory: false,
        attachmentsIn: false,
        attachmentsOut: false,
        idempotency: false,
        maxTextLength: 4000,
        directMessage: false,
      },
      normalize(raw) {
        const event = (raw ?? {}) as Record<string, unknown>
        const text = typeof event.text === 'string' ? event.text : ''
        if (!text) return { dropped: 'empty-text' }
        return {
          trigger: {
            id: String(event.id ?? `${Date.now()}`),
            source: 'example',
            channelId: 'example',
            externalId: String(event.id ?? ''),
            threadId: `example:${event.chatId ?? 'default'}`,
            chatId: String(event.chatId ?? 'default'),
            chatName: '',
            actorId: String(event.actorId ?? ''),
            actorName: '',
            isBot: false,
            text,
            addressed: 'direct',
            receivedAt: new Date().toISOString(),
            disposition: 'pending',
          },
        }
      },
      async send(message) {
        ctx.logger.info('example:send', { target: message.targetId, chars: message.text.length })
        return {}
      },
    }
  },
}

export default plugin
