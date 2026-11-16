import { describe, expect, it } from 'vitest'
import { EventDecisionService, ruleDecisionPort, type EventDecisionInput, type EventDecisionPort } from '../../src/events/decision.js'
import { EVENT_SKILLS } from '../../src/events/skills.js'
import type { EventRecord } from '#core/event.js'

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
    eventType: 'issue',
    needsReview: false,
    updatedAt: '2026-11-13T10:00:00.000Z',
    attempts: 0,
    ...over,
  }
}

function inputOf(over: Partial<EventDecisionInput> = {}): EventDecisionInput {
  return {
    event: eventOf(),
    source: { enabled: true, kind: 'github', defaultPriority: 'P2', defaultType: 'issue' },
    projects: PROJECTS,
    skills: EVENT_SKILLS,
    decision: { provider: 'rule', prompt: '', confidenceThreshold: 0.6, fallback: 'review' },
    prompt: '',
    promptVersion: 1,
    ...over,
  }
}

describe('事件决策', () => {
  it('规则先判：来源默认优先级与类型生效，模型不参与', async () => {
    const service = new EventDecisionService({
      decision: { provider: 'rule', prompt: '', confidenceThreshold: 0.6, fallback: 'review' },
      rule: ruleDecisionPort,
    })
    const result = await service.decide(inputOf())
    expect(result.verdict.priority).toBe('P2')
    expect(result.verdict.eventType).toBe('issue')
    expect(result.basis).toBe('rule')
  })

  it('命中风险标签的事件直接转人工并提到 P0', async () => {
    const service = new EventDecisionService({
      decision: { provider: 'rule', prompt: '', confidenceThreshold: 0.6, fallback: 'review' },
      rule: ruleDecisionPort,
    })
    const result = await service.decide(inputOf({
      event: eventOf({ raw: { labels: [{ name: 'security' }] } }),
      source: { enabled: true, kind: 'github', defaultPriority: 'P3' },
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
      source: { enabled: true, kind: 'github', repo: 'blankPen/router-agent', defaultPriority: 'P3' },
    }))
    expect(result.verdict.needsReview).toBe(true)
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
      source: { enabled: true, kind: 'github', repo: 'blankPen/router-agent', defaultPriority: 'P2' },
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
      source: { enabled: true, kind: 'github', repo: 'blankPen/router-agent', defaultPriority: 'P2' },
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
      source: { enabled: true, kind: 'github', repo: 'blankPen/router-agent', defaultPriority: 'P2' },
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
      source: { enabled: true, kind: 'github', repo: 'someone/unknown-repo', defaultPriority: 'P2' },
    }))
    expect(result.verdict.project).toBe('')
    expect(result.verdict.needsReview).toBe(true)
  })
})
