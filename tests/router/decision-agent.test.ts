import { describe, expect, it, vi } from 'vitest'
import type { Trigger } from '#core/model.js'
import type { DecisionAnswers } from '#core/decision.js'
import type { Logger } from '#infra/logger.js'
import {
  DecisionAgent,
  JevDecisionProvider,
  LlmDecisionProvider,
  type DecisionAudit,
  type DecisionProvider,
  type DecisionProviderContext,
} from '../../src/router/decision/agent.js'
import type { IntakeEngine, IntakeRunRequest } from '../../src/router/intake-engine.js'

function trigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'trg_1',
    source: 'feishu',
    externalId: 'ext_1',
    threadId: 'th_1',
    chatId: 'chat_1',
    chatName: '群一',
    actorId: 'ou_1',
    actorName: '张三',
    isBot: false,
    text: '登录一直失败，麻烦看看',
    addressed: 'none',
    receivedAt: '2026-01-01T00:00:00.000Z',
    disposition: 'pending',
    ...overrides,
  }
}

class StubProvider implements DecisionProvider {
  name = 'stub'
  calls: DecisionProviderContext[] = []
  constructor(private responder: (ctx: DecisionProviderContext) => DecisionAnswers | Error) {}
  async ask(ctx: DecisionProviderContext): Promise<DecisionAnswers> {
    this.calls.push(ctx)
    const result = this.responder(ctx)
    if (result instanceof Error) throw result
    return result
  }
}

function recordingLogger(): { logger: Logger; events: Array<{ level: string; message: string; extra?: Record<string, unknown> }> } {
  const events: Array<{ level: string; message: string; extra?: Record<string, unknown> }> = []
  return {
    logger: {
      info: (message, extra) => events.push({ level: 'info', message, extra }),
      warn: (message, extra) => events.push({ level: 'warn', message, extra }),
      error: (message, extra) => events.push({ level: 'error', message, extra }),
    },
    events,
  }
}

describe('DecisionAgent.decide', () => {
  it('disabled_agent_bypasses_without_calling_provider', async () => {
    const provider = new StubProvider(() => ({ needsFollowup: 0.9, kindScore: 0.8, urgency: 0.7 }))
    const agent = new DecisionAgent({ provider, enabled: false, isAdmin: () => false })
    const outcome = await agent.decide(trigger())
    expect(outcome).toMatchObject({ kind: 'bypassed', rule: 'disabled' })
    expect(provider.calls).toHaveLength(0)
  })

  it('bot_messages_are_dropped_without_provider_call', async () => {
    const provider = new StubProvider(() => ({ needsFollowup: 0.9, kindScore: 0.8, urgency: 0.7 }))
    const agent = new DecisionAgent({ provider, isAdmin: () => false })
    const outcome = await agent.decide(trigger({ isBot: true }))
    expect(outcome).toMatchObject({ kind: 'dropped', rule: 'bot' })
    expect(provider.calls).toHaveLength(0)
  })

  it('admin_messages_bypass_to_router', async () => {
    const provider = new StubProvider(() => ({ needsFollowup: 0.9, kindScore: 0.8, urgency: 0.7 }))
    const agent = new DecisionAgent({ provider, isAdmin: trig => trig.actorId === 'ou_admin' })
    const outcome = await agent.decide(trigger({ actorId: 'ou_admin' }))
    expect(outcome).toMatchObject({ kind: 'bypassed', rule: 'identity-split' })
    expect(provider.calls).toHaveLength(0)
  })

  it('small_talk_is_dropped_as_noise_without_provider_call', async () => {
    const provider = new StubProvider(() => ({ needsFollowup: 0.9, kindScore: 0.8, urgency: 0.7 }))
    const agent = new DecisionAgent({ provider, isAdmin: () => false })
    const outcome = await agent.decide(trigger({ text: '你好' }))
    expect(outcome).toMatchObject({ kind: 'dropped', rule: 'noise' })
    expect(provider.calls).toHaveLength(0)
  })

  it('member_request_returns_verdict_from_provider_answers', async () => {
    const provider = new StubProvider(() => ({ needsFollowup: 0.9, kindScore: 0.85, urgency: 0.7 }))
    const { logger, events } = recordingLogger()
    const audits: DecisionAudit[] = []
    const agent = new DecisionAgent({ provider, isAdmin: () => false, logger, onAudit: audit => audits.push(audit), now: () => 1000 })
    const outcome = await agent.decide(trigger())
    expect(outcome.kind).toBe('verdict')
    if (outcome.kind === 'verdict') {
      expect(outcome.verdict.action).toBe('analysis')
      expect(outcome.verdict.kind).toBe('issue')
      expect(outcome.verdict.toolScope).toBe('member-analysis-read')
      expect(outcome.verdict.specId).toBe('msg.user.v1')
    }
    expect(provider.calls).toHaveLength(1)
    expect(events).toContainEqual(expect.objectContaining({ level: 'info', message: 'decision:verdict', extra: expect.objectContaining({ triggerId: 'trg_1' }) }))
    expect(audits[0]).toMatchObject({ triggerId: 'trg_1', provider: 'stub', outcome: 'verdict' })
  })

  it('provider_failure_degrades_to_conservative_analysis_and_logs_warn', async () => {
    const provider = new StubProvider(() => new Error('jev:http-500'))
    const { logger, events } = recordingLogger()
    const agent = new DecisionAgent({ provider, isAdmin: () => false, logger, now: () => 1000 })
    const outcome = await agent.decide(trigger())
    expect(outcome.kind).toBe('verdict')
    if (outcome.kind === 'verdict') {
      expect(outcome.verdict.action).toBe('analysis')
      expect(outcome.verdict.degraded).toBe(true)
      expect(outcome.verdict.confidence).toBe(0)
    }
    const warn = events.find(event => event.message === 'decision:failed')
    expect(warn).toMatchObject({ level: 'warn', extra: expect.objectContaining({ triggerId: 'trg_1', provider: 'stub' }) })
    expect(String(warn?.extra?.detail)).toContain('jev:http-500')
  })

  it('invalid_answers_degrades_to_conservative_analysis', async () => {
    const provider = new StubProvider(() => ({ needsFollowup: 1.5, kindScore: 0.8, urgency: 0.7 }) as unknown as DecisionAnswers)
    const agent = new DecisionAgent({ provider, isAdmin: () => false })
    const outcome = await agent.decide(trigger())
    expect(outcome.kind).toBe('verdict')
    if (outcome.kind === 'verdict') expect(outcome.verdict.degraded).toBe(true)
  })
})

