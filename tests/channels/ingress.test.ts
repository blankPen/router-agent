import { describe, expect, it } from 'vitest'
import { ChannelIngress } from '#channel/ingress.js'
import type { ChannelAdapter } from '#channel/port.js'
import type { Engine } from '../../src/core/engine.js'
import type { Trigger } from '#core/model.js'
import { DEFAULT_ADMISSION, shouldAcknowledge, type Policy } from '#core/policy.js'
import { Store } from '../../src/store/db.js'
import type { Logger } from '#infra/logger.js'

const policy: Policy = {
  version: 'p1',
  acceptMode: 'auto',
  maxWorkers: 4,
  allowed: ['ou_alice'],
  bots: [],
  admission: DEFAULT_ADMISSION,
  receiveAll: false,
}

function trigger(): Trigger {
  return {
    id: 'feishu_om_1',
    source: 'feishu',
    channelId: 'feishu',
    externalId: 'om_1',
    threadId: 'feishu:oc_dev:om_1',
    chatId: 'oc_dev',
    chatName: '研发群',
    actorId: 'ou_alice',
    actorName: 'Alice',
    isBot: false,
    text: '帮我看下',
    addressed: 'mention',
    receivedAt: '2026-11-10T00:00:00.000Z',
    disposition: 'pending',
  }
}

function adapter(over: Partial<ChannelAdapter> = {}): ChannelAdapter {
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
    normalize: () => ({ trigger: trigger() }),
    async send() {
      return {}
    },
    async ack() {
      return 're_1'
    },
    ...over,
  }
}

function logger(logs: { message: string; level: string; extra?: Record<string, unknown> }[]): Logger {
  return {
    info: (message, extra) => logs.push({ message, level: 'info', ...(extra ? { extra } : {}) }),
    warn: (message, extra) => logs.push({ message, level: 'warn', ...(extra ? { extra } : {}) }),
    error: (message, extra) => logs.push({ message, level: 'error', ...(extra ? { extra } : {}) }),
  }
}

describe('入站管线', () => {
  it('入库后回执，并把句柄交给落盘回调', async () => {
    const store = new Store(':memory:')
    const logs: Parameters<typeof logger>[0] = []
    const acked: string[] = []
    const ingested: string[] = []
    const ingress = new ChannelIngress({
      adapter: adapter(),
      engine: { ingest: (t: Trigger) => { ingested.push(t.id); return true } } as unknown as Engine,
      store,
      logger: logger(logs),
      shouldReply: () => true,
      onAck: (messageId, handle) => acked.push(`${messageId}:${handle}`),
    })
    ingress.handleRaw({})
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ingested).toEqual(['feishu_om_1'])
    expect(acked).toEqual(['om_1:re_1'])
    expect(logs.find(log => log.message === 'trigger:ingested')?.extra).toMatchObject({ channel: 'feishu' })
    store.close()
  })

  it('被丢弃的消息只记原因', () => {
    const store = new Store(':memory:')
    const logs: Parameters<typeof logger>[0] = []
    const ingress = new ChannelIngress({
      adapter: adapter({ normalize: () => ({ dropped: 'chat:not-monitored', targetId: 'oc_x' }) }),
      engine: { ingest: () => true } as unknown as Engine,
      store,
      logger: logger(logs),
      shouldReply: () => true,
    })
    ingress.handleRaw({})
    expect(logs[0]).toMatchObject({
      message: 'trigger:dropped',
      level: 'info',
      extra: { channel: 'feishu', reason: 'chat:not-monitored', chat: 'oc_x' },
    })
    store.close()
  })

  it('回执失败只记 warn，不影响入库', async () => {
    const store = new Store(':memory:')
    const logs: Parameters<typeof logger>[0] = []
    const ingested: string[] = []
    const ingress = new ChannelIngress({
      adapter: adapter({ ack: async () => { throw new Error('boom') } }),
      engine: { ingest: (t: Trigger) => { ingested.push(t.id); return true } } as unknown as Engine,
      store,
      logger: logger(logs),
      shouldReply: () => true,
    })
    ingress.handleRaw({})
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ingested).toEqual(['feishu_om_1'])
    expect(logs.find(log => log.message === 'channel:ack-failed')?.extra).toMatchObject({ channel: 'feishu', message: 'boom' })
    store.close()
  })

  it('未 @ 但被放行的消息也要加确认表情，否则用户看不到回应', async () => {
    const store = new Store(':memory:')
    const acked: string[] = []
    const ingress = new ChannelIngress({
      adapter: adapter({ normalize: () => ({ trigger: { ...trigger(), addressed: 'none', unaddressedAdmitted: true } }) }),
      engine: { ingest: () => true } as unknown as Engine,
      store,
      shouldReply: t => shouldAcknowledge(t, policy, new Set()),
      onAck: (messageId, handle) => acked.push(`${messageId}:${handle}`),
    })
    ingress.handleRaw({})
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(acked).toEqual(['om_1:re_1'])
    store.close()
  })

  it('普通未 @ 消息不加确认表情', async () => {
    const store = new Store(':memory:')
    const acked: string[] = []
    const ingress = new ChannelIngress({
      adapter: adapter({ normalize: () => ({ trigger: { ...trigger(), addressed: 'none' } }) }),
      engine: { ingest: () => true } as unknown as Engine,
      store,
      shouldReply: t => shouldAcknowledge(t, policy, new Set()),
      onAck: (messageId, handle) => acked.push(`${messageId}:${handle}`),
    })
    ingress.handleRaw({})
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(acked).toEqual([])
    store.close()
  })
})
