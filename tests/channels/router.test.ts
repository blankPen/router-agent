import { describe, expect, it } from 'vitest'
import { ChannelRegistry } from '#channel/registry.js'
import { ChannelRouter } from '#channel/router.js'
import type { ChannelAdapter, OutboundMessage } from '#channel/port.js'
import type { Logger } from '#infra/logger.js'

function adapter(over: Partial<ChannelAdapter> = {}): ChannelAdapter & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = []
  return {
    id: 'feishu',
    kind: 'feishu',
    capabilities: {
      threadReply: true,
      ack: true,
      richText: true,
      documents: true,
      directory: true,
      attachmentsIn: true,
      attachmentsOut: false,
      idempotency: true,
      maxTextLength: 3500,
      directMessage: true,
    },
    normalize: () => ({}),
    async send(message) {
      sent.push(message)
      return {}
    },
    sent,
    ...over,
  }
}

function logger(logs: { message: string; extra?: Record<string, unknown> }[]): Logger {
  return {
    info: (message, extra) => logs.push({ message, ...(extra ? { extra } : {}) }),
    warn: (message, extra) => logs.push({ message, ...(extra ? { extra } : {}) }),
    error: (message, extra) => logs.push({ message, ...(extra ? { extra } : {}) }),
  }
}

describe('通道注册表与出站分发', () => {
  it('按 channelKind 找到适配器并传递话题根与幂等 key', async () => {
    const a = adapter()
    const registry = new ChannelRegistry()
    registry.register(a)
    await new ChannelRouter(registry).send({
      channelKind: 'feishu',
      channelId: 'oc_dev',
      threadId: 'om_root',
      text: ' 已改完 ',
      key: 'k1',
    })
    expect(a.sent).toEqual([{
      channelId: 'feishu',
      targetId: 'oc_dev',
      threadRef: 'om_root',
      text: '已改完',
      format: 'markdown',
      idempotencyKey: 'k1',
    }])
  })

  it('未知通道跳过并记 warn，不阻塞 Outbox', async () => {
    const logs: { message: string; extra?: Record<string, unknown> }[] = []
    await new ChannelRouter(new ChannelRegistry(), logger(logs)).send({
      channelKind: 'slack',
      channelId: 'C1',
      threadId: '',
      text: 'hi',
      key: 'k',
    })
    expect(logs[0]?.message).toBe('channel:not-registered')
    expect(logs[0]?.extra).toMatchObject({ channel: 'slack' })
  })

  it('重复注册同一实例只保留最后一次并记 warn', () => {
    const logs: { message: string; extra?: Record<string, unknown> }[] = []
    const registry = new ChannelRegistry(logger(logs))
    registry.register(adapter())
    registry.register(adapter())
    expect(registry.list()).toHaveLength(1)
    expect(logs[0]?.message).toBe('channel:duplicate-id')
  })
})