import { normalizeFeishuEvent, type FeishuConfig } from './feishu.js'
import type { Trigger } from '../core/model.js'
import type { CommandRunner } from '../infra/process.js'

export interface ListCommandOptions {
  /** ISO 8601 起始时间；lark-cli 只认 `--start`。 */
  start?: string
  order?: 'asc' | 'desc'
  pageSize?: number
}

export function backfillCommand(chatId: string, start?: string, opts: ListCommandOptions = {}): string[] {
  const argv = [
    'im', '+chat-messages-list',
    '--chat-id', chatId,
    '--as', 'bot',
    '--page-size', String(opts.pageSize ?? 50),
    '--order', opts.order ?? 'asc',
    '--format', 'json',
  ]
  const startTime = start ?? opts.start
  if (startTime) argv.push('--start', startTime)
  return argv
}

interface RawMessage {
  chat_id?: string
  message_id?: string
  msg_type?: string
  content?: string
  create_time?: string
  reply_to?: string
  sender?: { id?: string; open_bot_id?: string; sender_type?: string; name?: string }
}

/** 把 `lark-cli im +chat-messages-list --format json` 的输出转成 Trigger。 */
export function parseFeishuMessageList(stdout: string, cfg: FeishuConfig): Trigger[] {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return []
  }
  const messages = extractMessages(json)
  const triggers: Trigger[] = []
  for (const message of messages) {
    const event = toEvent(message, cfg)
    if (!event) continue
    const trigger = normalizeFeishuEvent(event, cfg)
    if (trigger) triggers.push(trigger)
  }
  return triggers
}

/** 取这批消息里最新一条的时间（毫秒）；没有可用时间返回 null。 */
export function newestMessageAt(stdout: string): number | null {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return null
  }
  const times = extractMessages(json)
    .map(message => Number(toMs(message.create_time)))
    .filter(value => Number.isFinite(value) && value > 0)
  return times.length > 0 ? Math.max(...times) : null
}

function extractMessages(json: unknown): RawMessage[] {
  if (Array.isArray(json)) return json as RawMessage[]
  const root = json as Record<string, any>
  const data = root?.data ?? root
  const list = data?.messages ?? data?.items ?? []
  return Array.isArray(list) ? (list as RawMessage[]) : []
}

function toEvent(message: RawMessage, cfg: FeishuConfig): Record<string, unknown> | null {
  if (!message.message_id || !message.chat_id) return null
  const sender = message.sender ?? {}
  const senderIsBot = sender.sender_type === 'app' || sender.sender_type === 'bot'
  const senderId = sender.open_bot_id ?? sender.id ?? ''
  // 补拉按群消息处理：不在监听范围内的 chat_id 会由归一化逻辑直接丢弃。
  const chatType = 'group'

  return {
    type: 'im.message.receive_v1',
    message_id: message.message_id,
    chat_id: message.chat_id,
    chat_type: chatType,
    message_type: message.msg_type ?? 'text',
    content: message.content ?? '',
    create_time: toMs(message.create_time),
    sender_id: senderId,
    sender_type: senderIsBot ? 'bot' : 'user',
    root_id: message.reply_to,
    // 补拉时没有 mentions 结构，用文本里的 @名字 兜底识别。
    mentions: cfg.botNames
      .filter(name => (message.content ?? '').includes(`@${name}`))
      .map(name => ({ name })),
  }
}

/** 支持 "2026-11-06 09:58"（本地时区）与毫秒时间戳字符串。 */
function toMs(value?: string): string | undefined {
  if (!value) return undefined
  if (/^\d{10,}$/.test(value)) return value
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const withSeconds = /:\d\d$/.test(normalized) ? `${normalized}:00` : normalized
  const time = new Date(withSeconds).getTime()
  return Number.isFinite(time) ? String(time) : undefined
}

export interface CursorStore {
  get(key: string): string | null
  set(key: string, value: string): void
}

export interface BackfillOptions {
  runner: CommandRunner
  chats: string[]
  cfg: FeishuConfig
  cursors: CursorStore
  /** 时钟（毫秒），首次基线在空群里用。 */
  now?: () => number
  /** 时间回退窗口，避免边界消息被漏掉，默认 5s。 */
  skewMs?: number
}

export interface BackfillResult {
  triggers: Trigger[]
  /** 第一次见到、只记了基线而没有补历史的群。 */
  baselined: string[]
}

export function historyCursorKey(chatId: string): string {
  return `feishu:history:${chatId}`
}

/**
 * 按群增量补拉历史消息。
 *
 * 第一次见到某个群时只记一条基线（最新一条消息的时间），不把历史消息当新需求；
 * 之后每次从基线回退 5 秒开始增量拉取，拉到什么就推多远。
 * 单个群失败不会影响其它群，也不会推进它的游标。
 */
export async function backfillChats(opts: BackfillOptions): Promise<BackfillResult> {
  const { runner, chats, cfg } = opts
  const now = opts.now ?? Date.now
  const skewMs = opts.skewMs ?? 5000
  const triggers: Trigger[] = []
  const baselined: string[] = []

  for (const chatId of chats) {
    const key = historyCursorKey(chatId)
    const cursor = opts.cursors.get(key)
    try {
      if (!cursor) {
        // 第一次见到这个群：只取最新一条做基线，避免把整段历史重新研判一遍。
        const res = await runner.run(backfillCommand(chatId, undefined, { order: 'desc', pageSize: 1 }))
        if (res.code !== 0) continue
        opts.cursors.set(key, String(newestMessageAt(res.stdout) ?? now()))
        baselined.push(chatId)
        continue
      }

      const start = new Date(Math.max(0, Number(cursor) - skewMs)).toISOString()
      const res = await runner.run(backfillCommand(chatId, start))
      if (res.code !== 0) continue

      const parsed = parseFeishuMessageList(res.stdout, cfg)
      if (parsed.length === 0) continue
      triggers.push(...parsed)

      const newest = Math.max(...parsed.map(t => Date.parse(t.receivedAt)).filter(Number.isFinite))
      if (Number.isFinite(newest) && newest > Number(cursor)) opts.cursors.set(key, String(newest))
    } catch {
      // 单个群失败不影响其它群；游标保持原值，下一轮重试。
    }
  }

  return { triggers, baselined }
}
