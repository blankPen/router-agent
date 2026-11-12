import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Trigger } from '#core/model.js'
import type { ChatAdmissionSettings } from '#core/config.js'
import type { CommandRunner } from '#infra/process.js'
import { noopLogger, errorMessage, type Logger } from '#infra/logger.js'
import { parseImageKeysFromContent } from './feishu-image.js'

export interface FeishuConfig {
  /** 监控的群：每条含接收方式与派工绑定。 */
  chats: ChatAdmissionSettings[]
  directMessages: boolean
  /** 机器人自己的 open_id，用于丢弃自发消息与识别 @。 */
  botOpenIds: string[]
  botNames: string[]
  /** 发送人 open_id → 显示名；由装配阶段用解析结果填好，入站只读，不发任何请求。 */
  actorNames?: Map<string, string>
}

export interface FeishuEvent {
  type?: string
  message_id?: string
  id?: string
  chat_id?: string
  chat_type?: string
  message_type?: string
  content?: string
  create_time?: string
  sender_id?: string
  sender_type?: string
  root_id?: string
  /** 被引用/回复的那条消息 ID。lark-cli 的事件 schema 里叫 reply_to。 */
  reply_to?: string
  /** 飞书原始事件里叫 parent_id；两个名字都兼容。 */
  parent_id?: string
  thread_id?: string
  mentions?: { id?: string; name?: string; key?: string }[]
}

export type FeishuDrop =
  | 'missing-id'
  | 'chat:not-monitored'
  | 'dm:disabled'
  | 'sender:self'
  | 'mention:required'
  | 'system-message'
  | 'card-message'
  | 'empty-content'

/** 只有附件、没有可执行文字的消息类型。lark-cli 会把正文预渲染成占位文本。 */
export const MEDIA_MESSAGE_TYPES = new Set(['image', 'file', 'audio', 'media', 'video', 'sticker'])

export interface NormalizedEvent {
  trigger?: Trigger
  /** 被丢弃时的原因，便于在日志里追「为什么没反应」。 */
  dropped?: FeishuDrop
  chatId?: string
  actorId?: string
  addressed?: 'mention' | 'direct' | 'none'
}

/** 判断「未 @ 机器人的消息是否放行」时能拿到的上下文。 */
export interface UnaddressedContext {
  /** 消息所在群。 */
  chatId: string
  /** 发送者 open_id。 */
  actorId: string
  /** 消息携带的线程标识：话题 ID / 根消息 ID / 消息自身 ID。 */
  threadKeys: string[]
}

/**
 * 未寻址消息的放行判定；返回 true 表示这条没 @ 机器人的消息也要继续处理。
 *
 * 归一化阶段是纯函数，拿不到工单与白名单，只能由装配层（同时持有 store 与 policy）
 * 注入这个只读判定：已绑定工单的话题内，名单内成员不 @ 也要触发回复（tk-59）。
 */
export type UnaddressedAdmission = (ctx: UnaddressedContext) => boolean

