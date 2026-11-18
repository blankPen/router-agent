import { describe, expect, it } from 'vitest'
import { EventDecisionService, ruleDecisionPort, type EventDecisionInput, type EventDecisionPort } from '../../src/events/decision.js'
import { createJevDecisionPort, stateOf } from '../../src/events/decision-model.js'
import { compileRuleTemplate } from '../../src/events/rules.js'
import { EVENT_SKILLS } from '../../src/events/skills.js'
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
    skills: EVENT_SKILLS,
    decision: { provider: 'rule', prompt: '', confidenceThreshold: 0.6, fallback: 'review' },
    prompt: '',
    promptVersion: 1,
    ...over,
  }
}

describe('事件决策', () => {
  it('规则先判：订阅不带优先级，规则只给中性档位，类型取事件自己的', async () => {
    const service = new EventDecisionService({
      decision: { provider: 'rule', prompt: '', confidenceThreshold: 0.6, fallback: 'review' },
      rule: ruleDecisionPort,
    })
    const result = await service.decide(inputOf())
    expect(result.verdict.priority).toBe('P3')
    expect(result.verdict.eventType).toBe('github.issues.opened')
    expect(result.basis).toBe('rule')
  })

  it('模型给的事件类型不覆盖来源前缀', async () => {
    // 模型只该在来源类型之外补充分类，不该把「来自哪个来源」的信息抹掉。
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => ({ project: 'router-agent', priority: 'P1', confidence: 0.9, eventType: 'bug' }),
    }
    const service = new EventDecisionService({
      decision: { provider: 'llm', prompt: '', confidenceThreshold: 0.6, fallback: 'review' },
      rule: ruleDecisionPort,
      model,
    })
    const result = await service.decide(inputOf({
      event: eventOf({ eventType: 'github.issues.opened' }),
    }))
    expect(result.verdict.eventType).toBe('github.bug')
  })

  it('命中风险标签的事件直接转人工并提到 P0', async () => {
    const service = new EventDecisionService({
      decision: { provider: 'rule', prompt: '', confidenceThreshold: 0.6, fallback: 'review' },
      rule: ruleDecisionPort,
    })
    const result = await service.decide(inputOf({
      event: eventOf({ raw: { labels: [{ name: 'security' }] } }),
      source: { enabled: true, kind: 'github', repo: 'blankPen/router-agent' },
    }))
    expect(result.verdict.priority).toBe('P0')
    expect(result.verdict.needsReview).toBe(true)
  })

  it('风险标签的强制人审不能被模型覆盖成自动执行', async () => {
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => ({ project: 'router-agent', priority: 'P1', confidence: 0.95, needsReview: false, reason: '模型觉得可以直接做' }),
    }
    const service = new EventDecisionService({
      decision: { provider: 'llm', prompt: '', confidenceThreshold: 0.6, fallback: 'review' },
      rule: ruleDecisionPort,
      model,
    })
    const result = await service.decide(inputOf({
      event: eventOf({ raw: { labels: [{ name: 'security' }] } }),
      source: { enabled: true, kind: 'github', repo: 'blankPen/router-agent' },
    }))
    expect(result.verdict.needsReview).toBe(true)
  })

  it('模型不能把规则强制的 P0 降级', async () => {
    // 降级等于绕过低峰窗口的闸门：那个窗口只放行 P2/P3，P0 掉下来就会被顺延。
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => ({ project: 'router-agent', priority: 'P3', confidence: 0.95, needsReview: false }),
    }
    const service = new EventDecisionService({
      decision: { provider: 'llm', prompt: '', confidenceThreshold: 0.6, fallback: 'review' },
      rule: ruleDecisionPort,
      model,
    })
    const result = await service.decide(inputOf({
      event: eventOf({ raw: { labels: [{ name: 'security' }] } }),
      source: { enabled: true, kind: 'github', repo: 'blankPen/router-agent' },
    }))
    expect(result.verdict.priority).toBe('P0')
  })

  it('模型能把规则要求的人审改回自动执行（规则没要求人审时）', async () => {
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => ({ project: 'router-agent', priority: 'P1', confidence: 0.9, needsReview: false }),
    }
    const service = new EventDecisionService({
      decision: { provider: 'llm', prompt: '', confidenceThreshold: 0.6, fallback: 'review' },
      rule: ruleDecisionPort,
      model,
    })
    const result = await service.decide(inputOf())
    expect(result.verdict.needsReview).toBe(false)
  })

  it('模型选的项目不在候选清单里就转人工，不凭空造项目', async () => {
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => ({ project: 'not-exist', priority: 'P1', confidence: 0.9 }),
    }
    const service = new EventDecisionService({
      decision: { provider: 'llm', prompt: '', confidenceThreshold: 0.6, fallback: 'review' },
      rule: ruleDecisionPort,
      model,
    })
    const result = await service.decide(inputOf())
    expect(result.verdict.project).toBe('')
    expect(result.verdict.needsReview).toBe(true)
    expect(result.verdict.reason).toContain('不在候选清单里')
  })

  it('置信度低于阈值时转人工', async () => {
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => ({ project: 'router-agent', priority: 'P1', confidence: 0.2 }),
    }
    const service = new EventDecisionService({
      decision: { provider: 'llm', prompt: '', confidenceThreshold: 0.6, fallback: 'review' },
      rule: ruleDecisionPort,
      model,
    })
    const result = await service.decide(inputOf())
    expect(result.verdict.needsReview).toBe(true)
    expect(result.verdict.reason).toContain('置信度')
  })

  it('模型判定成功时给出项目、skill 与仓库', async () => {
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => ({ project: 'router-agent', priority: 'P1', skill: 'bug-triage', confidence: 0.9, reason: '明确的 bug' }),
    }
    const service = new EventDecisionService({
      decision: { provider: 'llm', prompt: '', confidenceThreshold: 0.6, fallback: 'review' },
      rule: ruleDecisionPort,
      model,
    })
    const result = await service.decide(inputOf())
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
    const service = new EventDecisionService({
      decision: { provider: 'llm', prompt: '', confidenceThreshold: 0.6, fallback: 'review' },
      rule: ruleDecisionPort,
      model,
    })
    const result = await service.decide(inputOf())
    expect(result.verdict.needsReview).toBe(true)
    expect(result.verdict.reason).toContain('模型超时')
    expect(result.verdict.decided).toBe(false)
  })

  it('兜底策略是 pending 时，模型失败的事件留在队列里等下一轮', async () => {
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => { throw new Error('模型超时') },
    }
    const service = new EventDecisionService({
      decision: { provider: 'llm', prompt: '', confidenceThreshold: 0.6, fallback: 'pending' },
      rule: ruleDecisionPort,
      model,
    })
    const result = await service.decide(inputOf({
      source: { enabled: true, kind: 'github', repo: 'blankPen/router-agent' },
    }))
    expect(result.verdict.needsReview).toBe(false)
    expect(result.verdict.decided).toBe(false)
  })

  it('兜底策略是 pending 时，置信度不够的事件也留在队列里', async () => {
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => ({ project: 'router-agent', priority: 'P1', confidence: 0.2 }),
    }
    const service = new EventDecisionService({
      decision: { provider: 'llm', prompt: '', confidenceThreshold: 0.6, fallback: 'pending' },
      rule: ruleDecisionPort,
      model,
    })
    const result = await service.decide(inputOf({
      source: { enabled: true, kind: 'github', repo: 'blankPen/router-agent' },
    }))
    expect(result.verdict.needsReview).toBe(false)
  })

  it('没有归属项目时一律转人工，不受兜底策略影响', async () => {
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => ({ priority: 'P1', confidence: 0.9 }),
    }
    const service = new EventDecisionService({
      decision: { provider: 'llm', prompt: '', confidenceThreshold: 0.6, fallback: 'pending' },
      rule: ruleDecisionPort,
      model,
    })
    const result = await service.decide(inputOf())
    expect(result.verdict.needsReview).toBe(true)
    expect(result.verdict.reason).toContain('没有判定出归属项目')
  })

  it('没有模型时按订阅的仓库名归入同名项目', async () => {
    const service = new EventDecisionService({
      decision: { provider: 'rule', prompt: '', confidenceThreshold: 0.6, fallback: 'review' },
      rule: ruleDecisionPort,
    })
    const result = await service.decide(inputOf({
      source: { enabled: true, kind: 'github', repo: 'blankPen/router-agent' },
    }))
    expect(result.verdict.project).toBe('router-agent')
    expect(result.verdict.needsReview).toBe(false)
  })

  it('订阅的仓库名对不上项目时没有归属，转人工', async () => {
    const service = new EventDecisionService({
      decision: { provider: 'rule', prompt: '', confidenceThreshold: 0.6, fallback: 'review' },
      rule: ruleDecisionPort,
    })
    const result = await service.decide(inputOf({
      source: { enabled: true, kind: 'github', repo: 'someone/unknown-repo' },
    }))
    expect(result.verdict.project).toBe('')
    expect(result.verdict.needsReview).toBe(true)
  })
})

