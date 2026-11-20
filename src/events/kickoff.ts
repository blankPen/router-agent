/**
 * 事件工单开工通知：先私聊用户，再以这条私聊消息为根建话题，并把工单绑到话题。
 *
 * 这里是「事件 → 工单 → 真正执行」链路里唯一新增的一段；事件判定、开单与派工本身不变。
 * 拿不到接收人、私聊不可用或发送失败都只降级为群通知，绝不能中断派工。
 */
import type { AppConfig } from '../config.js'
import type { Store } from '../store/db.js'
import { DEFAULT_CHANNEL_ID } from '#channel/port.js'
import type { ChannelRegistry } from '#channel/registry.js'
import type { Ticket } from '#core/model.js'
import { preview } from '#core/events.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'

/** 事件来源配置里的接收人解析结果。 */
export interface EventKickoffOwner {
  openId: string
  name?: string
}

/** 绑定成功后的会话落点。 */
export interface EventKickoffBinding {
  threadId: string
  chatId: string
  channelId: string
  messageId: string
}

export interface EventKickoffDeps {
  store: Store
  config: () => AppConfig
  channels: ChannelRegistry
  /** 把事件来源配置里的邮箱 / open_id 解析成飞书用户；解析不到返回 null。 */
  resolveOwner: (entry: string) => Promise<EventKickoffOwner | null>
  clock?: () => string
  logger?: Logger
}

function cursorKey(ticketId: string): string {
  return `event:kickoff:${ticketId}`
}

function idempotencyKey(ticketId: string, action: 'notice' | 'thread'): string {
  return `event:kickoff:${ticketId}:${action}`
}

function isEventTicket(ticket: Ticket): boolean {
  return ticket.source.startsWith('event:')
}

function sourceIdOf(ticket: Ticket): string {
  return ticket.source.slice('event:'.length)
}

function uniqueKeys(...keys: Array<string | undefined>): string[] {
  return [...new Set(keys.map(key => key?.trim() ?? '').filter(Boolean))]
}

export class EventKickoff {
  private readonly store: Store
  private readonly config: () => AppConfig
  private readonly channels: ChannelRegistry
  private readonly resolveOwner: (entry: string) => Promise<EventKickoffOwner | null>
  private readonly clock: () => string
  private readonly logger: Logger
  private readonly inFlight = new Map<string, Promise<EventKickoffBinding | null>>()

  constructor(deps: EventKickoffDeps) {
    this.store = deps.store
    this.config = deps.config
    this.channels = deps.channels
    this.resolveOwner = deps.resolveOwner
    this.clock = deps.clock ?? (() => new Date().toISOString())
    this.logger = deps.logger ?? noopLogger
  }

  /**
   * 开工前调用；返回 null 表示没有私聊绑定，调用方按原群通知继续派工。
   * 已绑定、已在执行或正在发送时直接复用/跳过，不重复发消息或建话题。
   */
  start(ticket: Ticket): Promise<EventKickoffBinding | null> {
    const running = this.inFlight.get(ticket.id)
    if (running) return running
    const task = this.run(ticket).finally(() => this.inFlight.delete(ticket.id))
    this.inFlight.set(ticket.id, task)
    return task
  }