/** 归一化并返回丢弃原因；正常路径用 normalizeFeishuEvent。 */
export function normalizeFeishuEventDetailed(raw: Record<string, unknown>, cfg: FeishuConfig, chatName = '', allowUnaddressed?: UnaddressedAdmission): NormalizedEvent {
  const event = raw as FeishuEvent
  const messageId = event.message_id ?? event.id
  const chatId = event.chat_id
  if (!messageId || !chatId) return { dropped: 'missing-id' }

  const isP2p = event.chat_type === 'p2p'
  const chat = cfg.chats.find(item => item.chat === chatId)
  const monitored = isP2p ? cfg.directMessages : Boolean(chat)
  if (!monitored) return { dropped: isP2p ? 'dm:disabled' : 'chat:not-monitored', ...(chatId ? { chatId } : {}) }

  const senderId = event.sender_id ?? ''
  const senderIsBot = event.sender_type === 'bot'
  // 机器人自己的消息永远丢弃，否则会自激。
  if (senderIsBot && cfg.botOpenIds.includes(senderId)) return { dropped: 'sender:self', chatId }

  const messageType = String(event.message_type ?? 'text')
  // 系统消息（建群 / 拉人 / 改群名）不是需求。
  if (messageType === 'system') return { dropped: 'system-message', chatId }
  // 互动卡片的 content 是原始卡片 JSON（lark-cli 唯一不预渲染的类型），不能当需求读。
  if (messageType === 'interactive') return { dropped: 'card-message', chatId }
  const mediaOnly = MEDIA_MESSAGE_TYPES.has(messageType)

  // 线程归属：话题 ID 最稳定，用来把同一话题的消息收敛到一条线程。
  // 实测飞书在话题面板里直接发言时 root_id / parent_id 都为空，只剩 thread_id；
  // 只认 root_id 会把同一话题的消息拆成独立线程，导致订阅扇出丢失（见 tk-56 的「合并」）。
  // 放在 @ 判断之前算：未寻址消息放行时也要拿线程标识去查「这个话题绑没绑工单」。
  const topicId = String(event.thread_id ?? '')
  const rootId = event.root_id ?? ''
  // 规范线程 ID 的尾段必须是 om_ 消息 ID：飞书 `+messages-reply --message-id` 只接受 om_，
  // 话题 ID（omt_）只参与归属匹配，不能写进规范 ID，否则回复会打不出去。
  const threadKey = rootId || messageId
  // 线程标识全集：话题 ID / 根消息 ID / 消息自身 ID，任一到场都能落回同一条线程。
  const threadKeys = uniqueKeys(topicId, rootId, messageId)

  // 只接收 @ 的群里，未 @ 的消息不进入领域。
  const mentionIds = (event.mentions ?? []).map(m => m.id ?? '').filter(Boolean)
  const mentionNames = (event.mentions ?? []).map(m => m.name ?? '').filter(Boolean)
  const mentionedBot = mentionIds.some(id => cfg.botOpenIds.includes(id)) || mentionNames.some(name => cfg.botNames.includes(name))
  // 未 @ 机器人的消息是否放行：已绑定工单的话题内，名单内成员不 @ 也要触发回复（tk-59）。
  // 放行结果记在 Trigger 上，后续的表情（shouldAcknowledge）与回执（agent-loop）都靠它判断。
  let unaddressedAdmitted = false
  if (!isP2p && chat?.mode === 'mention' && !mentionedBot) {
    unaddressedAdmitted = allowUnaddressed?.({ chatId, actorId: senderId, threadKeys }) ?? false
    if (!unaddressedAdmitted) return { dropped: 'mention:required', chatId, actorId: senderId }
  }

  const text = (event.content ?? '').trim()
  if (!text && !mediaOnly) return { dropped: 'empty-content', chatId, actorId: senderId }

  // 被引用消息：lark-cli 用 reply_to，飞书原始事件用 parent_id。正文不在 content 里，必须回查。
  const replyTo = event.reply_to || event.parent_id || ''
  // 话题内直接发言时，飞书会把 reply_to / parent_id 自动填成话题根消息（root_id），
  // 这不是用户主动引用。若拿它回查，每条话题回复都会被拼上根消息正文（tk-51 的
  // 「合并」被显示成「[引用 …] 移除 AICoding 页面…」）。只有 reply_to 与 root_id
  // 不同，才是真正的引用；没有话题 ID 的普通群引用不受此影响。
  const quotedId = topicId && rootId && replyTo === rootId ? '' : replyTo
  const imageKeys = mediaOnly || messageType === 'post' ? parseImageKeysFromContent(text) : []
  const rawMeta: Record<string, unknown> = {}
  if (quotedId) rawMeta.parentId = quotedId
  // 话题根消息被飞书当成 reply_to：记下来便于排查「为什么没显示引用」。
  else if (replyTo) rawMeta.quoteIgnored = replyTo
  if (messageType !== 'text') rawMeta.messageType = messageType
  if (imageKeys.length > 0) rawMeta.imageKeys = imageKeys
  const trigger: Trigger = {
    id: `feishu_${messageId}`,
    source: 'feishu',
    externalId: messageId,
    threadId: `feishu:${chatId}:${threadKey}`,
    threadKeys,
    chatId,
    chatName,
    actorId: senderId,
    actorName: cfg.actorNames?.get(senderId) ?? '',
    isBot: senderIsBot,
    text: text || '[附件]',
    addressed: isP2p ? 'direct' : mentionedBot ? 'mention' : 'none',
    ...(unaddressedAdmitted ? { unaddressedAdmitted: true } : {}),
    mediaOnly,
    receivedAt: toIso(event.create_time),
    disposition: 'pending',
    // 记住被引用消息的 ID：正文要靠 lark-cli 回查，见 attachQuotedMessage。
    // 图片消息同时记下 image_key，入库前由 attachImageText 下载并转文本。
    raw: rawMeta,
  }
  return { trigger, chatId, actorId: trigger.actorId, addressed: trigger.addressed }
}

