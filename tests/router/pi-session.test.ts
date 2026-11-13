import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { type Policy } from '#core/policy.js'
import type { Trigger } from '#core/model.js'
import type { PiModelConfig } from '../../src/router/model-config.js'
import { RouterToolbox } from '../../src/router/tools.js'
import {
  PiDecisionEngine,
  type PiSessionEvent,
  type PiSessionLike,
  type PiSessionOptions,
} from '../../src/router/pi-decision-engine.js'
import { SqliteSessionPersistence } from '../../src/router/session-persistence.js'
import type { SessionKeyParts } from '../../src/router/session-registry.js'

const policy: Policy = {
  version: 'p1',
  acceptMode: 'auto',
  maxWorkers: 4,
  allowed: ['ou_alice', 'ou_bob'],
  bots: [],
}

const model: PiModelConfig = { baseUrl: 'https://example.invalid/v1', apiKey: 'sk-test', model: 'test-model' }

function trigger(over: Partial<Trigger> = {}): Trigger {
  return {
    id: 't1',
    source: 'feishu',
    externalId: 'om_1',
    threadId: 'feishu:oc_dev:om_1',
    chatId: 'oc_dev',
    chatName: '研发群',
    actorId: 'ou_alice',
    actorName: 'Alice',
    isBot: false,
    text: '在吗',
    addressed: 'mention',
    receivedAt: '2026-11-06T10:00:00.000Z',
    disposition: 'pending',
    ...over,
  }
}

function session(actorId = 'ou_alice'): SessionKeyParts {
  return {
    key: `chat:oc_dev:user:${actorId}`,
    chatId: 'oc_dev',
    actorId,
    threadId: 'feishu:oc_dev:om_1',
  }
}

class FakeSession implements PiSessionLike {
  messages: unknown[] = []
  prompts: string[] = []
  activeTools: string[][] = []
  disposed = false
  readonly sessionManager: { appendCustomMessageEntry(customType: string, content: string, display: boolean): string } | undefined
  private listeners: Array<(event: PiSessionEvent) => void> = []

  constructor(readonly opts: PiSessionOptions) {
    this.sessionManager = opts.sessionManager as never
  }

  subscribe(listener: (event: PiSessionEvent) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(item => item !== listener)
    }
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text)
    const manager = this.opts.sessionManager as { appendMessage?: (message: unknown) => string } | undefined
    manager?.appendMessage?.({ role: 'user', content: text, timestamp: Date.now() })
    this.messages.push({ role: 'user', content: text })
    const decide = this.opts.tools.find(tool => tool.name === 'router_decide')
    if (decide) {
      await decide.execute('call-1', {
        trigger_id: 't1',
        decision: 'ignore',
        reason: '闲聊',
        rules: [],
      })
    }
    const assistant = {
      role: 'assistant',
      content: [{ type: 'text', text: '收到' }],
      api: 'openai-completions',
      provider: 'router-agent',
      model: 'test-model',
      usage: { input: 1, output: 1, totalTokens: 2 },
      stopReason: 'stop',
      timestamp: Date.now(),
    }
    manager?.appendMessage?.(assistant)
    this.messages.push({ role: 'assistant', content: '收到' })
  }

  async abort(): Promise<void> {}

  dispose(): void {
    this.disposed = true
  }

  setActiveToolsByName(names: string[]): void {
    this.activeTools.push([...names])
  }
}

function setup(over: { sessionTimeoutMs?: number } = {}) {
  const store = new Store(':memory:')
  const engine = new Engine({ store, policy })
  const toolbox = new RouterToolbox({ store, engine })
  engine.ingest(trigger())
  const dir = mkdtempSync(join(tmpdir(), 'ra-session-'))
  const created: FakeSession[] = []
  const persistence = new SqliteSessionPersistence(store)
  const pi = new PiDecisionEngine({
    model,
    toolbox,
    agentDir: dir,
    sessionPersistence: persistence,
    sessionDir: dir,
    sessionTimeoutMs: over.sessionTimeoutMs ?? 2_000,
    sessionFactory: async opts => {
      const fake = new FakeSession(opts)
      created.push(fake)
      return fake
    },
  })
  return { store, engine, pi, created, dir }
}

