import type { Store } from '../store/db.js'
import type { PersistedSessionRecord, SessionPersistence, SessionResetRecord } from './session-registry.js'

/**
 * SQLite 版会话持久化：只存「哪个会话用哪个文件」，文件内容由 Pi 自己写。
 * get() 只返回 active 记录，/new 之后旧记录自然不再被打开。
 */
export class SqliteSessionPersistence implements SessionPersistence {
  constructor(private readonly store: Store) {}

  get(sessionKey: string): PersistedSessionRecord | null {
    const record = this.store.getChatSession(sessionKey)
    if (!record || record.status !== 'active') return null
    return {
      sessionKey: record.sessionKey,
      chatId: record.chatId,
      actorId: record.actorId,
      threadId: record.threadId,
      sessionFile: record.sessionFile,
      sessionId: record.sessionId,
    }
  }

  save(record: PersistedSessionRecord): void {
    const now = new Date().toISOString()
    this.store.upsertChatSession({
      sessionKey: record.sessionKey,
      chatId: record.chatId,
      actorId: record.actorId,
      threadId: record.threadId,
      sessionFile: record.sessionFile,
      sessionId: record.sessionId,
      soulVersion: '',
      policyVersion: '',
      createdAt: now,
      lastUsedAt: now,
      status: 'active',
      resetAt: null,
      resetBy: null,
      purgedAt: null,
    })
  }

  markSuperseded(sessionKey: string, at: string, by: string): void {
    this.store.markChatSessionSuperseded(sessionKey, at, by)
  }

  touch(sessionKey: string, at: string): void {
    this.store.touchChatSession(sessionKey, at)
  }

  insertReset(reset: SessionResetRecord): void {
    this.store.insertChatSessionReset({
      id: `${reset.sessionKey}:${reset.createdAt}`,
      ...reset,
    })
  }
}