/** 把一条飞书事件翻译成领域 Trigger；不在监听范围内的消息返回 null。 */
export function normalizeFeishuEvent(raw: Record<string, unknown>, cfg: FeishuConfig, chatName = '', allowUnaddressed?: UnaddressedAdmission): Trigger | null {
  return normalizeFeishuEventDetailed(raw, cfg, chatName, allowUnaddressed).trigger ?? null
}

function toIso(ms?: string): string {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return new Date().toISOString()
  return new Date(value).toISOString()
}

/** 去掉空串与重复项的线程标识列表；顺序即优先级。 */
function uniqueKeys(...values: string[]): string[] {
  const seen = new Set<string>()
  const keys: string[] = []
  for (const value of values) {
    const key = value.trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    keys.push(key)
  }
  return keys
}

/** 被引用消息的正文。飞书事件只带 parent_id，正文必须回查。 */
export interface QuotedMessage {
  id: string
  text: string
  author: string
  /** 被引用消息里的图片资源；正文为空但只有图时也要能带出去。 */
  images: { key: string }[]
}

/** 单条消息回查命令（`+messages-mget` 支持批量，这里只查一条）。 */
export function quotedMessageCommand(messageId: string, as = 'bot'): string[] {
  return ['im', '+messages-mget', '--message-ids', messageId, '--as', as, '--format', 'json']
}

/** 从 `+messages-mget` 的输出里取第一条消息的正文与发送者。 */
export function parseQuotedMessage(stdout: string, fallbackId = ''): QuotedMessage | null {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return null
  }
  const root = json as Record<string, any>
  const list = root?.data?.messages ?? root?.messages
  const message = Array.isArray(list) ? (list[0] as Record<string, any> | undefined) : undefined
  if (!message) return null
  const text = extractMessageText(message)
  const images = parseImageKeysFromContent(String(message.content ?? '')).map(key => ({ key }))
  if (!text && images.length === 0) return null
  return {
    id: String(message.message_id ?? fallbackId),
    text,
    author: String(message.sender?.name ?? ''),
    images,
  }
}

/**
 * 从 `+messages-mget` 的输出里取每条消息的话题 ID（`thread_id`，前缀 omt_）。
 * 用于给存量线程回填别名：老线程用根消息 ID 当线程 ID，需要补上话题 ID 才能命中话题内直发的消息。
 */
export function parseMessageThreadIds(stdout: string): Map<string, string> {
  const result = new Map<string, string>()
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return result
  }
  const root = json as Record<string, any>
  const list = root?.data?.messages ?? root?.messages
  if (!Array.isArray(list)) return result
  for (const item of list as Record<string, any>[]) {
    const id = String(item?.message_id ?? '')
    const threadId = String(item?.thread_id ?? '')
    if (id && threadId) result.set(id, threadId)
  }
  return result
}

/** text / post 两种消息取正文；其余类型（图片、文件等）没有可读文本。 */
function extractMessageText(message: Record<string, any>): string {
  const type = String(message.msg_type ?? 'text')
  const content = String(message.content ?? '')
  let text = ''
  if (type === 'text') text = content
  else if (type === 'post') text = postText(content)
  if (!text) return ''
  // 富文本里的 @ 是占位 key（如 @_user_1），按 mentions 还原成名字。
  for (const mention of message.mentions ?? []) {
    const key = String(mention.key ?? '')
    if (key) text = text.split(key).join(`@${mention.name ?? ''}`)
  }
  return text.trim()
}

