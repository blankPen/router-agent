import { describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { chatEntry, defaultConfig, policyOf, type AppConfig } from '../../src/config.js'
import { EventDecisionService, ruleDecisionPort, type EventDecisionPort } from '../../src/events/decision.js'
import { EventPipeline, MAX_EVENT_ATTEMPTS, windowOf } from '../../src/events/pipeline.js'
import { EVENT_SKILLS } from '../../src/events/skills.js'
import { compileRuleTemplate } from '../../src/events/rules.js'

function setup(over: Partial<AppConfig> = {}) {
  const store = new Store(':memory:')
  const config: AppConfig = {
    ...defaultConfig(),
    projects: [{ name: 'router-agent', repo: '/Users/me/router-agent', defaultBranch: 'main' }],
    events: {
      ...defaultConfig().events,
      // 判定依据来自规则：给一条覆盖 github.issues.opened 的规则。
      rules: [compileRuleTemplate({ id: 'rule-issue', eventType: 'github.issues.opened', intent: '处理 issue' })],
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
}

describe('事件管线', () => {
  it('同一来源的同一事件只入队一次', () => {
    const { store, pipeline } = setup()
    const first = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#1', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    const second = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#1', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    expect(second.id).toBe(first.id)
    expect(store.listEvents().length).toBe(1)
  })

  it('不同来源的同一 externalId 各算一条', () => {
    const { store, pipeline } = setup()
    pipeline.ingest('github', SOURCE, { externalId: 'issue:a#1', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    pipeline.ingest('gitlab', SOURCE, { externalId: 'issue:a#1', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    expect(store.listEvents().length).toBe(2)
  })

  it('重复拉取同一事件不会覆盖它已处理的状态', async () => {
    const { store, pipeline } = setup()
    const event = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#1', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(event)
    const processed = store.getEvent(event.id)!
    const again = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#1', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    expect(again.id).toBe(event.id)
    expect(store.getEvent(event.id)!.status).toBe(processed.status)
    expect(store.getEvent(event.id)!.ticketId).toBe(processed.ticketId)
  })

  it('判定通过且项目明确时直接开单，事件挂到工单上', async () => {
    const { store, pipeline } = setup()
    const event = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#2', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
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

    const event = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#2', title: '测试失败', body: 'CI 挂了', eventType: 'github.issues.opened' })
    await pipeline.process(event)

    const stored = store.getEvent(event.id)!
    const ticket = store.getTicket(stored.ticketId!)!
    expect(ticket.chatId).toBe('oc_review')
    expect(ticket.threadId).toBe('event:github:issue:a#2')
  })

  it('审核群留空时事件通知落到默认管理员群', async () => {
    const { store, pipeline, config } = setup()
    config.feishu.chats = [chatEntry('oc_admin', { scope: 'admins' })]

    const event = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#3', title: '测试失败', body: 'CI 挂了', eventType: 'github.issues.opened' })
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

    const event = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#4', title: '测试失败', body: 'CI 挂了', eventType: 'github.issues.opened' })
    await pipeline.process(event)

    const stored = store.getEvent(event.id)!
    expect(store.getTicket(stored.ticketId!)?.chatId).toBe('oc_router')
  })

  it('判定不清时进待审核队列，不开单', async () => {
    const { store, pipeline } = setup({
      events: {
        ...defaultConfig().events,
        rules: [compileRuleTemplate({ id: 'rule-issue', eventType: 'github.issues.opened', intent: '处理 issue' })],
        sources: { github: { ...SOURCE, repo: 'someone/other' } },
      },
    })
    const event = pipeline.ingest('github', { ...SOURCE, repo: 'someone/other' }, { externalId: 'issue:a#3', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
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
        rules: [compileRuleTemplate({ id: 'rule-issue', eventType: 'github.issues.opened', intent: '处理 issue' })],
        sources: { github: { ...SOURCE, repo: 'someone/other' } },
      },
    })
    const event = pipeline.ingest('github', { ...SOURCE, repo: 'someone/other' }, { externalId: 'issue:a#4', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(event)
    const result = await pipeline.apply(event.id, 'approve', { project: 'router-agent' })
    expect(result?.ticketId).toBeTruthy()
    expect(store.getEvent(event.id)?.status).toBe('pending')
  })

  it('人工驳回后事件变成无效', async () => {
    const { store, pipeline } = setup()
    const event = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#5', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.apply(event.id, 'reject')
    expect(store.getEvent(event.id)?.status).toBe('invalid')
  })

  it('单来源每日上限由策略统一决定，超了的事件顺延等下一轮', async () => {
    const { store, pipeline, config } = setup()
    config.events.policy.perSourceDailyLimit = 1
    const first = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#7', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(first)
    const second = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#8', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(second)
    expect(store.getEvent(first.id)?.ticketId).toBeTruthy()
    expect(store.getEvent(second.id)?.execution).toBe('deferred')
    expect(store.getEvent(second.id)?.ticketId).toBeUndefined()
  })

  it('配额按今天开出的工单算，不按事件在 GitHub 上发生的时间算', async () => {
    const { store, pipeline, config } = setup()
    config.events.policy.perSourceDailyLimit = 1
    // 这条事件在 GitHub 上是十天前发生的，但今天才判定：算今天的配额。
    const first = pipeline.ingest('github', SOURCE, {
      externalId: 'issue:a#70',
      title: '崩溃',
      body: '崩了',
      eventType: 'github.issues.opened',
      receivedAt: '2026-11-03T10:00:00.000Z',
    })
    await pipeline.process(first)
    const second = pipeline.ingest('github', SOURCE, {
      externalId: 'issue:a#71',
      title: '崩溃',
      body: '崩了',
      eventType: 'github.issues.opened',
      receivedAt: '2026-11-02T10:00:00.000Z',
    })
    await pipeline.process(second)
    expect(store.getEvent(first.id)?.ticketId).toBeTruthy()
    // 第二条同样算今天：配额已满，顺延。
    expect(store.getEvent(second.id)?.execution).toBe('deferred')
  })

  it('在办工单达到上限时事件顺延，不开出新工单', async () => {
    const { store, pipeline, config } = setup()
    config.events.policy.maxOpenTickets = 1

    const first = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#80', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(first)
    expect(store.getEvent(first.id)?.ticketId).toBeTruthy()

    // 在办工单已达上限：第二条事件排队等工单收尾，不再凭空开单。
    const second = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#81', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(second)
    expect(store.getEvent(second.id)?.ticketId).toBeUndefined()
    expect(store.getEvent(second.id)?.execution).toBe('deferred')
    expect(store.getEvent(second.id)?.reason).toContain('在办工单')
  })

  it('在办工单上限为 0 时不限制开单', async () => {
    const { store, pipeline, config } = setup()
    config.events.policy.maxOpenTickets = 0

    const first = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#90', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(first)
    const second = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#91', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
    await pipeline.process(second)

    expect(store.getEvent(first.id)?.ticketId).toBeTruthy()
    expect(store.getEvent(second.id)?.ticketId).toBeTruthy()
  })

  it('高优事件不受时间窗限制，低优事件在高峰顺延', async () => {
    const { store, pipeline } = setup()
    const event = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#6', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
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
    const event = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#9', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
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
    const event = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#10', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
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
    const event = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#11', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })
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
    const service = new EventDecisionService({ decision: config.events.decision, rule: ruleDecisionPort, model })
    const pipeline = new EventPipeline({
      store,
      engine,
      config: () => config,
      clock: () => new Date(2026, 10, 13, 22, 0, 0).toISOString(),
      ids: prefix => `${prefix}_${modelCalls}`,
      decision: service,
    })
    const event = pipeline.ingest('github', SOURCE, { externalId: 'issue:a#12', title: '崩溃', body: '崩了', eventType: 'github.issues.opened' })

    await pipeline.tick(20)
    const stored = store.getEvent(event.id)!
    expect(stored.status).toBe('review')
    expect(stored.needsReview).toBe(true)
    expect(stored.reason).toContain('451')
    expect(stored.execution).not.toBe('failed')

    for (let round = 0; round < 10; round += 1) await pipeline.tick(20)
    expect(modelCalls).toBe(1)
  })

  it('没有匹配规则的事件保持未判定，不被领取也不调模型', async () => {
    let modelCalls = 0
    const model: EventDecisionPort = {
      name: 'llm',
      decide: async () => {
        modelCalls += 1
        return { actionable: true, priority: 'P2' as const, project: 'router-agent', confidence: 0.9 }
      },
    }
    const { store, config } = setup({
      events: {
        ...defaultConfig().events,
        decision: { ...defaultConfig().events.decision, provider: 'llm' },
        sources: { github: SOURCE },
        rules: [],
      },
    })
    const service = new EventDecisionService({ decision: config.events.decision, rule: ruleDecisionPort, model })
    const pipeline = new EventPipeline({
      store,
      engine: new Engine({ store, policy: policyOf(config), ids: { next: p => `${p}_1` } }),
      config: () => config,
      clock: () => new Date(2026, 10, 13, 22, 0, 0).toISOString(),
      ids: prefix => `${prefix}_1`,
      decision: service,
    })
    const event = pipeline.ingest('github', SOURCE, {
      externalId: 'issue:a#20',
      title: '普通通知',
      body: '没有规则',
      eventType: 'github.issues.opened',
    })
    await pipeline.tick()
    const stored = store.getEvent(event.id)!
    expect(stored.status).toBe('undecided')
    expect(stored.reason).toBe('未匹配到决策规则')
    expect(modelCalls).toBe(0)
  })

  it('规则按 eventType 精确匹配，不会串到其它类型', async () => {
    const rule = compileRuleTemplate({ id: 'rule-issue', eventType: 'github.issues.opened', intent: '处理 issue' })
    const { store, config } = setup({
      events: {
        ...defaultConfig().events,
        sources: { github: SOURCE },
        rules: [rule],
      },
    })
    const pipeline = new EventPipeline({
      store,
      engine: new Engine({ store, policy: policyOf(config), ids: { next: p => `${p}_1` } }),
      config: () => config,
      clock: () => new Date(2026, 10, 13, 22, 0, 0).toISOString(),
      ids: prefix => `${prefix}_1`,
      decision: new EventDecisionService({ decision: config.events.decision, rule: ruleDecisionPort }),
    })
    const event = pipeline.ingest('github', SOURCE, {
      externalId: 'pr:a#1',
      title: 'PR 通知',
      body: '',
      eventType: 'github.pull_request.opened',
    })
    expect(store.getEvent(event.id)?.status).toBe('undecided')
    expect(store.getEventByExternalId('github', 'pr:a#1')?.ruleId).toBeUndefined()
  })

  it('来源 context 入库，并在判定 state 里保留', () => {
    const { store, pipeline } = setup()
    const event = pipeline.ingest('github', SOURCE, {
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

  it('规则变更后重新激活未判定事件并开始派发', async () => {
    const { store, pipeline, config } = setup({
      events: {
        ...defaultConfig().events,
        sources: { github: SOURCE },
        rules: [],
      },
    })
    const event = pipeline.ingest('github', SOURCE, {
      externalId: 'issue:a#21',
      title: '崩溃',
      body: '崩了',
      eventType: 'github.issues.opened',
    })
    expect(store.getEvent(event.id)?.status).toBe('undecided')
    config.events.rules = [compileRuleTemplate({ id: 'rule-issue', eventType: 'github.issues.opened', intent: '处理 issue' })]
    const activated = store.activateUndecidedEvents(['github.issues.opened'], new Date(2026, 10, 13, 22, 0, 0).toISOString())
    expect(activated).toBe(1)
    await pipeline.tick()
    expect(store.getEvent(event.id)?.ticketId).toBeTruthy()
  })

  it('规则的 workflowPrompt 进入 Worker scope，宿主护栏保留', async () => {
    const rule = compileRuleTemplate({
      id: 'rule-ci',
      eventType: 'github.workflow_run.failure',
      intent: '修复 CI',
      workflowPrompt: '先复现失败，再修复并提交 PR。',
    })
    const { store, pipeline, config } = setup({
      events: {
        ...defaultConfig().events,
        sources: { github: SOURCE },
        rules: [rule],
      },
    })
    const event = pipeline.ingest('github', SOURCE, {
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
    expect(config.events.rules[0]?.id).toBe(rule.id)
  })

  it('判定记录里带上命中的规则版本，历史判定能定位到当时那版规则', async () => {
    const rule = compileRuleTemplate({
      id: 'rule-issue',
      eventType: 'github.issues.opened',
      intent: '处理 issue',
      version: 3,
    })
    const { store, pipeline } = setup({
      events: {
        ...defaultConfig().events,
        sources: { github: SOURCE },
        rules: [rule],
      },
    })
    const event = pipeline.ingest('github', SOURCE, {
      externalId: 'issue:a#30',
      title: '崩溃',
      body: '崩了',
      eventType: 'github.issues.opened',
    })
    await pipeline.tick()
    const stored = store.getEvent(event.id)!
    expect(stored.ruleId).toBe('rule-issue')
    expect(stored.ruleVersion).toBe(3)
  })
})
