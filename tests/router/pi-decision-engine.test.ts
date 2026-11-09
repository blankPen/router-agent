import { describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { DEFAULT_ADMISSION, type Policy } from '../../src/core/policy.js'
import type { Trigger } from '../../src/core/model.js'
import type { PiModelConfig } from '../../src/router/model-config.js'
import { RouterToolbox } from '../../src/router/tools.js'
import {
  PiDecisionEngine,
  type PiSessionEvent,
  type PiSessionLike,
  type PiSessionOptions,
} from '../../src/router/pi-decision-engine.js'

const policy: Policy = {
  version: 'p1',
  acceptMode: 'auto',
  maxWorkers: 4,
  allowed: ['ou_alice'],
  bots: [],
  admission: DEFAULT_ADMISSION,
  receiveAll: true,
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
    text: '登录总是 10 秒就超时，帮我改成 30 秒',
    addressed: 'mention',
    receivedAt: '2026-11-06T10:00:00.000Z',
    disposition: 'pending',
    ...over,
  }
}

function request(over: Partial<Trigger> = {}, canMutate = true) {
  return {
    trigger: trigger(over),
    strength: 'explicit' as const,
    systemPrompt: 'SYSTEM PROMPT',
    userPrompt: '{"trigger":{"id":"t1"}}',
    canMutate,
  }
}

class FakeSession implements PiSessionLike {
  messages: unknown[] = []
  promptText = ''
  aborted = false
  disposed = false
  private listeners: Array<(event: PiSessionEvent) => void> = []
  private release: (error?: Error) => void = () => {}
  private readonly deferred = new Promise<void>((resolve, reject) => {
    this.release = error => (error ? reject(error) : resolve())
  })

  constructor(
    readonly opts: PiSessionOptions,
    private readonly behavior: (session: FakeSession) => Promise<void> | void,
  ) {}

  subscribe(listener: (event: PiSessionEvent) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(item => item !== listener)
    }
  }

  emit(event: PiSessionEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  async prompt(text: string): Promise<void> {
    this.promptText = text
    await this.behavior(this)
    await this.deferred
  }

  async abort(): Promise<void> {
    this.aborted = true
    this.release(new Error('aborted'))
  }

  finish(): void {
    this.release()
  }

  dispose(): void {
    this.disposed = true
  }
}

function setup(
  behavior: (session: FakeSession) => Promise<void> | void,
  over: { timeoutMs?: number; tokenBudget?: number } = {},
) {
  const store = new Store(':memory:')
  const engine = new Engine({ store, policy })
  const toolbox = new RouterToolbox({ store, engine })
  engine.ingest(trigger())
  const state: { captured: PiSessionOptions | null; session: FakeSession | null } = { captured: null, session: null }
  const enginePi = new PiDecisionEngine({
    model,
    toolbox,
    agentDir: '/tmp/ra-pi-test',
    timeoutMs: over.timeoutMs ?? 2_000,
    tokenBudget: over.tokenBudget ?? 1_000,
    sessionFactory: async opts => {
      state.captured = opts
      state.session = new FakeSession(opts, behavior)
      return state.session
    },
  })
  return { store, engine, toolbox, enginePi, state }
}