  private async run(ticket: Ticket): Promise<EventKickoffBinding | null> {
    if (!isEventTicket(ticket)) return null
    const now = this.clock()
    const current = this.store.getTicket(ticket.id) ?? ticket
    const bound = this.boundOf(current)
    if (bound) {
      this.logger.info('event:kickoff-skipped', { ticketId: ticket.id, reason: 'already-bound', threadId: bound.threadId })
      return bound
    }

    const cursor = this.store.getCursor(cursorKey(ticket.id))
    if (cursor) {
      const parsed = this.parseBinding(cursor)
      if (parsed) return parsed
      this.logger.warn('event:kickoff-cursor-invalid', { ticketId: ticket.id, detail: preview(cursor, 120) })
    }

    const latest = this.store.latestAssignment(ticket.id)
    if (latest && latest.status !== 'ended') {
      this.logger.info('event:kickoff-skipped', { ticketId: ticket.id, reason: 'worker-running' })
      return null
    }

    const sourceId = sourceIdOf(ticket)
    const event = this.store.getEventByTicketId(ticket.id)
    const source = this.config().events.sources[sourceId]
    const ownerEntry = source?.owner?.trim() || event?.context?.actorOpenId?.trim() || ''
    if (!ownerEntry) return this.fallback(ticket, sourceId, 'owner-missing')
    if (!this.config().feishu.directMessages) return this.fallback(ticket, sourceId, 'dm-disabled')

    const adapter = this.channels.get(ticket.channelId ?? DEFAULT_CHANNEL_ID)
    if (!adapter) return this.fallback(ticket, sourceId, 'channel-missing')
    if (!adapter.capabilities.directMessage) return this.fallback(ticket, sourceId, 'dm-disabled', { channelId: adapter.id })

    let owner: EventKickoffOwner | null = null
    try {
      owner = await this.resolveOwner(ownerEntry)
    } catch (error) {
      return this.fail(ticket, sourceId, 'owner', error, true)
    }
    if (!owner) return this.fallback(ticket, sourceId, 'owner-unresolved')

    const task = preview(ticket.request?.trim() || ticket.title, 160)
    const notice = [
      `事件已开工：工单 ${ticket.id}`,
      `任务内容：${task}`,
      '后续进展会在这个话题里更新；你也可以直接在话题里追加需求或中止。',
    ].join('\n')

    let direct
    try {
      direct = await adapter.send({
        channelId: adapter.id,
        targetId: owner.openId,
        direct: true,
        text: notice,
        format: 'plain',
        idempotencyKey: idempotencyKey(ticket.id, 'notice'),
      })
    } catch (error) {
      return this.fail(ticket, sourceId, 'direct', error, true)
    }
    if (!direct.messageId) {
      return this.fail(ticket, sourceId, 'direct', new Error('私聊发送没有返回 message_id'), true)
    }

    let chatId = direct.chatId ?? ''
    if (!chatId && adapter.resolveMessageThread) {
      try {
        chatId = (await adapter.resolveMessageThread(direct.messageId))?.chatId ?? ''
      } catch (error) {
        this.logger.warn('event:kickoff-meta-failed', {
          ticketId: ticket.id,
          sourceId,
          messageId: direct.messageId,
          detail: preview(errorMessage(error), 200),
        })
      }
    }
    if (!chatId) {
      this.logger.warn('event:kickoff-failed', {
        ticketId: ticket.id,
        sourceId,
        stage: 'direct',
        detail: '私聊发送成功但拿不到会话 ID，无法绑定话题',
      })
      return null
    }

    // 以私聊消息为根建话题；失败时退化为绑定私聊消息本身，后续进展仍能回复到这条消息。
    let threadReply
    try {
      threadReply = await adapter.send({
        channelId: adapter.id,
        targetId: chatId,
        threadRef: direct.messageId,
        text: `工单「${ticket.title}」已开始执行（${ticket.id}）。后续进展会在这里同步，可直接回复、追加需求或中止。`,
        format: 'plain',
        idempotencyKey: idempotencyKey(ticket.id, 'thread'),
      })
    } catch (error) {
      this.logger.warn('event:kickoff-failed', {
        ticketId: ticket.id,
        sourceId,
        stage: 'thread',
        detail: preview(errorMessage(error), 200),
        fallback: 'dm-message',
      })
    }
    if (threadReply && !threadReply.messageId) {
      this.logger.warn('event:kickoff-failed', {
        ticketId: ticket.id,
        sourceId,
        stage: 'thread',
        detail: '话题回复没有返回 message_id，改用私聊消息本身',
        fallback: 'dm-message',
      })
    }

    const messageId = threadReply?.messageId || direct.messageId
    let meta: { threadId: string; rootId: string; chatId: string } | null = null
    if (adapter.resolveMessageThread) {
      try {
        meta = await adapter.resolveMessageThread(messageId)
      } catch (error) {
        this.logger.warn('event:kickoff-meta-failed', {
          ticketId: ticket.id,
          sourceId,
          messageId,
          detail: preview(errorMessage(error), 200),
        })
      }
    }

    const threadSource = adapter.kind || adapter.id
    const threadId = `${threadSource}:${chatId}:${messageId}`
    const aliases = uniqueKeys(direct.messageId, threadReply?.messageId, messageId, meta?.threadId, meta?.rootId)
    this.store.bindTicketThread({
      ticketId: ticket.id,
      threadId,
      chatId,
      channelId: adapter.id,
      threadSource,
      actorId: owner.openId,
      actorName: owner.name ?? '',
      aliases,
      createdAt: now,
    })
    const binding: EventKickoffBinding = { threadId, chatId, channelId: adapter.id, messageId }
    this.store.setCursor(cursorKey(ticket.id), JSON.stringify(binding), now)
    this.logger.info('event:kickoff', {
      ticketId: ticket.id,
      ...(event ? { eventId: event.id } : {}),
      sourceId,
      chat: chatId,
      ...(owner.name ? { chatName: owner.name, actorName: owner.name } : {}),
      threadId,
      messageId,
      actor: owner.openId,
      actorType: 'user',
      category: 'action',
      ...(threadReply ? {} : { fallback: 'dm-message' }),
    })
    return binding
  }

