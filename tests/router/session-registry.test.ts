import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionRegistry,
  type ManagedSessionLike,
  type PersistedSessionRecord,
  type SessionKeyParts,
  type SessionPersistence,
} from '../../src/router/session-registry.js'

const parts = (actorId = 'ou_alice'): SessionKeyParts => ({
  key: `chat:oc_dev:user:${actorId}`,
  chatId: 'oc_dev',
  actorId,
  threadId: 'feishu:oc_dev:om_1',
})

class FakeSession implements ManagedSessionLike {
  disposed = false
  prompts: string[] = []
  messages: unknown[] = []
  transcripts: string[] = []
  readonly sessionManager = {
    appendCustomMessageEntry: (_type: string, content: string): string => {
      this.transcripts.push(content)
      return `cm_${this.transcripts.length}`
    },
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text)
    this.messages.push({ role: 'user', content: text }, { role: 'assistant', content: 'ok' })
  }

  async abort(): Promise<void> {}

  dispose(): void {
    this.disposed = true
  }
}

class MemoryPersistence implements SessionPersistence {
  records = new Map<string, PersistedSessionRecord>()
  superseded = new Set<string>()

  get(sessionKey: string): PersistedSessionRecord | null {
    if (this.superseded.has(sessionKey)) return null
    return this.records.get(sessionKey) ?? null
  }

  save(record: PersistedSessionRecord): void {
    this.records.set(record.sessionKey, record)
  }

  markSuperseded(sessionKey: string): void {
    this.superseded.add(sessionKey)
  }

  touch(): void {}
}

function setup(over: { idleTtlMs?: number; maxActive?: number; now?: () => number } = {}) {
  const persistence = new MemoryPersistence()
  const created: FakeSession[] = []
  const dir = mkdtempSync(join(tmpdir(), 'ra-reg-'))
  const registry = new SessionRegistry<FakeSession>({
    persistence,
    create: async input => {
      const session = new FakeSession()
      created.push(session)
      return { session, file: join(dir, `${created.length}.jsonl`) }
    },
    idleTtlMs: over.idleTtlMs ?? 30 * 60_000,
    maxActive: over.maxActive ?? 10,
    now: over.now,
  })
  return { registry, persistence, created }
}

describe('SessionRegistry', () => {
  it('同一个会话复用同一个 session，只创建一次', async () => {
    const { registry, created } = setup()
    const first = await registry.acquire(parts(), 'SYS')
    const second = await registry.acquire(parts(), 'SYS')

    expect(second.session).toBe(first.session)
    expect(created).toHaveLength(1)
    expect(registry.size()).toBe(1)
  })

  it('不同人各自一个 session，互不共享', async () => {
    const { registry, created } = setup()
    await registry.acquire(parts('ou_alice'), 'SYS')
    await registry.acquire(parts('ou_bob'), 'SYS')

    expect(created).toHaveLength(2)
    expect(registry.size()).toBe(2)
    expect(registry.get(parts('ou_alice').key)?.session).not.toBe(registry.get(parts('ou_bob').key)?.session)
  })

  it('/new 只重置目标会话：旧 session dispose，下一条新建', async () => {
    const { registry, created, persistence } = setup()
    const first = await registry.acquire(parts(), 'SYS')
    await registry.reset(parts(), 'ou_alice')

    expect((first.session as FakeSession).disposed).toBe(true)
    expect(persistence.superseded.has(parts().key)).toBe(true)
    await registry.acquire(parts(), 'SYS')
    expect(created).toHaveLength(2)
    expect(created[1]).not.toBe(first.session)
  })

  it('空闲回收只释放内存，再次 acquire 会重新创建并恢复', async () => {
    let now = 1_000
    const { registry, created } = setup({ idleTtlMs: 100, now: () => now })
    const first = await registry.acquire(parts(), 'SYS')

    now = 2_000
    expect(await registry.evictIdle()).toBe(1)
    expect((first.session as FakeSession).disposed).toBe(true)
    expect(registry.size()).toBe(0)

    const second = await registry.acquire(parts(), 'SYS')
    expect(created).toHaveLength(2)
    expect(second.session).not.toBe(first.session)
  })

  it('超过 maxActive 时按 LRU 回收内存', async () => {
    let now = 1_000
    const { registry, created } = setup({ maxActive: 2, now: () => now })
    await registry.acquire(parts('a'), 'SYS')
    now += 10
    await registry.acquire(parts('b'), 'SYS')
    now += 10
    await registry.acquire(parts('c'), 'SYS')

    expect(created).toHaveLength(3)
    expect(registry.size()).toBe(2)
    expect(registry.get(parts('a').key)).toBeUndefined()
  })

  it('确定性回复：新 session 还没有文件时随下一轮 prompt 带进去', async () => {
    const { registry, created } = setup()
    await registry.recordTranscript(parts(), '用户：你好\nRouter：在的', 'SYS')
    expect(created[0]?.transcripts).toHaveLength(1)
    const entry = registry.get(parts().key)!
    expect(entry.needsReopen).toBe(false)
    expect(entry.pendingTranscripts).toEqual(['用户：你好\nRouter：在的'])
  })

  it('确定性回复：已有文件时 append 并在下一轮 prepare 重建', async () => {
    const { registry, created } = setup()
    const first = await registry.acquire(parts(), 'SYS')
    writeFileSync(first.file, '{"type":"session"}\n')
    await registry.recordTranscript(parts(), '用户：你好\nRouter：在的', 'SYS')
    expect(created[0]?.transcripts).toHaveLength(1)
    const entry = registry.get(parts().key)!
    expect(entry.needsReopen).toBe(true)

    await registry.prepare(entry)
    expect(created).toHaveLength(2)
    expect(entry.needsReopen).toBe(false)
    expect(entry.session).toBe(created[1])
  })

  it('没有 sessionManager 时把 transcript 攒在 pendingPrompt 里', async () => {
    const persistence = new MemoryPersistence()
    const registry = new SessionRegistry<FakeSession>({
      persistence,
      create: async () => {
        const session = new FakeSession()
        Object.defineProperty(session, 'sessionManager', { value: undefined })
        return { session, file: '/tmp/x.jsonl' }
      },
      idleTtlMs: 1000,
      maxActive: 10,
    })
    await registry.recordTranscript(parts(), '用户：你好', 'SYS')
    const entry = registry.get(parts().key)!
    expect(entry.pendingTranscripts).toEqual(['用户：你好'])
    expect(registry.pendingPrompt(entry)).toContain('用户：你好')
  })

  it('system prompt 变化时用同一个文件重建，历史不丢', async () => {
    const { registry, created, persistence } = setup()
    await registry.acquire(parts(), 'SYS-1')
    const file = persistence.records.get(parts().key)?.sessionFile

    await registry.acquire(parts(), 'SYS-2')
    expect(created).toHaveLength(2)
    expect(created[0]?.disposed).toBe(true)
    expect(persistence.records.get(parts().key)?.sessionFile).toBe(file)
  })
})
