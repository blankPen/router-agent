import { describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { DEFAULT_ADMISSION, type Policy } from '../../src/core/policy.js'
import type { LlmClient, LlmResponse } from '../../src/router/llm.js'
import type { Trigger } from '../../src/core/model.js'
import { CustomDecisionEngine } from '../../src/router/custom-decision-engine.js'
import { RouterToolbox } from '../../src/router/tools.js'
import { compareShadow, proposalFromJson, type DecisionEngineResult, type DecisionRequest } from '../../src/router/decision-engine.js'

const policy: Policy = {
  version: 'p1',
  acceptMode: 'auto',
  maxWorkers: 4,
  allowed: ['ou_alice'],
  bots: [],
  admission: DEFAULT_ADMISSION,
  receiveAll: true,
}

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

class FakeLlm implements LlmClient {
  calls = 0
  constructor(private responses: LlmResponse[]) {}
  async complete(): Promise<LlmResponse> {
    this.calls += 1
    return this.responses.shift() ?? { content: null, toolCalls: [] }
  }
}

function setup(responses: LlmResponse[] = []) {
  const store = new Store(':memory:')
  const engine = new Engine({ store, policy, clock: { now: () => '2026-11-06T10:00:10.000Z' } })
  const toolbox = new RouterToolbox({ engine, store })
  const llm = new FakeLlm(responses)
  const decisionEngine = new CustomDecisionEngine({ llm, toolbox, maxToolRounds: 3 })
  engine.ingest(trigger())
  const request: DecisionRequest = {
    trigger: trigger(),
    strength: 'explicit',
    systemPrompt: 'SYSTEM',
    userPrompt: '{"trigger":"t1"}',
  }
  return { store, engine, toolbox, llm, decisionEngine, request }
}

describe('DecisionEngine 契约', () => {
  it('proposalFromJson 校验决定枚举，unavailable 走单独分支', () => {
    expect(proposalFromJson({ decision: 'accept', reason: 'ok', title: 't' }, 't1', 'explicit')).toEqual({
      kind: 'proposal',
      proposal: {
        triggerId: 't1',
        decision: 'accept',
        strength: 'explicit',
        reason: 'ok',
        title: 't',
        rules: [],
      },
    })
    expect(proposalFromJson({ decision: 'unavailable', reason: '模型挂了' }, 't1', 'inferred').kind).toBe('unavailable')
    expect(proposalFromJson({ decision: 'nope' }, 't1', 'inferred').kind).toBe('error')
  })

  it('compareShadow：接单 + 派工目标一致才算 agree，标题差异只进 diff', () => {
    const result = (proposal: Record<string, unknown>, engine: 'custom' | 'pi'): DecisionEngineResult => ({
      proposal: { triggerId: 't1', decision: 'accept', strength: 'explicit', reason: 'ok', rules: [], ...proposal },
      audit: { engine, triggerId: 't1', durationMs: 1, toolCalls: [], tokens: { input: 1, output: 1, total: 2 }, promptChars: { system: 1, user: 1 } },
    })
    const agree = compareShadow('t1', result({ title: 'A', repo: 'r', branch: 'main' }, 'custom'), result({ title: 'B', repo: 'r', branch: 'main' }, 'pi'), '2026-01-01T00:00:00Z', 'sc1')
    expect(agree.agree).toBe(true)
    expect(agree.diff).toEqual(['title'])

    const disagree = compareShadow('t1', result({ repo: 'r', branch: 'main' }, 'custom'), result({ repo: 'r', branch: 'release' }, 'pi'), '2026-01-01T00:00:00Z', 'sc2')
    expect(disagree.agree).toBe(false)
    expect(disagree.diff).toContain('branch')
  })
})

describe('CustomDecisionEngine', () => {
  it('router_decide 只产出 proposal，不写库（开单交给 AgentLoop）', async () => {
    const { store, decisionEngine, request } = setup([{
      content: null,
      toolCalls: [{
        id: 'c1',
        name: 'router_decide',
        arguments: JSON.stringify({ trigger_id: 't1', decision: 'accept', reason: '可执行', title: '改超时', scope: '只改超时', repo: 'router-agent', branch: 'main' }),
      }],
    }])

    const result = await decisionEngine.assess(request)

    expect(result.proposal?.decision).toBe('accept')
    expect(result.proposal?.triggerId).toBe('t1')
    expect(result.audit.toolCalls).toEqual([{ name: 'router_decide', args: expect.any(String), ok: true }])
    // 工具层没有写库：没有工单，也没有 decision 记录。
    expect(store.listTickets()).toHaveLength(0)
    expect(store.listTriggers()[0]?.decisionId).toBeUndefined()
  })

  it('工具返回的参数错误会进入审计，且不产生 proposal', async () => {
    const { decisionEngine, request } = setup([{
      content: null,
      toolCalls: [{ id: 'c1', name: 'router_decide', arguments: JSON.stringify({ decision: 'explode' }) }],
    }])
    const result = await decisionEngine.assess(request)
    expect(result.proposal).toBeUndefined()
    expect(result.audit.toolCalls[0]?.ok).toBe(false)
    // 一轮工具调用后没有决定，会继续下一轮；FakeLlm 第二轮返回空。
    expect(result.unavailableReason).toBe('模型未给出可解析的决定')
  })

  it('自由文本 JSON 兜底可解析决定，并记录 token 用量', async () => {
    const { decisionEngine, request } = setup([{
      content: '```json\n{"decision":"ignore","reason":"闲聊"}\n```',
      toolCalls: [],
      usage: { input: 10, output: 5, total: 15 },
    }])
    const result = await decisionEngine.assess(request)
    expect(result.proposal?.decision).toBe('ignore')
    expect(result.audit.tokens).toEqual({ input: 10, output: 5, total: 15 })
  })

  it('模型抛错按 unavailable 返回，不向上抛', async () => {
    const store = new Store(':memory:')
    const engine = new Engine({ store, policy })
    const toolbox = new RouterToolbox({ engine, store })
    engine.ingest(trigger())
    const boom: LlmClient = { async complete() { throw new Error('llm down') } }
    const decisionEngine = new CustomDecisionEngine({ llm: boom, toolbox })
    const result = await decisionEngine.assess({
      trigger: trigger(),
      strength: 'inferred',
      systemPrompt: 'S',
      userPrompt: 'U',
    })
    expect(result.proposal).toBeUndefined()
    expect(result.unavailableReason).toBe('llm down')
  })

  it('单次调用超时：按 custom:timeout 降级，不拖住 runCycle', async () => {
    const store = new Store(':memory:')
    const engine = new Engine({ store, policy })
    const toolbox = new RouterToolbox({ engine, store })
    engine.ingest(trigger())
    const hanging: LlmClient = { complete: () => new Promise(() => {}) }
    const decisionEngine = new CustomDecisionEngine({ llm: hanging, toolbox, timeoutMs: 30 })
    const result = await decisionEngine.assess({
      trigger: trigger(),
      strength: 'inferred',
      systemPrompt: 'S',
      userPrompt: 'U',
    })
    expect(result.unavailableReason).toContain('custom:timeout')
  })

  it('token 预算超限：按 custom:token-budget 降级', async () => {
    const { llm, toolbox, request } = setup([{
      content: JSON.stringify({ decision: 'ignore', reason: '闲聊' }),
      toolCalls: [],
      usage: { input: 80, output: 40, total: 120 },
    }])
    const budgeted = new CustomDecisionEngine({ llm, toolbox, tokenBudget: 50 })
    const result = await budgeted.assess(request)
    expect(result.unavailableReason).toContain('custom:token-budget')
  })
})