import { existsSync } from 'node:fs'

/** 一个会话的稳定标识：群/话题 + 人。 */
export interface SessionKeyParts {
  /** `chat:<chatId>:user:<actorId>` 或 `chat:<chatId>:thread:<threadId>:user:<actorId>`。 */
  key: string
  chatId: string
  actorId: string
  threadId: string
}

/** 落盘 session 的元数据；由 Store 实现，测试可注入内存实现。 */
export interface PersistedSessionRecord {
  sessionKey: string
  chatId: string
  actorId: string
  threadId: string
  sessionFile: string
  sessionId: string
}

/** 会话持久化端口：只做元数据读写，不碰文件内容。 */
export interface SessionPersistence {
  /** 只返回当前 active 的记录；superseded / purged 视为没有。 */
  get(sessionKey: string): PersistedSessionRecord | null
  save(record: PersistedSessionRecord): void
  markSuperseded(sessionKey: string, at: string, by: string): void
  touch?(sessionKey: string, at: string): void
  /** /new 的审计记录；新文件要等下一次 acquire 才知道，先留空。 */
  insertReset?(reset: SessionResetRecord): void
}

export interface SessionResetRecord {
  sessionKey: string
  chatId: string
  actorId: string
  oldFile: string
  newFile: string
  actorName: string
  createdAt: string
}

/**
 * Registry 只依赖 session 的这几个方法，便于测试注入假实现。
 * 真实的 Pi AgentSession 结构兼容。
 */
export interface ManagedSessionLike {
  prompt(text: string): Promise<void>
  abort(): Promise<void>
  dispose(): void
  readonly messages?: unknown
  readonly sessionManager?: {
    appendCustomMessageEntry(customType: string, content: string, display: boolean): string
  }
  setActiveToolsByName?(names: string[]): void
}

export interface CreatedSession<S extends ManagedSessionLike = ManagedSessionLike> {
  session: S
  file: string
}

export interface CreateSessionInput {
  parts: SessionKeyParts
  systemPrompt: string
}

export type SessionCreator<S extends ManagedSessionLike = ManagedSessionLike> = (input: CreateSessionInput) => Promise<CreatedSession<S>>

export interface RegisteredSession<S extends ManagedSessionLike = ManagedSessionLike> {
  parts: SessionKeyParts
  session: S
  file: string
  systemPrompt: string
  lastUsedAt: number
  /** 没有 sessionManager 时，确定性回复先攒在这里，下一轮拼进 prompt。 */
  pendingTranscripts: string[]
  /** 已经 append 到 session 文件，下一轮调用模型前需要 reopen 让内存状态同步。 */
  needsReopen: boolean
}

export interface SessionRegistryOptions<S extends ManagedSessionLike = ManagedSessionLike> {
  persistence: SessionPersistence
  create: SessionCreator<S>
  idleTtlMs: number
  maxActive: number
  now?: () => number
}

/**
 * 按会话持有 Pi session：
 * - 首次 acquire 创建（或打开已有文件）；
 * - 后续复用同一个 session 对象；
 * - 空闲 / 超上限只回收内存，文件与持久化记录保留；
 * - /new 只把当前记录标记 superseded，下一条消息自然新建文件。
 *
 * 这里不调用模型，也不解析 session 内容，所有模型相关逻辑留在 PiDecisionEngine。
 */
export class SessionRegistry<S extends ManagedSessionLike = ManagedSessionLike> {
  private readonly sessions = new Map<string, RegisteredSession<S>>()
  private readonly persistence: SessionPersistence
  private readonly create: SessionCreator<S>
  private readonly idleTtlMs: number
  private readonly maxActive: number
  private readonly now: () => number

  constructor(opts: SessionRegistryOptions<S>) {
    this.persistence = opts.persistence
    this.create = opts.create
    this.idleTtlMs = opts.idleTtlMs
    this.maxActive = Math.max(1, opts.maxActive)
    this.now = opts.now ?? (() => Date.now())
  }

  size(): number {
    return this.sessions.size
  }

  get(key: string): RegisteredSession<S> | undefined {
    return this.sessions.get(key)
  }

  async acquire(parts: SessionKeyParts, systemPrompt: string): Promise<RegisteredSession<S>> {
    let entry = this.sessions.get(parts.key)
    if (entry) {
      if (entry.systemPrompt !== systemPrompt) await this.rebuild(entry, systemPrompt)
      this.touch(entry)
      return entry
    }

    await this.evictIdle()
    while (this.sessions.size >= this.maxActive) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
      if (!oldest) break
      this.drop(oldest.parts.key)
    }

