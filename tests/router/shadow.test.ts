import { describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { DEFAULT_ADMISSION, type Policy } from '../../src/core/policy.js'
import type { Trigger } from '../../src/core/model.js'
import type { LlmClient } from '../../src/router/llm.js'
import { AgentLoop } from '../../src/router/agent-loop.js'
import type { DecisionEngine, DecisionEngineKind, DecisionEngineResult, DecisionProposal } from '../../src/router/decision-engine.js'
import { RouterToolbox } from '../../src/router/tools.js'

const policy: Policy = {
  version: 'p1',
  acceptMode: 'auto',
  maxWorkers: 4,
  allowed: ['ou_alice'],
  bots: [],
  admission: DEFAULT_ADMISSION,
  receiveAll: true,
}

const llm: LlmClient = { async complete() { return { content: '', toolCalls: [] } } }

function trigger(): Trigger {
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
  }
}

function result(engine: DecisionEngineKind, proposal: Partial<DecisionProposal> | null, unavailable?: string): DecisionEngineResult {
  const audit = {
    engine,
    triggerId: 't1',
    durationMs: engine === 'custom' ? 100 : 250,
    toolCalls: [{ name: 'router_decide', args: '{}', ok: true }],
    tokens: { input: 100, output: 20, total: 120 },
    promptChars: { system: 10, user: 10 },
    ...(unavailable ? { unavailableReason: unavailable } : {}),
  }
  if (!proposal) return { unavailableReason: unavailable ?? 'none', audit }
  return {
    proposal: { triggerId: 't1', decision: 'accept', strength: 'explicit', reason: 'ok', rules: [], ...proposal },
    audit: { ...audit, proposal: { triggerId: 't1', decision: 'accept', strength: 'explicit', reason: 'ok', rules: [], ...proposal } },
  }
}

class FakeEngine implements DecisionEngine {
  calls = 0
  constructor(readonly kind: DecisionEngineKind, private readonly make: () => DecisionEngineResult | Error) {}
  async assess(): Promise<DecisionEngineResult> {
    this.calls += 1
    const value = this.make()
    if (value instanceof Error) throw value
    return value
  }
}

function setup(primary: DecisionEngine, shadow: DecisionEngine) {
  const store = new Store(':memory:')
  const engine = new Engine({ store, policy, clock: { now: () => '2026-11-06T10:00:10.000Z' } })
  engine.ingest(trigger())
  const loop = new AgentLoop({ engine, llm, clock: { now: () => '2026-11-06T10:00:10.000Z' }, decisionEngine: primary, shadowEngine: shadow })
  return { store, engine, loop }
}

describe('影子模式', () => {
  it('只应用主引擎的决定，影子记录进入 SQLite 并可统计', async () => {
    const primary = new FakeEngine('custom', () => result('custom', { title: '改超时', repo: 'r', branch: 'main' }))
    const shadow = new FakeEngine('pi', () => result('pi', { title: '改登录超时', repo: 'r', branch: 'release' }))
    const { store, loop } = setup(primary, shadow)

    const assessed = await loop.assess(trigger(), 'explicit')
    await loop.shadowIdle()

    expect(assessed.outcome).toBe('accept')
    expect(store.listTickets()).toHaveLength(1)
    expect(primary.calls).toBe(1)
    expect(shadow.calls).toBe(1)

    const comparisons = store.listShadowComparisons()
    expect(comparisons).toHaveLength(1)
    expect(comparisons[0]?.agree).toBe(false)
    expect(comparisons[0]?.diff).toEqual(['title', 'branch'])

    const stats = store.shadowStats()
    expect(stats.total).toBe(1)
    expect(stats.agreeRate).toBe(0)
    expect(stats.byDiff).toMatchObject({ title: 1, branch: 1 })
    expect(stats.avgPrimaryLatencyMs).toBe(100)
    expect(stats.avgShadowLatencyMs).toBe(250)
    expect(stats.avgShadowTokens).toBe(120)
    expect(stats.avgShadowToolCalls).toBe(1)
  })

  it('主引擎 ignore、影子 accept 时不会开单，但会记下分歧', async () => {
    const ignore: DecisionEngineResult = {
      proposal: { triggerId: 't1', decision: 'ignore', strength: 'explicit', reason: '闲聊', rules: [] },
      audit: {
        engine: 'custom',
        triggerId: 't1',
        durationMs: 50,
        toolCalls: [],
        tokens: { input: 10, output: 2, total: 12 },
        promptChars: { system: 1, user: 1 },
      },
    }
    const primary = new FakeEngine('custom', () => ignore)
    const shadow = new FakeEngine('pi', () => result('pi', { repo: 'r', branch: 'main' }))
    const { store, loop } = setup(primary, shadow)

    const assessed = await loop.assess(trigger(), 'explicit')
    await loop.shadowIdle()

    expect(assessed.outcome).toBe('ignore')
    expect(store.listTickets()).toHaveLength(0)
    const comparison = store.listShadowComparisons()[0]!
    expect(comparison.agree).toBe(false)
    expect(comparison.diff).toContain('outcome')
  })

  it('影子运行抛错时标记 unavailable，不影响主流程', async () => {
    const primary = new FakeEngine('custom', () => result('custom', { repo: 'r', branch: 'main' }))
    const shadow = new FakeEngine('pi', () => new Error('pi down'))
    const { store, loop } = setup(primary, shadow)

    const assessed = await loop.assess(trigger(), 'explicit')
    await loop.shadowIdle()

    expect(assessed.outcome).toBe('accept')
    expect(store.listTickets()).toHaveLength(1)
    const stats = store.shadowStats()
    expect(stats.shadowUnavailable).toBe(1)
    expect(stats.shadowUnavailableRate).toBe(1)
  })

  it('影子工具带 readOnly：router_subscribe 不产生订阅副作用', async () => {
    const store = new Store(':memory:')
    const engine = new Engine({ store, policy })
    engine.ingest(trigger())
    const shadows = new RouterToolbox({ engine, store, readOnly: true })
    const primary = new RouterToolbox({ engine, store })

    const skipped = await shadows.call('router_subscribe', JSON.stringify({ thread_id: trigger().threadId, ticket_id: 'tk_x', action: 'subscribe' }))
    expect(skipped.result).toEqual({ skipped: true, reason: 'shadow-engine-is-read-only' })
    expect(store.listSubscriptions(trigger().threadId)).toHaveLength(0)

    const applied = await primary.call('router_subscribe', JSON.stringify({ thread_id: trigger().threadId, ticket_id: 'tk_x', action: 'subscribe' }))
    expect(applied.result).toEqual({ subscribed: true })
  })
})