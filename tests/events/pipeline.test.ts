import { describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { defaultConfig, policyOf, type AppConfig } from '../../src/config.js'
import { EventDecisionService, ruleDecisionPort } from '../../src/events/decision.js'
import { EventPipeline } from '../../src/events/pipeline.js'
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
        github: { enabled: true, kind: 'github', repo: 'blankPen/router-agent', project: 'router-agent', defaultPriority: 'P2', defaultType: 'issue' },
      },
    },
    ...over,
  }
  let counter = 0
  const engine = new Engine({ store, policy: policyOf(config), clock: { now: () => '2026-11-13T10:00:00.000Z' }, ids: { next: p => `${p}_${++counter}` } })
  const decision = new EventDecisionService({
    decision: config.events.decision,
    rule: ruleDecisionPort,
  })
  const pipeline = new EventPipeline({
    store,
    engine,
    config: () => config,
    clock: () => '2026-11-13T10:00:00.000Z',
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
        sources: { github: { ...SOURCE, project: '' } },
      },
    })
    const event = pipeline.ingest('github', { ...SOURCE, project: '' }, { externalId: 'issue:a#3', title: '崩溃', body: '崩了' })
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
        sources: { github: { ...SOURCE, project: '' } },
      },
    })
    const event = pipeline.ingest('github', { ...SOURCE, project: '' }, { externalId: 'issue:a#4', title: '崩溃', body: '崩了' })
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

  it('高优事件不受时间窗限制，低优事件在高峰顺延', async () => {
    const { store, pipeline } = setup()
    const event = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#6', title: '崩溃', body: '崩了' })
    await pipeline.process(event)
    expect(store.getEvent(event.id)?.status).toBe('pending')
    expect(store.getEvent(event.id)?.ticketId).toBeTruthy()
  })
})