    const created = await this.create({ parts, systemPrompt })
    entry = {
      parts,
      session: created.session,
      file: created.file,
      systemPrompt,
      lastUsedAt: this.now(),
      pendingTranscripts: [],
      needsReopen: false,
    }
    this.sessions.set(parts.key, entry)
    this.persistence.save({
      sessionKey: parts.key,
      chatId: parts.chatId,
      actorId: parts.actorId,
      threadId: parts.threadId,
      sessionFile: created.file,
      sessionId: sessionIdOf(created.session) ?? '',
    })
    return entry
  }

  /**
   * 确定性回复（小寒暄、附件提示、关闭话题提示等）写进 session。
   * 有 sessionManager 时直接 append 到文件，下一轮 reopen；没有时攒在内存里拼 prompt。
   */
  async recordTranscript(parts: SessionKeyParts, text: string, systemPrompt: string): Promise<RegisteredSession<S>> {
    const entry = await this.acquire(parts, systemPrompt)
    const manager = entry.session.sessionManager
    if (manager?.appendCustomMessageEntry) {
      manager.appendCustomMessageEntry('router.transcript', text, false)
      // 新 session 还没有真实对话时，Pi 不会落盘文件；这份 transcript 先随下一轮 prompt 带进去。
      if (existsSync(entry.file)) entry.needsReopen = true
      else entry.pendingTranscripts.push(text)
    } else {
      entry.pendingTranscripts.push(text)
    }
    this.touch(entry)
    return entry
  }

  /** 下一轮调用模型前把文件里的 custom_message 加载回内存。 */
  async prepare(entry: RegisteredSession<S>): Promise<void> {
    if (entry.needsReopen) {
      await this.rebuild(entry, entry.systemPrompt)
      entry.needsReopen = false
    }
  }

  /** prompt 前的兜底文本：只用于没有 sessionManager 的实现；成功后再由调用方清空。 */
  pendingPrompt(entry: RegisteredSession<S>): string {
    if (entry.pendingTranscripts.length === 0) return ''
    const lines = entry.pendingTranscripts.map(line => `- ${line.replace(/\s+/g, ' ').trim()}`).join('\n')
    return `[自上一轮之后，会话里还有这些往来（你未参与）]\n${lines}\n[当前消息]`
  }

  /** 一轮成功结束后清掉已带进上下文的 transcript。 */
  clearPendingTranscripts(entry: RegisteredSession<S>): void {
    entry.pendingTranscripts = []
  }

  /** /new：只影响这一个 session；旧记录标记 superseded，文件保留给清理任务。 */
  async reset(parts: SessionKeyParts, by: string): Promise<void> {
    const record = this.persistence.get(parts.key)
    const at = new Date(this.now()).toISOString()
    if (record) {
      this.persistence.insertReset?.({
        sessionKey: parts.key,
        chatId: parts.chatId,
        actorId: parts.actorId,
        oldFile: record.sessionFile,
        newFile: '',
        actorName: by,
        createdAt: at,
      })
    }
    this.drop(parts.key)
    this.persistence.markSuperseded(parts.key, at, by)
  }

  async evictIdle(now = this.now()): Promise<number> {
    let evicted = 0
    for (const [key, entry] of this.sessions) {
      if (now - entry.lastUsedAt <= this.idleTtlMs) continue
      this.drop(key)
      evicted += 1
    }
    return evicted
  }

  /** 超时 / 预算超限：丢掉内存 session，让下一轮从文件恢复。 */
  drop(key: string): void {
    const entry = this.sessions.get(key)
    if (!entry) return
    try {
      entry.session.dispose()
    } catch {
      // dispose 失败不影响内存回收。
    }
    this.sessions.delete(key)
  }

  async disposeAll(): Promise<void> {
    for (const [key] of this.sessions) this.drop(key)
  }

  private async rebuild(entry: RegisteredSession<S>, systemPrompt: string): Promise<void> {
    try {
      entry.session.dispose()
    } catch {
      // 旧 session 可能已经不可用；继续用文件重建。
    }
    const created = await this.create({ parts: entry.parts, systemPrompt })
    entry.session = created.session
    entry.file = created.file
    entry.systemPrompt = systemPrompt
  }

  private touch(entry: RegisteredSession<S>): void {
    entry.lastUsedAt = this.now()
    this.persistence.touch?.(entry.parts.key, new Date(entry.lastUsedAt).toISOString())
  }
}

/** 从 Pi session 上尽可能取到 session id；测试假实现可能没有。 */
function sessionIdOf(session: ManagedSessionLike): string | undefined {
  const manager = session.sessionManager as { getSessionId?: () => string } | undefined
  return typeof manager?.getSessionId === 'function' ? manager.getSessionId() : undefined
}
