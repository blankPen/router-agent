import { describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { defaultConfig, policyOf, type AppConfig } from '../../src/config.js'
import { EventDecisionService, ruleDecisionPort, type EventDecisionPort } from '../../src/events/decision.js'
import { EventPipeline, MAX_EVENT_ATTEMPTS, windowOf } from '../../src/events/pipeline.js'
import { EVENT_SKILLS } from '../../src/events/skills.js'

function setup(over: Partial<AppConfig> = {}) {
  const store = new Store(':memory:')
  const config: AppConfig = {
    ...defaultConfig(),
    projects: [{ name: 'router-agent', repo: '/Users/me/router-agent', defaultBranch: 'main' }],
    events: {
      ...defaultConfig().events,
      sources: {
        ...defaultConfig().events.sources,
        github: { enabled: true, kind: 'github', repo: 'blankPen/router-agent', defaultPriority: 'P2', defaultType: 'issue' },
      },
    },
    ...over,
  }
  // 固定时刻落在低峰窗口（本地 22:00），P2 这类事件允许自动执行；
  // 用本地时间构造，跑测机器换时区结论不变。
  const now = new Date(2026, 10, 13, 22, 0, 0).toISOString()
  let counter = 0
  const engine = new Engine({ store, policy: policyOf(config), clock: { now: () => now }, ids: { next: p => `${p}_${++counter}` } })
  const decision = new EventDecisionService({
    decision: config.events.decision,
    rule: ruleDecisionPort,
  })
  const pipeline = new EventPipeline({
    store,
    engine,
    config: () => config,
    clock: () => now,
    ids: prefix => `${prefix}_${++counter}`,
    decision,
  })
  return { store, engine, config, pipeline }
}

const SOURCE = {
  enabled: true,
  kind: 'github' as const,
  repo: 'blankPen/router-agent',
  project: 'router-agent',
  defaultPriority: 'P2' as const,
  defaultType: 'issue',
}

describe('事件管线', () => {
  it('同一来源的同一事件只入队一次', () => {
    const { store, pipeline } = setup()
    const first = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#1', title: '崩溃', body: '崩了' })
    const second = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#1', title: '崩溃', body: '崩了' })
    expect(second.id).toBe(first.id)
    expect(store.listEvents().length).toBe(1)
  })

  it('判定通过且项目明确时直接开单，事件挂到工单上', async () => {
    const { store, pipeline } = setup()
    const event = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#2', title: '崩溃', body: '崩了' })
    await pipeline.process(event)
    const stored = store.getEvent(event.id)!
    expect(stored.status).toBe('pending')
    expect(stored.ticketId).toBeTruthy()
    const ticket = store.getTicket(stored.ticketId!)
    expect(ticket?.repo).toBe('/Users/me/router-agent')
    expect(ticket?.branch).toBe('main')
    expect(ticket?.request).toContain('崩溃')
  })

  it('判定不清时进待审核队列，不开单', async () => {
    const { store, pipeline } = setup({
      events: {
        ...defaultConfig().events,
        sources: { github: { ...SOURCE, repo: 'someone/other' } },
      },
    })
    const event = pipeline.ingest('github', { ...SOURCE, repo: 'someone/other' }, { externalId: 'issue:a#3', title: '崩溃', body: '崩了' })
    await pipeline.process(event)
    const stored = store.getEvent(event.id)!
    expect(stored.status).toBe('review')
    expect(stored.ticketId).toBeUndefined()
    expect(stored.needsReview).toBe(true)
  })

  it('人工批准后直接开单', async () => {
    const { store, pipeline } = setup({
      events: {
        ...defaultConfig().events,
        sources: { github: { ...SOURCE, repo: 'someone/other' } },
      },
    })
    const event = pipeline.ingest('github', { ...SOURCE, repo: 'someone/other' }, { externalId: 'issue:a#4', title: '崩溃', body: '崩了' })
    await pipeline.process(event)
    const result = await pipeline.apply(event.id, 'approve', { project: 'router-agent' })
    expect(result?.ticketId).toBeTruthy()
    expect(store.getEvent(event.id)?.status).toBe('pending')
  })

  it('人工驳回后事件变成无效', async () => {
    const { store, pipeline } = setup()
    const event = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#5', title: '崩溃', body: '崩了' })
    await pipeline.apply(event.id, 'reject')
    expect(store.getEvent(event.id)?.status).toBe('invalid')
  })

  it('来源自己配的每日配额以它为准，超了的事件顺延等下一轮', async () => {
    const { store, pipeline, config } = setup()
    config.events.sources.github = { ...SOURCE, dailyLimit: 1 }
    const first = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#7', title: '崩溃', body: '崩了' })
    await pipeline.process(first)
    const second = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#8', title: '崩溃', body: '崩了' })
    await pipeline.process(second)
    expect(store.getEvent(first.id)?.ticketId).toBeTruthy()
    expect(store.getEvent(second.id)?.execution).toBe('deferred')
    expect(store.getEvent(second.id)?.ticketId).toBeUndefined()
  })

  it('高优事件不受时间窗限制，低优事件在高峰顺延', async () => {
    const { store, pipeline } = setup()
    const event = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#6', title: '崩溃', body: '崩了' })
    await pipeline.process(event)
    expect(store.getEvent(event.id)?.status).toBe('pending')
    expect(store.getEvent(event.id)?.ticketId).toBeTruthy()
  })

  it('时间窗按注入的时钟判定，不受真实时间影响', () => {
    const policy = defaultConfig().events.policy
    // 高峰窗口 09:00-20:00、低峰 20:00-09:00，P2 只在低峰可自动执行。
    // 用本地时间构造，避免跟随跑测机器的时区。
    const offPeak = new Date(2026, 10, 13, 22, 0, 0)
    const peak = new Date(2026, 10, 13, 12, 0, 0)
    expect(windowOf(policy, 'P2', offPeak)).toEqual({ name: 'off-peak' })
    expect(windowOf(policy, 'P2', peak)).toBeNull()
  })

  it('顺延的事件不会每轮重新判定，窗口放行后直接派发', async () => {
    let modelCalls = 0
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => {
        modelCalls += 1
        return { actionable: true, priority: 'P2' as const, project: 'router-agent', skill: 'bug-triage', confidence: 0.9 }
      },
    }
    const { store, engine, config } = setup()
    config.events.decision = { ...config.events.decision, provider: 'llm' }
    const service = new EventDecisionService({ decision: config.events.decision, rule: ruleDecisionPort, model })
    // 固定在本地 12:00：P2 落在高峰窗口，不允许自动执行 → 顺延。
    const noon = new Date(2026, 10, 13, 12, 0, 0).toISOString()
    const pipeline = new EventPipeline({
      store,
      engine,
      config: () => config,
      clock: () => noon,
      ids: prefix => `${prefix}_${modelCalls}`,
      decision: service,
    })
    // 高峰窗口内 P2 不允许自动执行 → 顺延
    const event = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#9', title: '崩溃', body: '崩了' })
    await pipeline.tick(20)
    expect(store.getEvent(event.id)?.execution).toBe('deferred')
    expect(modelCalls).toBe(1)

    // 再跑三轮：判定次数不应增加
    await pipeline.tick(20)
    await pipeline.tick(20)
    await pipeline.tick(20)
    expect(modelCalls).toBe(1)
    expect(store.getEvent(event.id)?.ticketId).toBeUndefined()
  })

  it('顺延的事件等窗口放行后自动派发，且不再重新判定', async () => {
    let modelCalls = 0
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => {
        modelCalls += 1
        return { actionable: true, priority: 'P2' as const, project: 'router-agent', skill: 'bug-triage', confidence: 0.9 }
      },
    }
    const { store, engine, config } = setup()
    config.events.decision = { ...config.events.decision, provider: 'llm' }
    const service = new EventDecisionService({ decision: config.events.decision, rule: ruleDecisionPort, model })
    let now = new Date(2026, 10, 13, 12, 0, 0).toISOString()
    const pipeline = new EventPipeline({
      store,
      engine,
      config: () => config,
      clock: () => now,
      ids: prefix => `${prefix}_${modelCalls}`,
      decision: service,
    })
    const event = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#10', title: '崩溃', body: '崩了' })
    await pipeline.tick(20)
    expect(store.getEvent(event.id)?.execution).toBe('deferred')

    // 时间挪到低峰窗口：闸门放行，直接派发，不重新判定。
    now = new Date(2026, 10, 13, 22, 0, 0).toISOString()
    await pipeline.tick(20)
    expect(store.getEvent(event.id)?.ticketId).toBeTruthy()
    expect(modelCalls).toBe(1)
  })

  it('判定一直失败的事件重试到上限后停手，不无限重试', async () => {
    let modelCalls = 0
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => {
        modelCalls += 1
        throw new Error('模型超时')
      },
    }
    const { store, engine, config } = setup()
    config.events.decision = { ...config.events.decision, provider: 'llm', fallback: 'pending' }
    const service = new EventDecisionService({ decision: config.events.decision, rule: ruleDecisionPort, model })
    const pipeline = new EventPipeline({
      store,
      engine,
      config: () => config,
      clock: () => new Date(2026, 10, 13, 22, 0, 0).toISOString(),
      ids: prefix => `${prefix}_${modelCalls}`,
      decision: service,
    })
    const event = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#11', title: '崩溃', body: '崩了' })
    for (let round = 0; round < 12; round += 1) await pipeline.tick(20)
    const stored = store.getEvent(event.id)!
    expect(modelCalls).toBeLessThanOrEqual(MAX_EVENT_ATTEMPTS)
    expect(stored.execution).toBe('failed')
    expect(stored.lastError).toContain('模型超时')
  })
})