function postText(content: string): string {
  try {
    const parts: string[] = []
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk)
        return
      }
      if (node && typeof node === 'object') {
        const obj = node as Record<string, unknown>
        if (typeof obj.text === 'string') parts.push(obj.text)
        for (const [key, value] of Object.entries(obj)) if (key !== 'text') walk(value)
      }
    }
    walk(JSON.parse(content))
    return parts.join('')
  } catch {
    return ''
  }
}

const QUOTED_MAX_CHARS = 800

/**
 * 把被引用消息的正文拼到 trigger 文本前面。
 *
 * 飞书的 `im.message.receive_v1` 只在 content 里放用户新输入的文字，引用内容只给 parent_id。
 * 不回查的话，「引用某条消息 + @机器人」在模型眼里就是一条空的 @。
 * 回查失败不阻塞主流程，按原消息继续。
 */
export async function attachQuotedMessage(
  trigger: Trigger,
  runner: CommandRunner,
  opts: { as?: string; maxChars?: number; logger?: Logger } = {},
): Promise<Trigger> {
  const logger = opts.logger ?? noopLogger
  const parentId = readParentId(trigger.raw)
  if (!parentId) return trigger
  try {
    const res = await runner.run(quotedMessageCommand(parentId, opts.as ?? 'bot'))
    if (res.code !== 0) {
      logger.warn('feishu:quote-fetch-failed', { messageId: parentId, code: res.code, message: res.stderr.slice(0, 200) })
      return trigger
    }
    const quoted = parseQuotedMessage(res.stdout, parentId)
    if (!quoted) {
      logger.warn('feishu:quote-parse-failed', { messageId: parentId, sample: res.stdout.slice(0, 200) })
      return trigger
    }
    const max = opts.maxChars ?? QUOTED_MAX_CHARS
    const body = quoted.text.length > max ? `${quoted.text.slice(0, max)}…` : quoted.text
    const who = quoted.author ? ` ${quoted.author}` : ''
    // 引用的是一条只有图片的消息时没有正文，先记下资源，入库前由 attachImageText 下载转文本。
    const header = body ? `[引用${who}的消息] ${body}` : ''
    const text = [header, trigger.text.trim()].filter(Boolean).join('\n\n')
    const quoteImages = quoted.images.map(image => ({ key: image.key, messageId: parentId }))
    return {
      ...trigger,
      text: text || trigger.text,
      raw: {
        ...(trigger.raw as Record<string, unknown>),
        ...(body ? { quote: quoted } : {}),
        ...(quoteImages.length > 0 ? { quoteImages } : {}),
      },
    }
  } catch (error) {
    logger.warn('feishu:quote-fetch-failed', { messageId: parentId, message: errorMessage(error) })
    return trigger
  }
}

function readParentId(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return ''
  const value = (raw as Record<string, unknown>).parentId
  return typeof value === 'string' ? value : ''
}

export interface FeishuConsumerOptions {
  bin?: string
  /** 传给 lark-cli 子进程的环境（独立配置目录靠 HOME 隔离）。 */
  env?: NodeJS.ProcessEnv
  as?: 'bot' | 'user'
  onEvent: (raw: Record<string, unknown>) => void
  onError?: (error: Error) => void
  onLine?: (line: string) => void
  /** lark-cli 报告事件流就绪。 */
  onReady?: () => void
  /** 消费进程断开后安排重连；用于把「正在重试」也写进日志。 */
  onReconnect?: (info: { attempt: number; delayMs: number }) => void
  /** 消费进程异常退出后自动重连的退避基线（默认 5s，翻倍至 60s）。 */
  restartBaseMs?: number
  /** 测试注入点。 */
  spawnImpl?: (bin: string, args: string[], opts: { stdio: ['pipe', 'pipe', 'pipe']; env?: NodeJS.ProcessEnv }) => ChildProcess
}

