import { describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { chatEntry, defaultConfig, policyOf, type AppConfig } from '../../src/config.js'
import { EventDecisionService, type EventDecisionPort } from '../../src/events/decision.js'
import { EventPipeline, MAX_EVENT_ATTEMPTS, windowOf } from '../../src/events/pipeline.js'
import { subscription } from './fixtures.js'

function setup(over: Partial<AppConfig> = {}, subs = [subscription()]) {
  const store = new Store(':memory:')
  const config: AppConfig = {
    ...defaultConfig(),
    projects: [{ name: 'router-agent', repo: '/Users/me/router-agent', defaultBranch: 'main' }],
    events: {
      ...defaultConfig().events,
      sources: {
        ...defaultConfig().events.sources,
        github: { enabled: true, kind: 'github', repo: 'blankPen/router-agent' },
      },
    },
    ...over,
  }
  // 固定时刻落在低峰窗口（本地 22:00），P2 这类事件允许自动执行；
  // 用本地时间构造，跑测机器换时区结论不变。
  const now = new Date(2026, 10, 13, 22, 0, 0).toISOString()
  let counter = 0
  const engine = new Engine({ store, policy: policyOf(config), clock: { now: () => now }, ids: { next: p => `${p}_${++counter}` } })
  const decision = new EventDecisionService({ decision: config.events.decision })
  const pipeline = new EventPipeline({
    store,
    engine,
    config: () => config,
    clock: () => now,
    ids: prefix => `${prefix}_${++counter}`,
    decision,
    subscriptions: () => subs,
  })
  return { store, engine, config, pipeline, subs }
}

const SOURCE = 'github'
const SUB = subscription()

describe('事件管线', () => {
  it('同一订阅的同一事件只入队一次', () => {
    const { store, pipeline } = setup()
    const first = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#1', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    const second = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#1', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    expect(second.id).toBe(first.id)
    expect(store.listEvents().length).toBe(1)
  })

  it('不同订阅的同一 externalId 各算一条', () => {
    const other = subscription({ id: 'auto_other', taskName: '另一个任务' })
    const { store, pipeline } = setup({}, [SUB, other])
    pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#1', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    pipeline.ingest(SOURCE, 'github', other, { externalId: 'issue:a#1', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    expect(store.listEvents().length).toBe(2)
    expect(store.listEvents().map(item => item.subscriptionId).sort()).toEqual(['auto_other', 'auto_test'])
  })

  it('重复拉取同一事件不会覆盖它已处理的状态', async () => {
    const { store, pipeline } = setup()
    const event = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#1', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(event)
    const processed = store.getEvent(event.id)!
    const again = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#1', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    expect(again.id).toBe(event.id)
    expect(store.getEvent(event.id)!.status).toBe(processed.status)
    expect(store.getEvent(event.id)!.ticketId).toBe(processed.ticketId)
  })

  it('mode=auto 的任务命中后直接开单，事件挂到工单上（V17）', async () => {
    const { store, pipeline } = setup()
    const event = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#2', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(event)
    const stored = store.getEvent(event.id)!
    expect(stored.status).toBe('pending')
    expect(stored.ticketId).toBeTruthy()
    const ticket = store.getTicket(stored.ticketId!)
    expect(ticket?.repo).toBe('/Users/me/router-agent')
    expect(ticket?.branch).toBe('main')
    expect(ticket?.request).toContain('崩溃')
  })

  it('事件工单使用审核群作为通知目标，不把事件 threadId 当飞书消息 ID', async () => {
    const { store, pipeline, config } = setup()
    config.events.policy.reviewChatId = 'oc_review'

    const event = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#2', title: '测试失败', body: 'CI 挂了', eventType: 'github.issues.opened' })
    await pipeline.process(event)

    const stored = store.getEvent(event.id)!
    const ticket = store.getTicket(stored.ticketId!)!
    expect(ticket.chatId).toBe('oc_review')
    expect(ticket.threadId).toBe('event:github:issue:a#2')
  })

  it('审核群留空时事件通知落到默认管理员群', async () => {
    const { store, pipeline, config } = setup()
    config.feishu.chats = [chatEntry('oc_admin', { scope: 'admins' })]

    const event = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#3', title: '测试失败', body: 'CI 挂了', eventType: 'github.issues.opened' })
    await pipeline.process(event)

    const stored = store.getEvent(event.id)!
    expect(store.getTicket(stored.ticketId!)?.chatId).toBe('oc_admin')
  })

  it('没有审核群 / 管理员群时按仓库匹配通知群', async () => {
    const { store, pipeline, config } = setup()
    config.feishu.chats = [
      chatEntry('oc_trove', { repo: 'trove' }),
      chatEntry('oc_router', { repo: 'router-agent' }),
    ]

    const event = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#4', title: '测试失败', body: 'CI 挂了', eventType: 'github.issues.opened' })
    await pipeline.process(event)

    const stored = store.getEvent(event.id)!
    expect(store.getTicket(stored.ticketId!)?.chatId).toBe('oc_router')
  })

  it('订阅的关键词没命中时事件被确定性过滤，不进判定', async () => {
    let modelCalls = 0
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => {
        modelCalls += 1
        return { actionable: true, priority: 'P2' as const, project: 'router-agent', confidence: 0.9 }
      },
    }
    const subs = [subscription({ filter: { keywords: ['退款'], semantic: '' } })]
    const { store, engine, config } = setup({}, subs)
    config.events.decision = { ...config.events.decision, provider: 'llm' }
    const pipeline = new EventPipeline({
      store,
      engine,
      config: () => config,
      clock: () => new Date(2026, 10, 13, 22, 0, 0).toISOString(),
      ids: prefix => `${prefix}_1`,
      decision: new EventDecisionService({ decision: config.events.decision, model }),
      subscriptions: () => subs,
    })
    const event = pipeline.ingest(SOURCE, 'github', subs[0]!, { externalId: 'issue:a#50', title: '普通通知', body: '没有关键词', eventType: 'github.issues.opened' })
    await pipeline.process(event)
    const stored = store.getEvent(event.id)!
    expect(stored.status).toBe('invalid')
    expect(stored.reason).toContain('退款')
    expect(modelCalls).toBe(0)
  })

  it('人工批准后直接开单', async () => {
    const { store, pipeline } = setup()
    const event = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#4', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(event)
    const result = await pipeline.apply(event.id, 'approve', { project: 'router-agent' })
    expect(result?.ticketId).toBeTruthy()
    expect(store.getEvent(event.id)?.status).toBe('pending')
  })

  it('人工驳回后事件变成无效', async () => {
    const { store, pipeline } = setup()
    const event = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#5', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.apply(event.id, 'reject')
    expect(store.getEvent(event.id)?.status).toBe('invalid')
  })

  it('事件命中但闸门不允许时延后，不开单（V21）', async () => {
    const { store, pipeline, config } = setup()
    config.events.policy.perSourceDailyLimit = 1
    const first = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#7', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(first)
    const second = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#8', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(second)
    expect(store.getEvent(first.id)?.ticketId).toBeTruthy()
    expect(store.getEvent(second.id)?.execution).toBe('deferred')
    expect(store.getEvent(second.id)?.ticketId).toBeUndefined()
  })

  it('配额按今天开出的工单算，不按事件在 GitHub 上发生的时间算', async () => {
    const { store, pipeline, config } = setup()
    config.events.policy.perSourceDailyLimit = 1
    const first = pipeline.ingest(SOURCE, 'github', SUB, {
      externalId: 'issue:a#70',
      title: '崩溃',
      body: '崩了',
      eventType: 'github.issues.opened',
      receivedAt: '2026-11-03T10:00:00.000Z',
    })
    await pipeline.process(first)
    const second = pipeline.ingest(SOURCE, 'github', SUB, {
      externalId: 'issue:a#71',
      title: '崩溃',
      body: '崩了',
      eventType: 'github.issues.opened',
      receivedAt: '2026-11-02T10:00:00.000Z',
    })
    await pipeline.process(second)
    expect(store.getEvent(first.id)?.ticketId).toBeTruthy()
    expect(store.getEvent(second.id)?.execution).toBe('deferred')
  })

  it('在办工单达到上限时事件顺延，不开出新工单', async () => {
    const { store, pipeline, config } = setup()
    config.events.policy.maxOpenTickets = 1

    const first = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#80', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(first)
    expect(store.getEvent(first.id)?.ticketId).toBeTruthy()

    const second = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#81', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(second)
    expect(store.getEvent(second.id)?.ticketId).toBeUndefined()
    expect(store.getEvent(second.id)?.execution).toBe('deferred')
    expect(store.getEvent(second.id)?.reason).toContain('在办工单')
  })

  it('在办工单上限为 0 时不限制开单', async () => {
    const { store, pipeline, config } = setup()
    config.events.policy.maxOpenTickets = 0

    const first = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#90', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(first)
    const second = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#91', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(second)

    expect(store.getEvent(first.id)?.ticketId).toBeTruthy()
    expect(store.getEvent(second.id)?.ticketId).toBeTruthy()
  })

  it('高优事件不受时间窗限制，低优事件在高峰顺延', async () => {
    const { store, pipeline } = setup()
    const event = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#6', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(event)
    expect(store.getEvent(event.id)?.status).toBe('pending')
    expect(store.getEvent(event.id)?.ticketId).toBeTruthy()
  })

  it('时间窗按注入的时钟判定，不受真实时间影响', () => {
    const policy = defaultConfig().events.policy
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
    const service = new EventDecisionService({ decision: config.events.decision, model })
    const noon = new Date(2026, 10, 13, 12, 0, 0).toISOString()
    const pipeline = new EventPipeline({
      store,
      engine,
      config: () => config,
      clock: () => noon,
      ids: prefix => `${prefix}_${modelCalls}`,
      decision: service,
      subscriptions: () => [SUB],
    })
    const event = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#9', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.tick(20)
    expect(store.getEvent(event.id)?.execution).toBe('deferred')
    expect(modelCalls).toBe(1)

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
    const service = new EventDecisionService({ decision: config.events.decision, model })
    let now = new Date(2026, 10, 13, 12, 0, 0).toISOString()
    const pipeline = new EventPipeline({
      store,
      engine,
      config: () => config,
      clock: () => now,
      ids: prefix => `${prefix}_${modelCalls}`,
      decision: service,
      subscriptions: () => [SUB],
    })
    const event = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#10', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.tick(20)
    expect(store.getEvent(event.id)?.execution).toBe('deferred')

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
    const service = new EventDecisionService({ decision: config.events.decision, model })
    const pipeline = new EventPipeline({
      store,
      engine,
      config: () => config,
      clock: () => new Date(2026, 10, 13, 22, 0, 0).toISOString(),
      ids: prefix => `${prefix}_${modelCalls}`,
      decision: service,
      subscriptions: () => [SUB],
    })
    const event = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#11', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    for (let round = 0; round < 12; round += 1) await pipeline.tick(20)
    const stored = store.getEvent(event.id)!
    expect(modelCalls).toBeLessThanOrEqual(MAX_EVENT_ATTEMPTS)
    expect(stored.execution).toBe('failed')
    expect(stored.lastError).toContain('模型超时')
  })

  it('判定模型返回 451 时直接转人工，不重试到上限', async () => {
    let modelCalls = 0
    const model: EventDecisionPort = {
      name: 'jev',
      decide: async () => {
        modelCalls += 1
        throw new Error('jev:http-451 {"title":"Typesafe is not available in your region.","status":451}')
      },
    }
    const { store, engine, config } = setup()
    config.events.decision = { ...config.events.decision, provider: 'jev', fallback: 'pending' }
    const service = new EventDecisionService({ decision: config.events.decision, model })
    const pipeline = new EventPipeline({
      store,
      engine,
      config: () => config,
      clock: () => new Date(2026, 10, 13, 22, 0, 0).toISOString(),
      ids: prefix => `${prefix}_${modelCalls}`,
      decision: service,
      subscriptions: () => [SUB],
    })
    const event = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#12', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })

    await pipeline.tick(20)
    const stored = store.getEvent(event.id)!
    expect(stored.status).toBe('review')
    expect(stored.needsReview).toBe(true)
    expect(stored.reason).toContain('451')
    expect(stored.execution).not.toBe('failed')

    for (let round = 0; round < 10; round += 1) await pipeline.tick(20)
    expect(modelCalls).toBe(1)
  })

  it('来源 context 入库，并在判定 state 里保留', () => {
    const { store, pipeline } = setup()
    const event = pipeline.ingest(SOURCE, 'github', SUB, {
      externalId: 'pr:a#2',
      title: 'PR 失败',
      body: '',
      eventType: 'github.workflow_run.failure',
      context: { repo: 'blankPen/router-agent', branch: 'main', actor: 'alice' },
    })
    expect(store.getEvent(event.id)?.context).toEqual({
      repo: 'blankPen/router-agent',
      branch: 'main',
      actor: 'alice',
    })
  })

  it('订阅的任务提示词进入 Worker scope', async () => {
    const subs = [subscription({ prompt: '先复现失败，再修复并提交 PR。' })]
    const { store, pipeline } = setup({}, subs)
    const event = pipeline.ingest(SOURCE, 'github', subs[0]!, {
      externalId: 'run:a#1',
      title: 'CI 失败',
      body: 'workflow failed',
      eventType: 'github.workflow_run.failure',
    })
    await pipeline.tick()
    const stored = store.getEvent(event.id)!
    const ticket = store.getTicket(stored.ticketId!)
    const mandate = store.getMandate(ticket!.mandateId)!
    expect(mandate.scope).toContain('执行流程：先复现失败，再修复并提交 PR。')
    expect(mandate.scope).toContain('授权范围：只处理本事件范围内的事')
  })

  it('mode=review 的任务命中后进待审核，不开单（V18）', async () => {
    const subs = [subscription({ mode: 'review' })]
    const { store, pipeline } = setup({}, subs)
    const event = pipeline.ingest(SOURCE, 'github', subs[0]!, { externalId: 'issue:a#60', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(event)
    const stored = store.getEvent(event.id)!
    expect(stored.status).toBe('review')
    expect(stored.ticketId).toBeUndefined()
  })

  it('mode=review 的事件在收件箱点「转自动」后正常开单（V19）', async () => {
    const subs = [subscription({ mode: 'review' })]
    const { store, pipeline } = setup({}, subs)
    const event = pipeline.ingest(SOURCE, 'github', subs[0]!, { externalId: 'issue:a#63', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(event)
    expect(store.getEvent(event.id)?.status).toBe('review')

    const result = await pipeline.apply(event.id, 'approve', { project: 'router-agent' })
    expect(result?.ticketId).toBeTruthy()
    const stored = store.getEvent(event.id)!
    expect(stored.ticketId).toBeTruthy()
    expect(stored.status).toBe('pending')
  })

  it('判定完的事件详情带 context.background 与 context.filtered（V22）', async () => {
    const subs = [subscription({ filter: { keywords: ['崩溃'], semantic: '影响主流程的崩溃' } })]
    const { store, pipeline } = setup({}, subs)
    const event = pipeline.ingest(SOURCE, 'github', subs[0]!, { externalId: 'issue:a#64', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(event)
    const context = store.getEvent(event.id)?.context ?? {}
    expect(context.background).toContain('命中关键词：崩溃')
    expect(context.background).toContain('归属项目：router-agent')
    expect(context.filtered).toContain('订阅：测试任务')
    expect(context.filtered).toContain('auto_test')
  })

  it('被关键词过滤掉的事件也带上下文，说清为什么没进判定（V22）', async () => {
    const subs = [subscription({ filter: { keywords: ['退款'], semantic: '' } })]
    const { store, pipeline } = setup({}, subs)
    const event = pipeline.ingest(SOURCE, 'github', subs[0]!, { externalId: 'issue:a#65', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(event)
    const context = store.getEvent(event.id)?.context ?? {}
    expect(context.background).toContain('未命中订阅关键词：退款')
    expect(context.filtered).toContain('订阅：测试任务')
  })

  it('mode=notify 的任务命中后只记录并通知，不开单（V20）', async () => {
    const subs = [subscription({ mode: 'notify' })]
    const { store, pipeline } = setup({}, subs)
    const event = pipeline.ingest(SOURCE, 'github', subs[0]!, { externalId: 'issue:a#61', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(event)
    const stored = store.getEvent(event.id)!
    expect(stored.execution).toBe('notified')
    expect(stored.ticketId).toBeUndefined()
    expect(stored.status).toBe('done')
  })

  it('订阅被删后事件转人工，不会静默消失', async () => {
    const { store, pipeline } = setup({}, [SUB])
    const event = pipeline.ingest(SOURCE, 'github', SUB, { externalId: 'issue:a#62', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    const orphan = { ...store.getEvent(event.id)!, subscriptionId: 'auto_gone' }
    store.updateEvent(orphan)
    await pipeline.process(orphan)
    const stored = store.getEvent(event.id)!
    expect(stored.status).toBe('review')
    expect(stored.reason).toContain('订阅已不存在')
  })
})