describe('PiDecisionEngine', () => {
  it('放行读 / 查 / 清理 / 决定四类 router_* 工具，并把 Router 的 system prompt 注入 Pi', async () => {
    const { enginePi, state } = setup(session => session.finish())
    await enginePi.assess(request())

    const expected = [
      'router_decide',
      'router_read',
      'router_ticket',
      'router_ticket_close',
      'router_ticket_list',
      'router_ticket_progress',
      'router_workspace_remove',
    ]
    expect(state.captured?.toolNames.sort()).toEqual(expected)
    expect(state.captured?.tools.map(tool => tool.name).sort()).toEqual(expected)
    expect(state.captured?.systemPrompt).toBe('SYSTEM PROMPT')
    expect(state.captured?.tools.some(tool => /bash|edit|write|shell/i.test(tool.name))).toBe(false)
  })

  it('router_decide 只记录 proposal，不写库', async () => {
    const { store, enginePi, state } = setup(async s => {
      const decide = s.opts.tools.find(tool => tool.name === 'router_decide')!
      const outcome = await decide.execute('call-1', {
        trigger_id: 't1',
        decision: 'accept',
        reason: '可执行',
        title: '改登录超时',
        scope: '只改超时',
        repo: 'router-agent',
        branch: 'main',
      })
      expect(outcome.content[0]?.text).toContain('accepted')
      s.emit({ type: 'message_end', message: { role: 'assistant', usage: { input: 10, output: 5, totalTokens: 15 } } })
      s.finish()
    })

    const result = await enginePi.assess(request())

    expect(result.proposal?.decision).toBe('accept')
    expect(result.proposal?.title).toBe('改登录超时')
    expect(result.audit.toolCalls).toEqual([{ name: 'router_decide', args: expect.any(String), ok: true }])
    expect(result.audit.tokens).toEqual({ input: 10, output: 5, total: 15 })
    expect(store.listTickets()).toHaveLength(0)
    expect(state.session?.promptText).toBe('{"trigger":{"id":"t1"}}')
  })

  it('router_ticket_close 通过 Engine 关单，并把最终答复作为 result.reply 返回', async () => {
    const { store, engine, enginePi } = setup(async s => {
      const close = s.opts.tools.find(tool => tool.name === 'router_ticket_close')!
      const outcome = await close.execute('call-1', { ticket_id: 'tk-1', reason: '用户要求关闭' })
      expect(outcome.content[0]?.text).toContain('closed')
      s.messages = [{ role: 'assistant', content: '已关闭工单 tk-1，workspace 正在回收。' }]
      s.emit({ type: 'message_end', message: { role: 'assistant', usage: { input: 10, output: 5, totalTokens: 15 } } })
      s.finish()
    })
    engine.decide({ triggerId: 't1', decision: 'accept', strength: 'explicit', reason: 'ok', title: '调整登录超时' })

    const result = await enginePi.assess(request())

    expect(result.proposal?.decision).toBe('ignore')
    expect(result.proposal?.reason).toBe('ops:tool-reply')
    expect(result.reply).toBe('已关闭工单 tk-1，workspace 正在回收。')
    expect(store.getTicket('tk-1')?.stage).toBe('done')
    expect(result.audit.toolCalls).toEqual([{ name: 'router_ticket_close', args: expect.any(String), ok: true }])
  })

  it('推断消息（未 @ / 未私聊）里的写工具被拒绝，不产生副作用', async () => {
    const { store, engine, enginePi } = setup(async s => {
      const close = s.opts.tools.find(tool => tool.name === 'router_ticket_close')!
      const outcome = await close.execute('call-1', { ticket_id: 'tk-1', reason: '顺手清理' })
      expect(outcome.content[0]?.text).toContain('permission:not-authorized')
      s.messages = [{ role: 'assistant', content: '这张工单需要你明确 @ 我才能关闭。' }]
      s.finish()
    })
    engine.decide({ triggerId: 't1', decision: 'accept', strength: 'explicit', reason: 'ok', title: '调整登录超时' })

    const result = await enginePi.assess(request({ addressed: 'none' }, false))

    expect(store.getTicket('tk-1')?.stage).not.toBe('done')
    expect(result.audit.toolCalls).toEqual([
      { name: 'router_ticket_close', args: expect.any(String), ok: false, error: 'permission:not-authorized' },
    ])
    expect(result.reply).toBe('这张工单需要你明确 @ 我才能关闭。')
  })

  it('超时：abort 当前 session，按 pi:timeout 降级为 unavailable', async () => {
    const { enginePi, state } = setup(() => {
      // 永不完成，等待超时触发 abort。
    }, { timeoutMs: 30 })

    const result = await enginePi.assess(request())

    expect(result.proposal).toBeUndefined()
    expect(result.unavailableReason).toContain('pi:timeout')
    expect(state.session?.aborted).toBe(true)
    expect(state.session?.disposed).toBe(true)
  })

  it('token 预算超限：主动 abort 并按 pi:token-budget 降级', async () => {
    const { enginePi, state } = setup(s => {
      s.emit({ type: 'message_end', message: { role: 'assistant', usage: { input: 800, output: 400, totalTokens: 1_200 } } })
    })
    const result = await enginePi.assess(request())
    expect(result.proposal).toBeUndefined()
    expect(result.unavailableReason).toContain('pi:token-budget')
    expect(state.session?.aborted).toBe(true)
  })

  it('Pi 没调用工具时，从最后一条 assistant 文本里兜底解析 JSON', async () => {
    const { enginePi } = setup(s => {
      s.messages = [{ role: 'assistant', content: '```json\n{"decision":"ignore","reason":"闲聊"}\n```' }]
      s.finish()
    })
    const result = await enginePi.assess(request())
    expect(result.proposal?.decision).toBe('ignore')
    expect(result.proposal?.reason).toBe('闲聊')
  })

  it('没有产出决定时按 pi:no-decision 返回，并保证 dispose', async () => {
    const { enginePi, state } = setup(s => {
      s.messages = []
      s.finish()
    })
    const result = await enginePi.assess(request())
    expect(result.proposal).toBeUndefined()
    expect(result.unavailableReason).toBe('pi:no-decision')
    expect(state.session?.disposed).toBe(true)
  })

  it('reply 走同一个 Pi 通道但不开放任何工具', async () => {
    const { enginePi, state } = setup(s => {
      s.messages = [{ role: 'assistant', content: '收到～需要我改哪块？' }]
      s.finish()
    })
    const text = await enginePi.reply({ systemPrompt: 'CONV SYSTEM', userPrompt: '{"message":"在吗"}' })
    expect(text).toBe('收到～需要我改哪块？')
    expect(state.captured?.toolNames).toEqual([])
    expect(state.captured?.tools).toEqual([])
    expect(state.captured?.systemPrompt).toBe('CONV SYSTEM')
    expect(state.session?.promptText).toBe('{"message":"在吗"}')
  })

  it('reply 超时 / 空回复会抛错，由 AgentLoop 退回固定话术', async () => {
    const timed = setup(() => {}, { timeoutMs: 30 })
    await expect(timed.enginePi.reply({ systemPrompt: 'S', userPrompt: 'U' })).rejects.toThrow('pi:timeout')

    const empty = setup(s => s.finish())
    await expect(empty.enginePi.reply({ systemPrompt: 'S', userPrompt: 'U' })).rejects.toThrow('pi:empty-reply')
  })
})