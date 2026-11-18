import { describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { chatEntry, defaultConfig, policyOf, type AppConfig } from '../../src/config.js'
import { EventKickoff } from '../../src/events/kickoff.js'
import { ChannelRegistry } from '#channel/registry.js'
import type { ChannelAdapter, OutboundMessage, SendReceipt } from '#channel/port.js'
import type { Ticket, Trigger } from '#core/model.js'
import type { Logger } from '#infra/logger.js'

const NOW = '2026-11-18T08:00:00.000Z'

class FakeKickoffChannel implements ChannelAdapter {
  readonly id = 'feishu'
  readonly kind = 'feishu'
  readonly capabilities = {
    threadReply: true,
    ack: false,
    richText: true,
    documents: false,
    directory: false,
    attachmentsIn: false,
    attachmentsOut: false,
    idempotency: true,
    maxTextLength: 3500,
    directMessage: true,
  }
  directs: { userId: string; text: string; key: string }[] = []
  replies: { targetId: string; threadRef?: string; text: string; key: string }[] = []
  failDirect = false
  failThread = false

  normalize(): { dropped: string } {
    return { dropped: 'test' }
  }

  async send(message: OutboundMessage): Promise<SendReceipt> {
    if (message.direct) {
      if (this.failDirect) throw new Error('feishu:send-failed: missing scope')
      this.directs.push({ userId: message.targetId, text: message.text, key: message.idempotencyKey })
      return { messageId: 'om_dm', chatId: 'oc_p2p' }
    }
    if (this.failThread && message.threadRef) throw new Error('feishu:reply-failed: thread unavailable')
    this.replies.push({
      targetId: message.targetId,
      ...(message.threadRef ? { threadRef: message.threadRef } : {}),
      text: message.text,
      key: message.idempotencyKey,
    })
    if (message.threadRef === 'om_dm') return { messageId: 'om_thread', chatId: 'oc_p2p' }
    return { messageId: `om_reply_${this.replies.length}`, chatId: message.targetId }
  }

  async resolveMessageThread(messageId: string): Promise<{ threadId: string; rootId: string; chatId: string } | null> {
    if (messageId !== 'om_thread') return null
    return { threadId: 'omt_topic', rootId: 'om_thread', chatId: 'oc_p2p' }
  }
}

class CapturingLogger implements Logger {
  records: { level: string; message: string; extra?: Record<string, unknown> }[] = []
  info(message: string, extra?: Record<string, unknown>): void {
    this.records.push({ level: 'info', message, ...(extra ? { extra } : {}) })
  }
  warn(message: string, extra?: Record<string, unknown>): void {
    this.records.push({ level: 'warn', message, ...(extra ? { extra } : {}) })
  }
  error(message: string, extra?: Record<string, unknown>): void {
    this.records.push({ level: 'error', message, ...(extra ? { extra } : {}) })
  }
}

function setup(over: {
  owner?: string
  directMessages?: boolean
  actorOpenId?: string
  resolveOwner?: (entry: string) => Promise<{ openId: string; name?: string } | null>
} = {}) {
  const store = new Store(':memory:')
  const config: AppConfig = {
    ...defaultConfig(),
    projects: [{ name: 'acme/web', repo: 'acme/web', defaultBranch: 'main' }],
    feishu: {
      ...defaultConfig().feishu,
      directMessages: over.directMessages ?? true,
      chats: [chatEntry('oc_review', { scope: 'admins' })],
    },
    events: {
      ...defaultConfig().events,
      sources: {
        github: {
          enabled: true,
          kind: 'github',
          repo: 'blankPen/router-agent',
          ...(over.owner === undefined ? {} : { owner: over.owner }),
        },
      },
    },
  }
  let n = 0
  const engine = new Engine({
    store,
    policy: policyOf(config),
    clock: { now: () => NOW },
    ids: { next: prefix => `${prefix}_${++n}` },
  })
  const trigger: Trigger = {
    id: 'trg_event_evt1',
    source: 'event:github',
    externalId: 'issue:1',
    threadId: 'event:github:issue:1',
    chatId: 'oc_review',
    chatName: 'github',
    actorId: 'event:github',
    actorName: '事件来源 github',
    isBot: true,
    text: 'CI 失败\n修复构建',
    addressed: 'none',
    receivedAt: NOW,
    disposition: 'pending',
  }
  engine.ingest(trigger)
  const outcome = engine.decide({
    triggerId: trigger.id,
    decision: 'accept',
    strength: 'inferred',
    reason: '测试事件开单',
    title: '修复 CI',
    scope: '只修构建脚本',
    request: '事件标题：CI 失败\n事件正文：修复构建',
    rules: ['event-decision'],
    repo: 'acme/web',
    branch: 'main',
  })
  const ticket = outcome.ticket as Ticket
  if (over.actorOpenId) {
    store.insertEvent({
      id: 'evt_1',
      sourceId: 'github',
      sourceKind: 'github',
      externalId: 'issue:1',
      title: 'CI 失败',
      body: '修复构建',
      context: { repo: 'blankPen/router-agent', actorOpenId: over.actorOpenId },
      receivedAt: NOW,
      status: 'pending',
      execution: 'none',
      priority: 'P2',
      eventType: 'github.issues.opened',
      needsReview: false,
      ticketId: ticket.id,
      triggerId: trigger.id,
      updatedAt: NOW,
      attempts: 0,
    })
  }

  const channel = new FakeKickoffChannel()
  const channels = new ChannelRegistry()
  channels.register(channel)
  const logger = new CapturingLogger()
  const kickoff = new EventKickoff({
    store,
    config: () => config,
    channels,
    clock: () => NOW,
    logger,
    resolveOwner: over.resolveOwner ?? (async entry => (entry ? { openId: 'ou_pz', name: 'PZ' } : null)),
  })
  return { store, config, engine, channel, channels, logger, kickoff, ticket, trigger }
}

function inbound(threadKeys: string[], text: string): Trigger {
  return {
    id: 'trg_in_1',
    source: 'feishu',
    externalId: 'om_user',
    threadId: `feishu:oc_p2p:${threadKeys.at(-1)}`,
    threadKeys,
    chatId: 'oc_p2p',
    chatName: 'PZ',
    actorId: 'ou_pz',
    actorName: 'PZ',
    isBot: false,
    text,
    addressed: 'direct',
    receivedAt: NOW,
    disposition: 'pending',
  }
}

describe('事件工单开工通知', () => {
  it('事件开工时私聊通知、建话题并把工单绑定到话题', async () => {
    const { store, channel, kickoff, ticket, logger } = setup({ owner: 'pz@example.com' })
    const binding = await kickoff.start(ticket)

    expect(binding).toEqual({ threadId: 'feishu:oc_p2p:om_thread', chatId: 'oc_p2p', channelId: 'feishu', messageId: 'om_thread' })
    expect(channel.directs).toHaveLength(1)
    expect(channel.directs[0]!.userId).toBe('ou_pz')
    expect(channel.directs[0]!.text).toContain(ticket.id)
    expect(channel.directs[0]!.text).toContain('CI 失败')
    expect(channel.replies).toHaveLength(1)
    expect(channel.replies[0]!.threadRef).toBe('om_dm')

    const bound = store.getTicket(ticket.id)!
    expect(bound.threadId).toBe('feishu:oc_p2p:om_thread')
    expect(bound.chatId).toBe('oc_p2p')
    expect(bound.channelId).toBe('feishu')
    expect(store.getMandate(ticket.mandateId)).toMatchObject({
      actorId: 'ou_pz',
      actorName: 'PZ',
      chatId: 'oc_p2p',
      threadId: 'feishu:oc_p2p:om_thread',
    })
    // 旧的事件线程订阅已迁走，新话题订阅生效。
    expect(store.listSubscriptions(ticket.threadId)).toHaveLength(0)
    expect(store.listSubscriptions('feishu:oc_p2p:om_thread').map(sub => sub.ticketId)).toEqual([ticket.id])
    expect(store.findThreadIdByAlias('feishu', 'omt_topic')).toBe('feishu:oc_p2p:om_thread')
    expect(store.findThreadIdByAlias('feishu', 'om_dm')).toBe('feishu:oc_p2p:om_thread')
    expect(logger.records).toContainEqual({
      level: 'info',
      message: 'event:kickoff',
      extra: expect.objectContaining({
        ticketId: ticket.id,
        threadId: 'feishu:oc_p2p:om_thread',
        messageId: 'om_thread',
        actor: 'ou_pz',
        actorType: 'user',
      }),
    })
  })

  it('话题内追加消息会收敛到同一工单并投给 worker', async () => {
    const { store, engine, kickoff, ticket } = setup({ owner: 'pz@example.com' })
    await kickoff.start(ticket)

    engine.ingest(inbound(['omt_topic', 'om_thread', 'om_user'], '再加一个回归测试'))
    const stored = store.getTrigger('trg_in_1')!
    expect(stored.threadId).toBe('feishu:oc_p2p:om_thread')

    const fannedOut = engine.fanOut('trg_in_1')
    expect(fannedOut.map(item => item.id)).toEqual([ticket.id])
    expect(store.pendingInputs(ticket.id).map(input => input.text)).toContain('再加一个回归测试')
  })

  it('已有话题或已在执行时不重复发送通知、不重复建话题', async () => {
    const { store, channel, kickoff, ticket } = setup({ owner: 'pz@example.com' })
    const first = await kickoff.start(ticket)
    const second = await kickoff.start(store.getTicket(ticket.id)!)

    expect(second).toEqual(first)
    expect(channel.directs).toHaveLength(1)
    expect(channel.replies).toHaveLength(1)
  })

  it('已有正在运行的 worker 时不再重复发送开工通知', async () => {
    const { store, engine, channel, kickoff, ticket } = setup({ owner: 'pz@example.com' })
    engine.startAssignment(ticket.id, { runtimeId: 'orca', handle: 'h1', workdir: '' })

    expect(await kickoff.start(ticket)).toBeNull()
    expect(channel.directs).toHaveLength(0)
    expect(channel.replies).toHaveLength(0)
    expect(store.getTicket(ticket.id)!.threadId).toBe('event:github:issue:1')
  })

  it('拿不到接收人时退化为群通知，派工链路继续', async () => {
    const { store, channel, kickoff, logger, ticket } = setup({ owner: '' })
    expect(await kickoff.start(ticket)).toBeNull()

    expect(channel.directs).toHaveLength(0)
    expect(store.getTicket(ticket.id)!.threadId).toBe('event:github:issue:1')
    expect(store.listOutbox().some(item => item.key === `event:kickoff-fallback:${ticket.id}`)).toBe(true)
    expect(logger.records).toContainEqual({
      level: 'warn',
      message: 'event:kickoff-fallback',
      extra: expect.objectContaining({ ticketId: ticket.id, reason: 'owner-missing' }),
    })
  })

  it('接收人解析失败时不发私聊，也不抛错中断派工', async () => {
    const { channel, kickoff, logger, ticket, store } = setup({
      owner: 'pz@example.com',
      resolveOwner: async () => null,
    })

    expect(await kickoff.start(ticket)).toBeNull()
    expect(channel.directs).toHaveLength(0)
    expect(store.getTicket(ticket.id)!.threadId).toBe('event:github:issue:1')
    expect(logger.records).toContainEqual({
      level: 'warn',
      message: 'event:kickoff-fallback',
      extra: expect.objectContaining({ ticketId: ticket.id, reason: 'owner-unresolved' }),
    })
  })

  it('私聊发送失败时记录失败原因并继续派工', async () => {
    const { store, channel, kickoff, logger, ticket } = setup({ owner: 'pz@example.com' })
    channel.failDirect = true

    expect(await kickoff.start(ticket)).toBeNull()
    expect(store.getTicket(ticket.id)!.threadId).toBe('event:github:issue:1')
    expect(logger.records).toContainEqual({
      level: 'warn',
      message: 'event:kickoff-failed',
      extra: expect.objectContaining({ ticketId: ticket.id, stage: 'direct' }),
    })
  })

  it('话题创建失败时绑定到私聊消息本身，后续仍可在消息下继续沟通', async () => {
    const { store, channel, kickoff, ticket } = setup({ owner: 'pz@example.com' })
    channel.failThread = true

    const binding = await kickoff.start(ticket)
    expect(binding).toEqual({ threadId: 'feishu:oc_p2p:om_dm', chatId: 'oc_p2p', channelId: 'feishu', messageId: 'om_dm' })
    expect(store.getTicket(ticket.id)!.threadId).toBe('feishu:oc_p2p:om_dm')
    expect(store.listSubscriptions('feishu:oc_p2p:om_dm').map(sub => sub.ticketId)).toEqual([ticket.id])
  })

  it('事件上下文直接带 open_id 时不需要额外映射', async () => {
    const { channel, kickoff, ticket } = setup({
      owner: '',
      actorOpenId: 'ou_actor',
      resolveOwner: async entry => ({ openId: entry, name: 'Actor' }),
    })
    const binding = await kickoff.start(ticket)
    expect(binding?.threadId).toBe('feishu:oc_p2p:om_thread')
    expect(channel.directs[0]!.userId).toBe('ou_actor')
  })

  it('私聊被关闭时不发私聊，退化为群通知', async () => {
    const { store, channel, kickoff, logger, ticket } = setup({ owner: 'pz@example.com', directMessages: false })
    expect(await kickoff.start(ticket)).toBeNull()
    expect(channel.directs).toHaveLength(0)
    expect(store.getTicket(ticket.id)!.threadId).toBe('event:github:issue:1')
    expect(logger.records).toContainEqual({
      level: 'warn',
      message: 'event:kickoff-fallback',
      extra: expect.objectContaining({ ticketId: ticket.id, reason: 'dm-disabled' }),
    })
  })
})