describe('JevDecisionProvider', () => {
  it('maps_spec_questions_to_jev_and_back_to_answers', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      answers: { needs_followup: { noul: 0.9 }, kind: { score: 2 }, urgency: { noul: 0.6 } },
    }), { status: 200 }))
    const provider = new JevDecisionProvider({ apiKey: 'k', model: 'm' }, { fetch: fetchMock as unknown as typeof fetch })
    const answers = await provider.ask({ trigger: trigger(), admission: { outcome: 'pass', rule: 'pass', reason: 'pass:to-decision' } })
    expect(answers).toEqual({ needsFollowup: 0.9, kindScore: 1, urgency: 0.6 })
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body.questions.kind.criteria).toEqual(['闲聊吐槽', '咨询问题', '需求反馈'])
  })
})

describe('LlmDecisionProvider', () => {
  class FakeLlm implements IntakeEngine {
    replies: string[]
    constructor(replies: string[]) { this.replies = replies }
    async run(_req: IntakeRunRequest): Promise<string> {
      return this.replies.shift() ?? '{}'
    }
  }

  it('parses_decision_json_into_answers', async () => {
    const provider = new LlmDecisionProvider(new FakeLlm([JSON.stringify({ needs_followup: 0.8, kind_score: 0.9, urgency: 0.5 })]))
    const answers = await provider.ask({ trigger: trigger(), admission: { outcome: 'pass', rule: 'pass', reason: 'pass:to-decision' } })
    expect(answers).toEqual({ needsFollowup: 0.8, kindScore: 0.9, urgency: 0.5 })
  })

  it('throws_when_llm_output_is_not_decision_json', async () => {
    const provider = new LlmDecisionProvider(new FakeLlm(['不是 JSON']))
    await expect(provider.ask({ trigger: trigger(), admission: { outcome: 'pass', rule: 'pass', reason: 'pass:to-decision' } })).rejects.toThrow(/decision:llm-invalid/)
  })
})