/** lark-cli 把例行信息写在 stderr 上，需要区分「就绪」与「真错误」。 */
export function larkStderrLevel(line: string): 'ready' | 'error' | 'ignore' {
  if (/ready event_key|listening for events/i.test(line)) return 'ready'
  if (/\b(error|failed|denied|unauthorized|invalid|refused)\b/i.test(line)) return 'error'
  // lark-cli 的错误常以多行 JSON 输出，按结构化字段再判一次。
  if (/"ok"\s*:\s*false|failed_precondition|another event bus|already connected/i.test(line)) return 'error'
  return 'ignore'
}

/** 常驻消费飞书消息事件（NDJSON 一行一条）。 */
export class FeishuConsumer {
  private proc: ChildProcess | null = null
  private stopping = false
  private restarts = 0
  private restartTimer: NodeJS.Timeout | null = null
  private opts: FeishuConsumerOptions

  constructor(opts: FeishuConsumerOptions) {
    this.opts = opts
  }

  start(): void {
    if (this.proc) return
    this.stopping = false
    const bin = this.opts.bin ?? 'lark-cli'
    const spawnFn = this.opts.spawnImpl ?? spawn
    // 关键：lark-cli 把 stdin EOF 当作退出信号，stdin 必须是保持打开的管道。
    const child = spawnFn(bin, ['event', 'consume', 'im.message.receive_v1', '--as', this.opts.as ?? 'bot'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(this.opts.env ? { env: this.opts.env } : {}),
    })
    this.proc = child
    child.stdin?.on('error', () => { /* 关闭时的 EPIPE 忽略 */ })
    const rl = createInterface({ input: child.stdout! })
    rl.on('line', line => {
      const trimmed = line.trim()
      if (!trimmed) return
      this.opts.onLine?.(trimmed)
      try {
        this.opts.onEvent(JSON.parse(trimmed) as Record<string, unknown>)
      } catch {
        this.opts.onError?.(new Error(`feishu:invalid-json: ${trimmed.slice(0, 200)}`))
      }
    })
    child.stderr?.on('data', chunk => {
      const text = String(chunk).trim()
      if (!text) return
      const level = larkStderrLevel(text)
      if (level === 'ready') {
        this.restarts = 0
        this.opts.onReady?.()
      } else if (level === 'error') {
        this.opts.onError?.(new Error(`feishu:stderr: ${text.slice(0, 300)}`))
      }
    })
    child.on('error', error => {
      // spawn 失败（例如 lark-cli 没装）不会触发 exit，必须单独处理，否则进程会直接抛错退出。
      if (this.proc === child) this.proc = null
      this.opts.onError?.(new Error(`feishu:spawn-failed: ${error.message}`))
      this.scheduleRestart()
    })
    child.on('exit', code => {
      // 只清理「当前这条」子进程，避免旧进程的迟到事件把新连接置空。
      if (this.proc === child) this.proc = null
      if (this.stopping) return
      if (code !== 0) this.opts.onError?.(new Error(`feishu:consumer-exit: ${code}`))
      this.scheduleRestart()
    })
  }

  /** 事件总线冲突等失败通常是临时的，按指数退避重连。 */
  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return
    this.restarts += 1
    const delay = Math.min((this.opts.restartBaseMs ?? 5000) * 2 ** (this.restarts - 1), 60_000)
    this.opts.onReconnect?.({ attempt: this.restarts, delayMs: delay })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.stopping) this.start()
    }, delay)
    this.restartTimer.unref?.()
  }

  stop(): void {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    try { this.proc?.stdin?.end() } catch { /* ignore */ }
    this.proc?.kill('SIGTERM')
    this.proc = null
  }

  get running(): boolean {
    return this.proc !== null
  }
}

export function feishuReplyCommand(messageId: string, text: string, idempotencyKey: string): string[] {
  return ['im', '+messages-reply', '--message-id', messageId, `--text=${text}`, '--reply-in-thread', '--idempotency-key', idempotencyKey, '--as', 'bot', '--json']
}

