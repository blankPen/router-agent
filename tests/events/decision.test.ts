import { describe, expect, it } from 'vitest'
import { EventDecisionService, type EventDecisionInput, type EventDecisionPort } from '../../src/events/decision.js'
import { createJevDecisionPort, stateOf } from '../../src/events/decision-model.js'
import { subscription } from './fixtures.js'
import type { EventDecisionConfig } from '../../src/config.js'
import type { EventRecord } from '#core/event.js'
import { JevClient } from '#infra/decision/jev-client.js'

const PROJECTS = [
  { name: 'router-agent', repo: '/Users/me/router-agent', defaultBranch: 'main' },
  { name: 'customer-service', repo: '/Users/me/customer-service', defaultBranch: 'main' },
]

function eventOf(over: Partial<EventRecord> = {}): EventRecord {
  return {
    id: 'evt_1',
    sourceId: 'github',
    sourceKind: 'github',
    externalId: 'issue:blankPen/router-agent#12',
    title: '登录偶发失败',
    body: '偶发 500',
    receivedAt: '2026-11-13T10:00:00.000Z',
    status: 'pending',
    execution: 'none',
    priority: 'P2',
    eventType: 'github.issues.opened',
    needsReview: false,
    updatedAt: '2026-11-13T10:00:00.000Z',
    attempts: 0,
    ...over,
  }
}

function inputOf(over: Partial<EventDecisionInput> = {}): EventDecisionInput {
  return {
    event: eventOf(),
    source: { enabled: true, kind: 'github' },
    projects: PROJECTS,
    decision: { provider: 'llm', confidenceThreshold: 0.6, fallback: 'review' },
    subscription: subscription(),
    ...over,
  }
}

/** 装配判定服务：模型端口可选。 */
function serviceOf(model?: EventDecisionPort, decision: EventDecisionConfig = { provider: 'llm', confidenceThreshold: 0.6, fallback: 'review' }) {
  return new EventDecisionService({
    decision,
    ...(model ? { model } : {}),
  })
}

describe('事件决策', () => {
  it('没有模型时按订阅定下的项目与处理方式给结论', async () => {
    const result = await serviceOf().decide(inputOf())
    expect(result.verdict.project).toBe('router-agent')
    expect(result.verdict.skill).toBe('bug-triage')
    expect(result.verdict.basis).toBe('subscription')
  })

  it('模型给的事件类型不覆盖来源前缀', async () => {
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => ({ project: 'router-agent', priority: 'P1', confidence: 0.9, eventType: 'bug' }),
    }
    const result = await serviceOf(model).decide(inputOf({
      event: eventOf({ eventType: 'github.issues.opened' }),
    }))
    expect(result.verdict.eventType).toBe('github.bug')
  })

  it('模型不能改写订阅定下的归属项目与处理方式', async () => {
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => ({ project: 'customer-service', skill: 'daily-digest', priority: 'P1', confidence: 0.9 }),
    }
    const result = await serviceOf(model).decide(inputOf())
    expect(result.verdict.project).toBe('router-agent')
    expect(result.verdict.skill).toBe('bug-triage')
  })

  it('模型选的项目不在候选清单里就转人工，不凭空造项目', async () => {
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => ({ project: 'not-exist', priority: 'P1', confidence: 0.9 }),
    }
    const result = await serviceOf(model).decide(inputOf({
      subscription: subscription({ project: '' }),
    }))
    expect(result.verdict.project).toBe('')
    expect(result.verdict.needsReview).toBe(true)
    expect(result.verdict.reason).toContain('不在候选清单里')
  })

  it('置信度低于阈值时转人工', async () => {
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => ({ project: 'router-agent', priority: 'P1', confidence: 0.2 }),
    }
    const result = await serviceOf(model).decide(inputOf())
    expect(result.verdict.needsReview).toBe(true)
    expect(result.verdict.reason).toContain('置信度')
  })

  it('模型判定成功时给出项目、skill 与仓库', async () => {
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => ({ project: 'router-agent', priority: 'P1', skill: 'bug-triage', confidence: 0.9, reason: '明确的 bug' }),
    }
    const result = await serviceOf(model).decide(inputOf())
    expect(result.verdict.project).toBe('router-agent')
    expect(result.verdict.repo).toBe('/Users/me/router-agent')
    expect(result.verdict.branch).toBe('main')
    expect(result.verdict.skill).toBe('bug-triage')
    expect(result.verdict.needsReview).toBe(false)
  })

  it('模型调用失败时降级为待审核，事件不丢', async () => {
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => { throw new Error('模型超时') },
    }
    const result = await serviceOf(model).decide(inputOf())
    expect(result.verdict.needsReview).toBe(true)
    expect(result.verdict.reason).toContain('模型超时')
    expect(result.verdict.decided).toBe(false)
  })

  it('兜底策略是 pending 时，模型失败的事件留在队列里等下一轮', async () => {
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => { throw new Error('模型超时') },
    }
    const result = await serviceOf(model, { provider: 'llm', confidenceThreshold: 0.6, fallback: 'pending' }).decide(inputOf())
    expect(result.verdict.needsReview).toBe(false)
    expect(result.verdict.decided).toBe(false)
  })

  it('兜底策略是 pending 时，置信度不够的事件也留在队列里', async () => {
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => ({ project: 'router-agent', priority: 'P1', confidence: 0.2 }),
    }
    const result = await serviceOf(model, { provider: 'llm', confidenceThreshold: 0.6, fallback: 'pending' }).decide(inputOf())
    expect(result.verdict.needsReview).toBe(false)
  })

  it('没有归属项目时一律转人工，不受兜底策略影响', async () => {
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => ({ priority: 'P1', confidence: 0.9 }),
    }
    const result = await serviceOf(model, { provider: 'llm', confidenceThreshold: 0.6, fallback: 'pending' }).decide(inputOf({
      subscription: subscription({ project: '', params: { repo: 'someone/unknown-repo' } }),
    }))
    expect(result.verdict.needsReview).toBe(true)
    expect(result.verdict.reason).toContain('没有判定出归属项目')
  })

  it('订阅的 mode=review 时命中即进待审核', async () => {
    const result = await serviceOf().decide(inputOf({
      subscription: subscription({ mode: 'review' }),
    }))
    expect(result.verdict.needsReview).toBe(true)
  })
})

