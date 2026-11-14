import { noopLogger, type Logger } from '@router-agent/infra/logger.js'
import type { CommandRunner } from '@router-agent/infra/process.js'
import type { ImageTranscriber } from '@router-agent/infra/vision.js'
import type { Trigger } from '@router-agent/core/model.js'
import { FeishuBotAdmin } from '../sources/feishu-bot-admin.js'
import { attachImageText } from '../sources/feishu-image.js'
import { normalizeCardAction } from '../sources/feishu-reply.js'
import {
  FeishuConsumer,
  FeishuSender,
  attachQuotedMessage,
  normalizeFeishuEventDetailed,
  shouldSendAsText,
  type FeishuConfig,
  type MessageAdmission,
  type UnaddressedAdmission,
} from '../sources/feishu.js'
import { createLarkRunner, larkEnv } from '../sources/lark.js'
import { DEFAULT_CHANNEL_ID, type CardAction, type ChannelAdapter, type ChannelCapabilities, type NormalizedInbound, type OutboundMessage, type QuestionCardUpdate, type SendReceipt } from '@router-agent/channel'
import type { ReplyPayload } from '@router-agent/core/reply.js'

export interface FeishuChannelHooks {
  /** 事件流就绪。 */
  onReady?: () => void
  /** 断线重连。 */
  onReconnect?: (info: { attempt: number; delayMs: number }) => void
  /** 传输级错误。 */
  onError?: (error: Error) => void
  onLine?: (line: string) => void
}

export interface FeishuSenderLike {
  reply(messageId: string, text: string, idempotencyKey: string): Promise<void>
  send(chatId: string, text: string, idempotencyKey: string): Promise<void>
  sendCard(chatId: string, markdown: string, idempotencyKey: string): Promise<void>
  replyCard(messageId: string, markdown: string, idempotencyKey: string): Promise<void>
  sendReply(chatId: string, payload: ReplyPayload, idempotencyKey: string): Promise<void>
  replyReply(messageId: string, payload: ReplyPayload, idempotencyKey: string): Promise<void>
  updateQuestionCard(update: QuestionCardUpdate): Promise<void>
  react(messageId: string, emojiType: string): Promise<string | null>
  unreact(messageId: string, reactionId: string): Promise<void>
  createDocument(title: string, markdown: string): Promise<string>
}

export interface FeishuChannelOptions {
  config: FeishuConfig
  runner: CommandRunner
  /** 收到消息后立即回的确认表情；空表示关闭回执。 */
  reaction?: string
  /** 群名目录；用于日志与消息上的可读群名。 */
  directory?: { nameOf(chatId: string): string }
  transcriber?: ImageTranscriber | null
  logger?: Logger
  /** lark-cli 可执行文件名与子进程环境；测试注入点。 */
  bin?: string
  env?: Record<string, string | undefined>
  imagesRoot?: string
  hooks?: FeishuChannelHooks
  /** 注入点：测试里替换为假 sender/admin。 */
  sender?: FeishuSenderLike
  admin?: FeishuBotAdmin
  /** 是否启动卡片按钮回调消费；关闭时 choices 退化为序号回复。 */
  cardActions?: boolean
  /**
   * 未 @ 机器人的消息要不要放行。
   *
   * `mode: mention` 的群默认只收 @；已绑定工单的话题内，名单内成员不 @ 也要触发回复，
   * 这个判定需要 store（话题有没有绑在办工单）与 policy（谁在名单里），由装配层注入。
   */
  allowUnaddressed?: UnaddressedAdmission
  /**
   * 群的消息范围判定：这条消息要不要进领域。
   *
   * 范围（仅接受管理员消息 / 接受普通用户@消息 / 接受所有消息）与发送人身份都在宿主侧，
   * 由装配层注入这个只读判定；不注入时按「都收」处理。
   */
  admitMessage?: MessageAdmission
}

/**
 * 飞书通道适配器。
 *
 * 把原先散在 CLI 与 Service 里的飞书细节收口到这里：事件消费、归一化、引用/图片富化、
 * 文本/卡片渲染、回执、云文档、凭据与授权。内核只看到 `ChannelAdapter`。
 */
export class FeishuChannel implements ChannelAdapter {
  readonly id = DEFAULT_CHANNEL_ID
  readonly kind = 'feishu'
  readonly capabilities: ChannelCapabilities
  readonly admin: FeishuBotAdmin

  private readonly config: FeishuConfig
  private readonly runner: CommandRunner
  private readonly reaction: string
  private readonly directory?: { nameOf(chatId: string): string }
  private readonly transcriber: ImageTranscriber | null | undefined
  private readonly logger: Logger
  private readonly sender: FeishuSenderLike
  private readonly opts: FeishuChannelOptions
  private consumer: FeishuConsumer | null = null
  private cardConsumer: FeishuConsumer | null = null

  constructor(opts: FeishuChannelOptions) {
    this.opts = opts
    this.config = opts.config
    this.runner = opts.runner
    this.reaction = opts.reaction ?? ''
    this.directory = opts.directory
    this.transcriber = opts.transcriber
    this.logger = opts.logger ?? noopLogger
    this.sender = opts.sender ?? new FeishuSender(opts.runner, this.logger)
    this.admin = opts.admin ?? new FeishuBotAdmin({ lark: opts.runner })
    this.capabilities = {
      threadReply: true,
      ack: Boolean(opts.reaction),
      richText: true,
      documents: true,
      directory: true,
      attachmentsIn: true,
      attachmentsOut: true,
      images: true,
      cards: true,
      choices: Boolean(opts.cardActions),
      idempotency: true,
      maxTextLength: 3500,
      directMessage: opts.config.directMessages,
    }
  }