function request(over: Partial<Trigger> = {}, key = session()) {
  return {
    trigger: trigger(over),
    strength: 'explicit' as const,
    systemPrompt: 'UPDATED SYSTEM',
    userPrompt: '{"mode":"assess"}',
    canMutate: true,
    session: key,
  }
}

describe('PiDecisionEngine 会话复用', () => {
  it('同一个会话复用同一个 session；第二次不再新建', async () => {
    const { pi, created } = setup()
    const first = await pi.assess(request())
    const second = await pi.assess(request({ id: 't2' }))

    expect(first.proposal?.decision).toBe('ignore')
    expect(second.proposal?.decision).toBe('ignore')
    expect(created).toHaveLength(1)
    expect(created[0]?.prompts).toHaveLength(2)
    expect(created[0]?.disposed).toBe(false)
  })

  it('不同人各自一个 session', async () => {
    const { pi, created } = setup()
    await pi.assess(request({ actorId: 'ou_alice' }, session('ou_alice')))
    await pi.assess(request({ actorId: 'ou_bob' }, session('ou_bob')))

    expect(created).toHaveLength(2)
  })

  it('/new 后旧 session dispose，下一条新建', async () => {
    const { pi, created } = setup()
    await pi.assess(request())
    await pi.resetSession(session(), 'ou_alice')
    await pi.assess(request())

    expect(created).toHaveLength(2)
    expect(created[0]?.disposed).toBe(true)
  })

  it('reply 与 assess 共用 session，但 reply 轮关闭工具', async () => {
    const { pi, created } = setup()
    await pi.assess(request())
    const text = await pi.reply({
      systemPrompt: 'UPDATED SYSTEM',
      userPrompt: '{"mode":"reply"}',
      session: session(),
    })

    expect(text).toBe('收到')
    expect(created).toHaveLength(1)
    expect(created[0]?.activeTools.at(-1)).toEqual([])
  })

  it('新会话的确定性回复随下一轮 prompt 带进去', async () => {
    const { pi, created } = setup()
    await pi.recordTranscript(session(), '用户：你好\nRouter：在的', 'UPDATED SYSTEM')
    expect(created).toHaveLength(1)
    await pi.assess(request())

    expect(created).toHaveLength(1)
    expect(created[0]?.prompts.at(-1)).toContain('用户：你好')
  })

  it('已有历史时确定性回复写入文件，下一轮前 reopen 让模型看到', async () => {
    const { pi, created } = setup()
    await pi.assess(request())
    await pi.recordTranscript(session(), '用户：你好\nRouter：在的', 'UPDATED SYSTEM')
    expect(created).toHaveLength(1)
    await pi.assess(request({ id: 't2' }))

    expect(created).toHaveLength(2)
    const manager = created[1]?.opts.sessionManager as { buildSessionContext?: () => { messages: unknown[] } }
    expect(JSON.stringify(manager.buildSessionContext?.().messages ?? [])).toContain('用户：你好')
  })

  it('超时后丢掉 session，下一轮从文件重新创建', async () => {
    const { pi, created } = setup({ sessionTimeoutMs: 20 })
    const original = FakeSession.prototype.prompt
    FakeSession.prototype.prompt = async function () {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    try {
      const result = await pi.assess(request())
      expect(result.unavailableReason).toContain('pi:timeout')
      expect(created[0]?.disposed).toBe(true)
    } finally {
      FakeSession.prototype.prompt = original
    }
  })

  it('空闲回收只释放内存，下一条会从同一个文件恢复', async () => {
    const { pi, created } = setup()
    await pi.assess(request())
    expect(await pi.evictIdleSessions(Date.now() + 31 * 60_000)).toBe(1)
    expect(created[0]?.disposed).toBe(true)
    await pi.assess(request({ id: 't3' }))
    expect(created).toHaveLength(2)
  })
})
