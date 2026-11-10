import { describe, expect, it } from 'vitest'
import { Store, SESSION_KEY_MIGRATION_ID } from '../../src/store/db.js'

function store(): Store {
  return new Store(':memory:')
}

function session(over: Partial<{ key: string; file: string; id: string }> = {}) {
  return {
    sessionKey: over.key ?? 'chat:oc_dev:user:ou_alice',
    chatId: 'oc_dev',
    actorId: 'ou_alice',
    threadId: '',
    sessionFile: over.file ?? '/tmp/sessions/alice.jsonl',
    sessionId: over.id ?? 'sess_1',
    soulVersion: '',
    policyVersion: '',
    createdAt: '2026-11-06T10:00:00.000Z',
    lastUsedAt: '2026-11-06T10:00:00.000Z',
    status: 'active' as const,
    resetAt: null,
    resetBy: null,
    purgedAt: null,
  }
}

describe('历史 sessionKey 迁移', () => {
  it('dry-run 统计旧格式、新格式与异常', () => {
    const db = store()
    db.upsertChatSession(session())
    db.upsertChatSession(session({ key: 'channel:feishu:chat:oc_x:user:ou_bob', file: '/tmp/b.jsonl', id: 'sess_2' }))
    db.upsertChatSession(session({ key: 'custom:oc_dev:user:ou_carol', file: '/tmp/c.jsonl', id: 'sess_3' }))
    const state = db.sessionMigrationState()
    expect(state.totalSessions).toBe(3)
    expect(state.pendingSessions).toBe(1)
    expect(state.migratedSessions).toBe(1)
    expect(state.anomalies).toHaveLength(1)
    expect(state.applied).toBe(false)
    db.close()
  })

  it('迁移只加前缀，会话文件不变，且幂等', () => {
    const db = store()
    db.upsertChatSession(session())
    const result = db.applySessionKeyMigration('2026-11-10T00:00:00.000Z')
    expect(result).toEqual({ sessions: 1, resets: 0, skipped: false })

    const migrated = db.getChatSession('channel:feishu:chat:oc_dev:user:ou_alice')
    expect(migrated?.sessionFile).toBe('/tmp/sessions/alice.jsonl')
    expect(db.hasSessionKeyMigration()).toBe(true)

    const again = db.applySessionKeyMigration('2026-11-10T00:00:01.000Z')
    expect(again.skipped).toBe(true)
    expect(again.sessions).toBe(0)
    expect(db.getChatSession('channel:feishu:chat:oc_dev:user:ou_alice')?.sessionFile).toBe('/tmp/sessions/alice.jsonl')
    db.close()
  })

  it('同步迁移重置审计表', () => {
    const db = store()
    db.insertChatSessionReset({
      id: 'chat:oc_dev:user:ou_alice:2026-11-06T10:00:00.000Z',
      sessionKey: 'chat:oc_dev:user:ou_alice',
      chatId: 'oc_dev',
      actorId: 'ou_alice',
      oldFile: '/tmp/old.jsonl',
      newFile: '/tmp/new.jsonl',
      actorName: 'Alice',
      createdAt: '2026-11-06T10:00:00.000Z',
    })
    const result = db.applySessionKeyMigration('2026-11-10T00:00:00.000Z')
    expect(result.resets).toBe(1)
    expect(db.verifySessionKeyMigration().pendingResets).toBe(0)
    db.close()
  })

  it('异常 key 不迁移，verify 不通过', () => {
    const db = store()
    db.upsertChatSession(session({ key: 'custom:oc_dev:user:ou_carol', file: '/tmp/c.jsonl' }))
    const state = db.sessionMigrationState()
    expect(state.pendingSessions).toBe(0)
    expect(state.anomalies).toHaveLength(1)
    expect(db.verifySessionKeyMigration().ok).toBe(false)
    db.close()
  })

  it('迁移记录表使用固定 ID', () => {
    const db = store()
    db.applySessionKeyMigration('2026-11-10T00:00:00.000Z')
    expect(SESSION_KEY_MIGRATION_ID).toBe('2026-11-session-key-channel')
    db.close()
  })
})