/** 给一条消息加确认表情（飞书 emoji_type，如 OK / THUMBSUP / OnIt）。 */
export function feishuReactionCommand(messageId: string, emojiType: string): string[] {
  return [
    'im', 'reactions', 'create',
    '--message-id', messageId,
    '--data', JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
    '--as', 'bot',
    '--json',
  ]
}

/** 撤销自己加的表情。 */
export function feishuUnreactCommand(messageId: string, reactionId: string): string[] {
  return ['im', 'reactions', 'delete', '--message-id', messageId, '--reaction-id', reactionId, '--as', 'bot', '--json']
}

/** 从 reactions create 的返回里取 reaction_id。 */
export function parseReactionId(stdout: string): string {
  try {
    const doc = JSON.parse(stdout) as Record<string, any>
    return String(doc?.data?.reaction_id ?? doc?.data?.reactionId ?? '')
  } catch {
    return ''
  }
}

export function feishuSendCommand(chatId: string, text: string, idempotencyKey: string): string[] {
  return ['im', '+messages-send', '--chat-id', chatId, `--text=${text}`, '--idempotency-key', idempotencyKey, '--as', 'bot', '--json']
}

/** 单行且没有 Markdown 语法的短回复，直接用纯文本发送，不必为了几个字开卡片。 */
const SIMPLE_MESSAGE_MAX = 200

/** 需要 Markdown 渲染的行内语法。 */
const INLINE_MARKDOWN = [
  /`[^`\n]+`/, // 行内代码
  /\*\*[^*\n]+\*\*/, // 加粗
  /~~[^~\n]+~~/, // 删除线
  /!\[[^\]\n]*\]\([^)\n]+\)/, // 图片
  /\[[^\]\n]+\]\([^)\n]+\)/, // 文字链接
  /<\/?[a-zA-Z][^>\n]*>/, // HTML / 飞书卡片标签
]

/** 需要 Markdown 渲染的块级语法（按行判断）。 */
const BLOCK_MARKDOWN = [
  /^\s{0,3}#{1,6}\s+/, // 标题
  /^\s{0,3}[-*+]\s+/, // 无序列表 / 任务列表
  /^\s{0,3}\d+[.)]\s+/, // 有序列表
  /^\s{0,3}>\s?/, // 引用
  /^\s*```/, // 代码块
  /^\s*\|.*\|\s*$/, // 表格行
]

/**
 * 简单消息 = 单行、长度可控、完全不含 Markdown。
 * 这类内容走 text 消息渲染最稳，也避免卡片加载与宽度差异。
 */
export function shouldSendAsText(text: string, maxLength = SIMPLE_MESSAGE_MAX): boolean {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > maxLength) return false
  if (trimmed.includes('\n')) return false
  return !INLINE_MARKDOWN.some(pattern => pattern.test(trimmed)) && !BLOCK_MARKDOWN.some(pattern => pattern.test(trimmed))
}

/**
 * 卡片 markdown 元素（Card 1.0）只支持基础语法：不带标题、引用、表格的渲染，
 * 这里把不支持的写法降级为卡片能正常显示的形式，避免用户看到 Markdown 源码。
 */