  /** 已绑定到真实消息的话题：直接复用，不再发送。 */
  private boundOf(ticket: Ticket): EventKickoffBinding | null {
    const tail = ticket.threadId.split(':').at(-1) ?? ''
    if (!/^om_/.test(tail) || ticket.threadId.startsWith('event:') || !ticket.chatId) return null
    return {
      threadId: ticket.threadId,
      chatId: ticket.chatId,
      channelId: ticket.channelId ?? DEFAULT_CHANNEL_ID,
      messageId: tail,
    }
  }

  private parseBinding(raw: string): EventKickoffBinding | null {
    try {
      const parsed = JSON.parse(raw) as Partial<EventKickoffBinding>
      if (typeof parsed.threadId !== 'string' || typeof parsed.chatId !== 'string' || typeof parsed.messageId !== 'string') return null
      return {
        threadId: parsed.threadId,
        chatId: parsed.chatId,
        channelId: parsed.channelId ?? DEFAULT_CHANNEL_ID,
        messageId: parsed.messageId,
      }
    } catch {
      return null
    }
  }

  /** 降级为现有群通知；拿不到群时留一条日志即可，派工继续。 */
  private fallback(ticket: Ticket, sourceId: string, reason: string, extra: Record<string, unknown> = {}): null {
    const chatId = ticket.chatId
    this.logger.warn('event:kickoff-fallback', {
      ticketId: ticket.id,
      sourceId,
      reason,
      ...(chatId ? { chat: chatId } : {}),
      ...extra,
    })
    if (!chatId) return null
    const why = reason.startsWith('owner')
      ? '未找到可用的飞书私聊接收人'
      : reason === 'dm-disabled'
        ? '私聊通知未开启或当前通道不支持'
        : '私聊通知发送失败'
    const text = [
      `事件已开工：工单「${ticket.title}」（${ticket.id}）已开始执行。`,
      `任务内容：${preview(ticket.request?.trim() || ticket.title, 160)}`,
      `${why}，后续进展会发在本群。`,
    ].join('\n')
    this.store.enqueueOutbox({
      id: `ob_event_kickoff_fallback_${ticket.id}`,
      key: `event:kickoff-fallback:${ticket.id}`,
      channelKind: ticket.channelId ?? DEFAULT_CHANNEL_ID,
      channelId: chatId,
      threadId: '',
      text,
      now: this.clock(),
    })
    return null
  }

  private fail(ticket: Ticket, sourceId: string, stage: string, error: unknown, fallbackToGroup = false): null {
    this.logger.warn('event:kickoff-failed', {
      ticketId: ticket.id,
      sourceId,
      stage,
      detail: preview(errorMessage(error), 300),
    })
    if (fallbackToGroup) return this.fallback(ticket, sourceId, `${stage}-failed`)
    return null
  }
}