/**
 * 真实 GitHub 事件载荷里，Issue 标签在 `payload.issue.labels`，
 * 不在顶层 `issue.labels`。护栏读错位置就等于没有护栏。
 */
describe('事件决策 · 风险标签护栏', () => {
  it('标签在 payload.issue.labels 时也命中风险标签', async () => {
    const service = new EventDecisionService({
      decision: { provider: 'rule', prompt: '', confidenceThreshold: 0.6, fallback: 'review' },
      rule: ruleDecisionPort,
    })
    const result = await service.decide(inputOf({
      event: eventOf({
        raw: { type: 'IssuesEvent', payload: { issue: { number: 12, labels: [{ name: 'security' }] } } },
      }),
      source: { enabled: true, kind: 'github', repo: 'blankPen/router-agent' },
    }))
    expect(result.verdict.priority).toBe('P0')
    expect(result.verdict.needsReview).toBe(true)
    expect(result.verdict.reason).toContain('风险标签')
  })
})

describe('事件决策 · 规则化', () => {
  it('阈值来自规则而不是全局默认', async () => {
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => ({ project: 'router-agent', priority: 'P1', confidence: 0.45 }),
    }
    const rule = compileRuleTemplate({
      id: 'rule-issue',
      eventType: 'github.issues.opened',
      thresholds: { isValid: 0.4 },
    })
    const service = new EventDecisionService({
      decision: { provider: 'llm', prompt: '', confidenceThreshold: 0.6, fallback: 'review' },
      rule: ruleDecisionPort,
      model,
    })
    const result = await service.decide(inputOf({ rule }))
    expect(result.verdict.needsReview).toBe(false)
  })

  it('判定 state 带事件类型、链接与来源 context', () => {
    const rule = compileRuleTemplate({ id: 'rule-issue', eventType: 'github.issues.opened' })
    const input = inputOf({
      rule,
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
    expect(state.rule.intent).toBe('')
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
    const rule = compileRuleTemplate({ id: 'rule-issue', eventType: 'github.issues.opened' })
    const port = createJevDecisionPort(new JevClient(
      { apiKey: 'k', model: 'm' },
      { fetch: fetchMock as unknown as typeof fetch },
    ))
    await port.decide(inputOf({ rule, projects }))
    expect(Object.keys(questions).sort()).toEqual(['autorun', 'is_valid', 'priority', 'project', 'skill'])
    expect(questions.project).toMatchObject({
      type: 'choice',
      criteria: expect.objectContaining({ 'router-agent': expect.any(String) }),
    })
  })

  it('风险标签来自规则，未配置的默认标签不再强制人审', async () => {
    const rule = compileRuleTemplate({
      id: 'rule-issue',
      eventType: 'github.issues.opened',
      guardrails: { riskLabels: ['custom-risk'] },
    })
    const service = new EventDecisionService({
      decision: { provider: 'rule', prompt: '', confidenceThreshold: 0.6, fallback: 'review' },
      rule: ruleDecisionPort,
    })
    const security = await service.decide(inputOf({
      rule,
      event: eventOf({ raw: { labels: [{ name: 'security' }] } }),
      source: { enabled: true, kind: 'github', repo: 'blankPen/router-agent' },
    }))
    expect(security.verdict.priority).toBe('P3')
    expect(security.verdict.needsReview).toBe(false)

    const custom = await service.decide(inputOf({
      rule,
      event: eventOf({ raw: { labels: [{ name: 'custom-risk' }] } }),
      source: { enabled: true, kind: 'github', repo: 'blankPen/router-agent' },
    }))
    expect(custom.verdict.priority).toBe('P0')
    expect(custom.verdict.needsReview).toBe(true)
  })
})