export function normalizeCardMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n')
  const out: string[] = []
  let fence: string | null = null

  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index]!
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]![0]!
      else if (fenceMatch[1]![0] === fence) fence = null
      out.push(line)
      continue
    }
    if (fence !== null) {
      out.push(line)
      continue
    }

    // 换行标签与图片语法在卡片里都不成立：<br> 转真换行，图片转可点击链接。
    line = line.replace(/<br\s*\/?>/gi, '\n')
    line = line.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_match, alt: string, url: string) =>
      alt.trim() ? `[${alt.trim()}](${url})` : `[图片](${url})`)

    // 表格：1.0 卡片不渲染表格，降级为「加粗表头 + 列表行」。
    if (isTableRow(line) && index + 1 < lines.length && isTableDivider(lines[index + 1]!)) {
      const header = parseTableCells(line)
      index += 1
      const rows: string[][] = []
      while (index + 1 < lines.length && isTableRow(lines[index + 1]!)) {
        index += 1
        rows.push(parseTableCells(lines[index]!))
      }
      out.push(header.map(cell => `**${cell}**`).join(' · '))
      for (const row of rows) out.push(`- ${row.join(' · ')}`)
      continue
    }

    // 标题：卡片不渲染 #，统一降级成加粗行。
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      out.push(`**${heading[1]}**`)
      continue
    }

    // 引用：卡片不渲染 >，用竖线前缀保留引用观感。
    const quote = /^\s{0,3}(?:>\s?)+(.*)$/.exec(line)
    if (quote) {
      out.push(`▍${quote[1]}`)
      continue
    }

    // 任务列表：卡片不支持 [ ] / [x]，换成勾选框字符。
    const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line)
    if (task) {
      out.push(`${task[1]}- ${task[2] === ' ' ? '☐' : '☑'} ${task[3]}`)
      continue
    }

    out.push(line)
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line)
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line)
}

function parseTableCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return inner.split('|').map(cell => cell.trim())
}

/** 把 Markdown 包成互动卡片：正文用 card markdown 元素渲染，不再是源码。 */
export function feishuCard(markdown: string): string {
  const content = normalizeCardMarkdown(markdown) || markdown.trim()
  return JSON.stringify({
    config: { wide_screen_mode: true },
    elements: [{ tag: 'markdown', content }],
  })
}

/**
 * lark-cli 的 `im +messages-send` / `+messages-reply` 不支持从 stdin 读正文：
 * `--content` 只接受 JSON 字符串，`--markdown` 只接受 markdown 文本。
 * 正文必须直接落在参数值上，且用 `--flag=value` 形式，避免以 `-` 开头的正文被当成 flag。
 */
export function feishuCardSendCommand(chatId: string, cardJson: string, idempotencyKey: string): string[] {
  return ['im', '+messages-send', '--chat-id', chatId, '--msg-type', 'interactive', `--content=${cardJson}`, '--idempotency-key', idempotencyKey, '--as', 'bot', '--json']
}

export function feishuCardReplyCommand(messageId: string, cardJson: string, idempotencyKey: string): string[] {
  return ['im', '+messages-reply', '--message-id', messageId, '--msg-type', 'interactive', `--content=${cardJson}`, '--reply-in-thread', '--idempotency-key', idempotencyKey, '--as', 'bot', '--json']
}

/** 卡片不可用时的降级：飞书 post 富文本，仍比纯文本更接近 Markdown 观感。 */
export function feishuMarkdownSendCommand(chatId: string, markdown: string, idempotencyKey: string): string[] {
  return ['im', '+messages-send', '--chat-id', chatId, `--markdown=${markdown}`, '--idempotency-key', idempotencyKey, '--as', 'bot', '--json']
}

export function feishuMarkdownReplyCommand(messageId: string, markdown: string, idempotencyKey: string): string[] {
  return ['im', '+messages-reply', '--message-id', messageId, `--markdown=${markdown}`, '--reply-in-thread', '--idempotency-key', idempotencyKey, '--as', 'bot', '--json']
}

/** 用 Markdown 创建一篇飞书文档；正文走 stdin，避免超长参数与转义问题。 */
export function feishuCreateDocCommand(title: string): string[] {
  return ['docs', '+create', `--title=${title}`, '--content', '-', '--doc-format', 'markdown', '--as', 'bot']
}

/** 从 `docs +create` 的 JSON 返回里取文档链接。 */
export function parseDocumentUrl(stdout: string): string {
  try {
    const doc = JSON.parse(stdout) as Record<string, any>
    return String(doc?.data?.document?.url ?? doc?.document?.url ?? doc?.data?.url ?? doc?.url ?? '')
  } catch {
    return ''
  }
}

/**
 * 飞书 --idempotency-key 上限 50 字符。超长时保留前缀并追加稳定哈希，
 * 既保证同一 key 仍然幂等，又不会因为长度被服务端拒绝。
 */
