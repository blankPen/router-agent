import type { Trigger } from '@router-agent/core/model.js'
import type { ReplyBlock, ReplyQuestion } from '@router-agent/core/reply.js'

/**
 * 默认通道实例 ID。
 *
 * 一期只有飞书一个通道，所有历史数据都归属于这个实例；等接入第二个通道时，
 * 实例 ID 会来自配置（`channels.<id>`），这里的常量只作为兼容默认值。
 */
export const DEFAULT_CHANNEL_ID = 'feishu'

/** 通道能力声明。内核按能力降级，不假设所有通道长得一样。 */
export interface ChannelCapabilities {
  /** 支持话题/线程内回复。 */
  threadReply: boolean
  /** 支持消息回执（表情或已读）。 */
  ack: boolean
  /** 支持富文本渲染。 */
  richText: boolean
  /** 支持创建可分享的长文档。 */
  documents: boolean
  /** 支持枚举可接收目标。 */
  directory: boolean
  /** 支持拉取入站附件。 */
  attachmentsIn: boolean
  /** 支持发送出站附件（一期全部 false）。 */
  attachmentsOut: boolean
  /** 支持发送图片（上传后以 img_key 渲染）。 */
  images?: boolean
  /** 支持结构化互动卡片。 */
  cards?: boolean
  /** 支持卡片按钮回调（不支持时题面退化为序号回复）。 */
  choices?: boolean
  /** 支持服务端幂等键。 */
  idempotency: boolean
  /** 单条消息字符上限，用于切块。 */
  maxTextLength: number
  /** 私聊是否可用。 */
  directMessage: boolean
}

/** 出站消息的中立形态；具体渲染由通道适配器负责。 */
export interface OutboundMessage {
  channelId: string
  targetId: string
  /** 希望回复到的话题根；为空时发到 targetId。 */
  threadRef?: string
  text: string
  /** 结构化回复块；有值时优先于纯文本渲染。 */
  blocks?: ReplyBlock[]
  format: 'plain' | 'markdown'
  idempotencyKey: string
  /** 触发这条回复的用户消息，用于发送成功后撤销回执。 */
  originMessageId?: string
}

export interface SendReceipt {
  messageId?: string
  /** 实际发生的降级，便于日志与排障。 */
  degradedTo?: 'plain' | 'rich' | 'document'
}

/** 卡片按钮回调：中立化的最小字段集，具体事件形态由通道适配器解析。 */
export interface CardAction {
  id: string
  channelId: string
  chatId: string
  messageId: string
  operatorId: string
  /** 飞书延迟更新卡片的 token；其他通道可为空。 */
  token: string
  /** 按钮上携带的 value（已解析成对象）。 */
  value: Record<string, unknown>
}

/** 回写一道已答 / 已过期的选择题卡片。 */
export interface QuestionCardUpdate {
  token: string
  operatorId: string
  question: ReplyQuestion
  selected: string[]
  expired?: boolean
}

/** 归一化结果：要么得到领域 Trigger，要么给出丢弃原因。 */
export interface NormalizedInbound {
  trigger?: Trigger
  dropped?: string
  targetId?: string
  targetName?: string
  actorId?: string
}

export interface ChannelStatus {
  appId?: string
  bot?: { available?: boolean; status?: string; message?: string }
  user?: { available?: boolean; status?: string; message?: string; openId?: string; userName?: string }
}

export interface ChannelAdmin {
  readonly profileHome: string
  status(): Promise<ChannelStatus>
  configure(appId: string, appSecret: string): Promise<{ ok: boolean; message?: string }>
  // 各通道的授权载荷结构不同；由面板原样透传。
  startLogin(): Promise<any>
  completeLogin(code: string): Promise<any>
}

/**
 * 通道公共契约。
 *
 * 内核只依赖这个接口；飞书的 lark-cli 调用、事件过滤、卡片渲染全部封装在实现里。
 * 一期只实现飞书，但签名预留了话题、回执、文档与附件能力，接第二通道时不用改内核。
 */
export interface ChannelAdapter {
  readonly id: string
  readonly kind: string
  readonly capabilities: ChannelCapabilities

  /** 启动入站消费；主动拉取型通道可以不实现。 */
  start?(sink: (raw: unknown) => void): Promise<void> | void
  stop?(): void

  /** 原始事件 -> 领域 Trigger；只做传输合法性，不做需要跨消息的富化。 */
  normalize(raw: unknown): NormalizedInbound

  /** 这条消息入库前是否需要富化（引用回查、附件下载/OCR）。 */
  needsEnrichment?(trigger: Trigger): boolean

  /** 通道内富化；失败不应阻塞主流程，实现方负责降级与记日志。 */
  enrich?(trigger: Trigger): Promise<Trigger>

  send(message: OutboundMessage): Promise<SendReceipt>

  /** 启动卡片按钮回调消费；不支持时由内核走序号回复。 */
  startCardActions?(sink: (action: CardAction) => void, opts?: { onError?: (error: Error) => void }): Promise<void> | void
  stopCardActions?(): void

  /** 用户点选后把卡片回写成已选 / 已过期状态。 */
  updateQuestionCard?(update: QuestionCardUpdate): Promise<void>

  /** 给一条消息加回执，返回通道侧句柄；不支持时返回 null。 */
  ack?(messageId: string): Promise<string | null>
  clearAck?(messageId: string, handle: string): Promise<void>

  listTargets?(): Promise<{ id: string; name: string }[]>
  createDocument?(title: string, markdown: string): Promise<string>

  readonly admin?: ChannelAdmin
}