  normalize(raw: unknown): NormalizedInbound {
    const event = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const chatId = String(event.chat_id ?? '')
    const targetName = this.directory?.nameOf(chatId) ?? ''
    const result = normalizeFeishuEventDetailed(event, this.config, targetName, this.opts.allowUnaddressed, this.opts.admitMessage)
    if (!result.trigger) {
      return {
        dropped: result.dropped,
        ...(result.chatId ? { targetId: result.chatId } : {}),
        ...(result.chatId ? { targetName } : {}),
        ...(result.actorId ? { actorId: result.actorId } : {}),
      }
    }
    return {
      trigger: { ...result.trigger, channelId: this.id },
      targetId: result.chatId,
      targetName,
      ...(result.actorId ? { actorId: result.actorId } : {}),
    }
  }

  /** 图片消息要先下载识别，耗时较久；CLI 据此决定是否提前加回执。 */
  needsEnrichment(trigger: Trigger): boolean {
    const raw = trigger.raw as Record<string, unknown> | undefined
    return Boolean(trigger.mediaOnly) || Array.isArray(raw?.imageKeys)
  }

  async enrich(trigger: Trigger): Promise<Trigger> {
    const quoted = await attachQuotedMessage(trigger, this.runner, { logger: this.logger })
    return attachImageText(quoted, {
      runner: this.runner,
      transcriber: this.transcriber,
      ...(this.opts.imagesRoot ? { imagesRoot: this.opts.imagesRoot } : {}),
      logger: this.logger,
    })
  }

  async send(message: OutboundMessage): Promise<SendReceipt> {
    const text = message.text.trim()
    if (!text && !message.blocks?.length) return {}
    const key = message.idempotencyKey
    if (message.blocks?.length) {
      const payload: ReplyPayload = { blocks: message.blocks, fallbackText: text || '（无文字内容）' }
      if (message.threadRef) await this.sender.replyReply(message.threadRef, payload, key)
      else await this.sender.sendReply(message.targetId, payload, key)
      return { degradedTo: 'rich' }
    }
    if (shouldSendAsText(text)) {
      if (message.threadRef) await this.sender.reply(message.threadRef, text, key)
      else await this.sender.send(message.targetId, text, key)
      return { degradedTo: 'plain' }
    }
    // Markdown 走互动卡片；卡片失败时 FeishuSender 内部降级为 post 富文本。
    if (message.threadRef) await this.sender.replyCard(message.threadRef, text, key)
    else await this.sender.sendCard(message.targetId, text, key)
    return { degradedTo: 'rich' }
  }

  async ack(messageId: string): Promise<string | null> {
    if (!this.reaction) return null
    return this.sender.react(messageId, this.reaction)
  }

  async clearAck(messageId: string, handle: string): Promise<void> {
    await this.sender.unreact(messageId, handle)
  }

  async createDocument(title: string, markdown: string): Promise<string> {
    return this.sender.createDocument(title, markdown)
  }

  async startCardActions(sink: (action: CardAction) => void, opts?: { onError?: (error: Error) => void }): Promise<void> {
    if (this.cardConsumer || !this.opts.cardActions) return
    this.cardConsumer = new FeishuConsumer({
      ...(this.opts.bin ? { bin: this.opts.bin } : {}),
      env: this.opts.env ?? larkEnv(),
      eventKey: 'card.action.trigger',
      onEvent: raw => {
        const action = normalizeCardAction(raw)
        if (action) sink({ ...action, channelId: this.id })
      },
      onError: error => {
        this.logger.warn('feishu:card-consumer-error', { detail: error.message })
        opts?.onError?.(error)
      },
    })
    try {
      this.cardConsumer.start()
    } catch (error) {
      this.cardConsumer = null
      opts?.onError?.(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  stopCardActions(): void {
    this.cardConsumer?.stop()
    this.cardConsumer = null
  }

  async updateQuestionCard(update: QuestionCardUpdate): Promise<void> {
    await this.sender.updateQuestionCard(update)
  }

  async start(sink: (raw: unknown) => void): Promise<void> {
    if (this.consumer) return
    this.consumer = new FeishuConsumer({
      ...(this.opts.bin ? { bin: this.opts.bin } : {}),
      env: this.opts.env ?? larkEnv(),
      onEvent: sink,
      ...(this.opts.hooks?.onReady ? { onReady: this.opts.hooks.onReady } : {}),
      ...(this.opts.hooks?.onReconnect ? { onReconnect: this.opts.hooks.onReconnect } : {}),
      ...(this.opts.hooks?.onError ? { onError: this.opts.hooks.onError } : {}),
      ...(this.opts.hooks?.onLine ? { onLine: this.opts.hooks.onLine } : {}),
    })
    this.consumer.start()
  }

  stop(): void {
    this.consumer?.stop()
    this.consumer = null
    this.stopCardActions()
  }
}

/** 生产装配：用固定 profile 的 lark-cli runner 构造飞书通道。 */
export function createFeishuChannel(opts: Omit<FeishuChannelOptions, 'runner'> & { runner?: CommandRunner }): FeishuChannel {
  return new FeishuChannel({ ...opts, runner: opts.runner ?? createLarkRunner() })
}

/**
 * `ra doc` 用的轻量文档器。
 *
 * 一期仍直连飞书；等接入第二通道时改走 Router API，按工单所在通道选择实现。
 */
export function createFeishuDocumenter(opts: { runner?: CommandRunner } = {}): { createDocument(title: string, markdown: string): Promise<string> } {
  const sender = new FeishuSender(opts.runner ?? createLarkRunner())
  return { createDocument: (title, markdown) => sender.createDocument(title, markdown) }
}