export function fitIdempotencyKey(key: string, max = 50): string {
  const clean = key.replace(/[^a-zA-Z0-9:_-]/g, '_')
  if (clean.length <= max) return clean
  let hash = 0
  for (let i = 0; i < clean.length; i += 1) hash = (hash * 31 + clean.charCodeAt(i)) | 0
  const suffix = (hash >>> 0).toString(36)
  return `${clean.slice(0, max - suffix.length - 1)}_${suffix}`
}

/** 通过 lark-cli 发消息；幂等 key 由 Outbox 提供。 */
export class FeishuSender {
  constructor(private runner: CommandRunner, private logger: Logger = noopLogger) {}

  async reply(messageId: string, text: string, idempotencyKey: string): Promise<void> {
    const res = await this.runner.run(feishuReplyCommand(messageId, text, fitIdempotencyKey(idempotencyKey)))
    if (res.code !== 0) throw new Error(`feishu:send-failed: ${res.stderr.slice(0, 300)}`)
  }

  async send(chatId: string, text: string, idempotencyKey: string): Promise<void> {
    const res = await this.runner.run(feishuSendCommand(chatId, text, fitIdempotencyKey(idempotencyKey)))
    if (res.code !== 0) throw new Error(`feishu:send-failed: ${res.stderr.slice(0, 300)}`)
  }

  /** 以互动卡片发送 Markdown；卡片失败时自动降级为 post 富文本。 */
  async sendCard(chatId: string, markdown: string, idempotencyKey: string): Promise<void> {
    const key = fitIdempotencyKey(idempotencyKey)
    const res = await this.runner.run(feishuCardSendCommand(chatId, feishuCard(markdown), key))
    if (res.code === 0) return
    this.logger.warn('feishu:card-fallback', {
      target: chatId,
      key,
      code: res.code,
      message: res.stderr.slice(0, 200),
    })
    const fallback = await this.runner.run(feishuMarkdownSendCommand(chatId, markdown, key))
    if (fallback.code !== 0) throw new Error(`feishu:card-send-failed: ${fallback.stderr.slice(0, 300)}`)
  }

  async replyCard(messageId: string, markdown: string, idempotencyKey: string): Promise<void> {
    const key = fitIdempotencyKey(idempotencyKey)
    const res = await this.runner.run(feishuCardReplyCommand(messageId, feishuCard(markdown), key))
    if (res.code === 0) return
    this.logger.warn('feishu:card-fallback', {
      target: messageId,
      key,
      code: res.code,
      message: res.stderr.slice(0, 200),
    })
    const fallback = await this.runner.run(feishuMarkdownReplyCommand(messageId, markdown, key))
    if (fallback.code !== 0) throw new Error(`feishu:card-reply-failed: ${fallback.stderr.slice(0, 300)}`)
  }

  /** 创建飞书文档并返回链接；失败时抛错，由调用方降级为长消息回复。 */
  async createDocument(title: string, markdown: string): Promise<string> {
    const res = await this.runner.run(feishuCreateDocCommand(title), { input: markdown, timeoutMs: 60_000 })
    if (res.code !== 0) throw new Error(`feishu:doc-create-failed: ${res.stderr.slice(0, 300)}`)
    const url = parseDocumentUrl(res.stdout)
    if (!url) throw new Error(`feishu:doc-url-missing: ${res.stdout.slice(0, 200)}`)
    return url
  }

  /** 收到消息后立即加一个确认表情，返回 reaction_id；失败抛出。 */
  async react(messageId: string, emojiType: string): Promise<string | null> {
    if (!emojiType) return null
    const res = await this.runner.run(feishuReactionCommand(messageId, emojiType))
    if (res.code !== 0) throw new Error(`feishu:react-failed: ${res.stderr.slice(0, 300)}`)
    return parseReactionId(res.stdout)
  }

  /** 撤销之前加的表情。 */
  async unreact(messageId: string, reactionId: string): Promise<void> {
    if (!reactionId) return
    const res = await this.runner.run(feishuUnreactCommand(messageId, reactionId))
    if (res.code !== 0) throw new Error(`feishu:unreact-failed: ${res.stderr.slice(0, 300)}`)
  }
}