describe('事件决策 · 判定 state', () => {
  it('判定 state 带事件类型、链接与来源 context', () => {
    const input = inputOf({
      event: eventOf({
        eventType: 'github.issues.opened',
        repo: 'blankPen/router-agent',
        branch: 'main',
        url: 'https://github.com/blankPen/router-agent/issues/1',
        context: { repo: 'blankPen/router-agent', actor: 'alice' },
      }),
    })
    const state = stateOf(input)
    expect(state.payload.type).toBe('github.issues.opened')
    expect(state.payload.url).toContain('/issues/1')
    expect(state.payload.actor).toBe('alice')
    expect(state.subscription.id).toBe('auto_test')
  })

  it('project 用 choice 后，问题数量不随项目数增长', async () => {
    let questions: Record<string, unknown> = {}
    const fetchMock = async (_url: unknown, init?: RequestInit) => {
      questions = JSON.parse(String(init?.body)).questions
      return new Response(JSON.stringify({
        answers: {
          is_valid: { noul: 0.9 },
          autorun: { choice: 'auto' },
          priority: { score: 1 },
          project: { choice: 'router-agent' },
          skill: { choice: 'bug-triage' },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const projects = Array.from({ length: 20 }, (_, index) => ({
      name: `project-${index}`,
      repo: `/r/project-${index}`,
      defaultBranch: 'main',
    }))
    projects[0] = PROJECTS[0]!
    const port = createJevDecisionPort(new JevClient(
      { apiKey: 'k', model: 'm' },
      { fetch: fetchMock as unknown as typeof fetch },
    ))
    await port.decide(inputOf({ projects }))
    expect(Object.keys(questions).sort()).toEqual(['autorun', 'is_valid', 'priority', 'project', 'skill'])
    expect(questions.project).toMatchObject({
      type: 'choice',
      criteria: expect.objectContaining({ 'router-agent': expect.any(String) }),
    })
  })

  it('订阅的语义条件进判定问题', async () => {
    let questions: Record<string, unknown> = {}
    const fetchMock = async (_url: unknown, init?: RequestInit) => {
      questions = JSON.parse(String(init?.body)).questions
      return new Response(JSON.stringify({ answers: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const port = createJevDecisionPort(new JevClient(
      { apiKey: 'k', model: 'm' },
      { fetch: fetchMock as unknown as typeof fetch },
    ))
    await port.decide(inputOf({
      subscription: subscription({ filter: { keywords: ['退款'], semantic: '是否是退款承诺' } }),
    })).catch(() => undefined)
    expect(String((questions.is_valid as { instructions: string }).instructions)).toContain('是否是退款承诺')
  })
})
