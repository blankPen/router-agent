import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { CommandRunner } from '#infra/process.js'
import { noopLogger, errorMessage, type Logger } from '#infra/logger.js'

export interface ChatEntry {
  chatId: string
  name: string
}

/** 群名目录：定期从 lark-cli 拉取并缓存，用于面板与通知里的可读名称。 */
export class ChatDirectory {
  private file: string
  private logger: Logger
  private names = new Map<string, string>()

  constructor(file: string, logger: Logger = noopLogger) {
    this.file = file
    this.logger = logger
    this.load()
  }

  nameOf(chatId: string): string {
    return this.names.get(chatId) ?? ''
  }

  entries(): ChatEntry[] {
    return [...this.names.entries()].map(([chatId, name]) => ({ chatId, name }))
  }

  /** 用 lark-cli 的真实返回刷新缓存；失败保留旧值。 */
  async refresh(runner: CommandRunner): Promise<number> {
    const res = await runner.run(['im', '+chat-list', '--as', 'bot', '--format', 'json'])
    if (res.code !== 0) {
      this.logger.warn('chats:refresh-failed', { code: res.code, message: res.stderr.slice(0, 200) })
      return 0
    }
    const parsed = parseChatList(res.stdout, this.logger)
    for (const entry of parsed) this.names.set(entry.chatId, entry.name)
    this.save()
    return parsed.length
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const doc = JSON.parse(readFileSync(this.file, 'utf8')) as { chats?: ChatEntry[] }
      for (const entry of doc.chats ?? []) this.names.set(entry.chatId, entry.name)
    } catch (error) {
      // 缓存损坏时当作空，但留一条日志，避免群名一直显示为空却查不到原因。
      this.logger.warn('chats:cache-invalid', { path: this.file, message: errorMessage(error) })
    }
  }

  private save(): void {
    writeFileSync(this.file, `${JSON.stringify({ chats: this.entries() }, null, 2)}\n`, 'utf8')
  }
}

/** 兼容 `{data:{chats:[...]}}` / `{data:{items:[...]}}` / 裸数组。 */
export function parseChatList(stdout: string, logger: Logger = noopLogger): ChatEntry[] {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch (error) {
    if (stdout.trim()) logger.warn('chats:parse-failed', { message: errorMessage(error), sample: stdout.slice(0, 200) })
    return []
  }
  if (Array.isArray(json)) return normalize(json)
  const root = json as Record<string, any>
  const data = root?.data ?? root
  const list = data?.chats ?? data?.items ?? []
  return Array.isArray(list) ? normalize(list) : []
}

function normalize(list: Record<string, unknown>[]): ChatEntry[] {
  const out: ChatEntry[] = []
  for (const raw of list) {
    const chatId = String(raw.chat_id ?? raw.chatId ?? '')
    const name = String(raw.name ?? raw.chat_name ?? '')
    if (chatId) out.push({ chatId, name })
  }
  return out
}
