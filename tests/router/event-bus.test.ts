import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { EventBus, type EventBusOptions } from '../../src/router/event-bus.js'
import type { EventTriagePort } from '../../src/router/event-triage.js'
import { defaultEventSettings, type EventSettings } from '../../src/config.js'
import type { EventEnvelope } from '#core/event.js'
import type { Policy } from '#core/policy.js'

const policy: Policy = {
  version: 'p1',
  acceptMode: 'auto',
  maxWorkers: 4,
  allowed: ['ou_alice'],
  bots: [],
}

const NOW = '2026-11-14T02:00:00.000Z'

function envelope(over: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: 'ev_1',
    source: 'github-issue',
    type: 'issue.updated',
    externalId: 'blankPen/router-agent#12@2026-11-14',
    subject: 'blankPen/router-agent#12',
    summary: '导出功能偶发失败，需要修复',
    actor: { id: 'ghost', name: 'someone', type: 'external' },
    project: 'router-agent',
    lane: 'repo:blankPen/router-agent',
    priorityHint: 70,
    costClass: 'cheap',
    receivedAt: NOW,
    hops: 0,
    ...over,
  }
}

function triageOf(over: Partial<{ needsHandling: number; eventType: number; priority: number; needsHuman: number; projectRelated: number; tokens: number }> = {}): EventTriagePort {
  const { tokens, ...answers } = over
  return {
    async triage() {
      return {
        answers: {
          needsHandling: 0.9,
          eventType: 0.6,
          priority: 0.75,
          needsHuman: 0.1,
          projectRelated: 0.9,
          ...answers,
        },
        eventTypeLabel: 'defect',
        priorityLabel: 'high',
        ...(tokens === undefined ? {} : { tokens }),
      }
    },
  }
}

describe('事件总线', () => {
  let store: Store
  let engine: Engine
  let settings: EventSettings
  let logs: Array<{ level: string; event: string; fields: Record<string, unknown> }>

  beforeEach(() => {
    store = new Store(':memory:')
    engine = new Engine({
      store,
      policy,
      clock: { now: () => NOW },
      ids: { next: prefix => `${prefix}_${Math.random().toString(36).slice(2, 8)}` },
    })
    settings = defaultEventSettings()
    settings.enabled = true
    logs = []
  })

  function bus(over: Partial<EventBusOptions> = {}): EventBus {
    return new EventBus({
      store,
      engine,
      settings: () => settings,
      clock: { now: () => NOW },
      ids: { next: prefix => `${prefix}_${Math.random().toString(36).slice(2, 8)}` },
      timeOfDay: () => '10:00',
      logger: {
        info: (event: string, fields?: Record<string, unknown>) => logs.push({ level: 'info', event, fields: fields ?? {} }),
        warn: (event: string, fields?: Record<string, unknown>) => logs.push({ level: 'warn', event, fields: fields ?? {} }),
        error: (event: string, fields?: Record<string, unknown>) => logs.push({ level: 'error', event, fields: fields ?? {} }),
      },
      resolveDispatch: () => ({ repo: '/repos/router-agent', branch: 'main', project: 'router-agent', missing: [] }),
      ...over,
    })
  }

  it('同一来源同一外部 ID 只入队一次', async () => {
    const b = bus({ triage: triageOf() })
    const first = await b.ingest(envelope())
    const second = await b.ingest(envelope({ id: 'ev_2' }))
    expect(first.accepted).toBe(true)
    expect(second.accepted).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(store.getEventByKey('github-issue', 'blankPen/router-agent#12@2026-11-14')?.id).toBe('ev_1')
  })

  it('对象标识含非法字符的事件被拒绝', async () => {
    const b = bus({ triage: triageOf() })
    const result = await b.ingest(envelope({ subject: '含中文的标题' }))
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe('event:invalid-subject')
  })

  it('自产事件链超过上限时熔断丢弃', async () => {
    const b = bus({ triage: triageOf() })
    const result = await b.ingest(envelope({ hops: 9 }))
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe('event:hops-exceeded')
  })

  it('判定为需要处理且置信度足够时直接开单', async () => {
    const b = bus({ triage: triageOf() })
    await b.ingest(envelope())
    const outcome = await b.tick()
    expect(outcome.dispatched).toBe(1)
    const tickets = store.listTickets({ limit: 10 })
    expect(tickets).toHaveLength(1)
    expect(tickets[0]?.repo).toBe('/repos/router-agent')
    const queue = store.getEventQueue('ev_1')
    expect(queue?.state).toBe('dispatched')
    expect(queue?.ticketId).toBe(tickets[0]?.id)
  })

  it('判定需要人介入时进待审核队列并通知管理员', async () => {
    const notify = vi.fn()
    const b = bus({ triage: triageOf({ needsHuman: 0.9 }), notifyReview: notify })
    await b.ingest(envelope())
    const outcome = await b.tick()
    expect(outcome.pending).toBe(1)
    expect(store.getEventQueue('ev_1')?.state).toBe('pending_review')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(store.listTickets({ limit: 10 })).toHaveLength(0)
  })

  it('判定模型失败时降级进待审核，不丢事件', async () => {
    const b = bus({
      triage: { async triage() { throw new Error('jev:timeout') } },
    })
    await b.ingest(envelope())
    const outcome = await b.tick()
    expect(outcome.pending).toBe(1)
    expect(store.getEventQueue('ev_1')?.state).toBe('pending_review')
    expect(logs.some(log => log.event === 'event:triage-failed')).toBe(true)
  })

  it('派工信息不全时不开单，改进待审核', async () => {
    const b = bus({
      triage: triageOf(),
      resolveDispatch: () => ({ repo: '', branch: '', missing: ['repo'] }),
    })
    await b.ingest(envelope())
    await b.tick()
    expect(store.getEventQueue('ev_1')?.state).toBe('pending_review')
    expect(store.listTickets({ limit: 10 })).toHaveLength(0)
  })

  it('预算超限时不再问模型，低优先级事件直接延后', async () => {
    settings.budget.dailyEvents = 1
    const port = triageOf({ needsHuman: 0.9 })
    const triage = vi.fn(port.triage)
    const b = bus({ triage: { triage } })
    await b.ingest(envelope())
    await b.tick()
    const queue = store.getEventQueue('ev_1')
    expect(queue?.state).toBe('deferred')
    expect(queue?.reason).toBe('event:budget-exceeded')
    // 预算的意义就是不再花钱问模型：这条事件一次判定都不该发生。
    expect(triage).not.toHaveBeenCalled()
    expect(logs.some(log => log.event === 'event:budget-exceeded' && log.level === 'warn')).toBe(true)
  })

  it('预算超限时规则层判为高优先级的事件仍然派工', async () => {
    settings.budget.dailyEvents = 1
    const b = bus({ triage: triageOf({ priority: 0.95 }) })
    await b.ingest(envelope({ priorityHint: 95 }))
    await b.tick()
    expect(store.getEventQueue('ev_1')?.state).toBe('dispatched')
    expect(logs.some(log => log.event === 'event:budget-exceeded' && log.level === 'warn')).toBe(true)
  })

  it('判定消耗的 token 计入当日预算，触顶后不再调用判定模型', async () => {
    settings.budget.dailyTokens = 10
    const port = triageOf({ needsHuman: 0.9, tokens: 100 })
    const triage = vi.fn(port.triage)
    const b = bus({ triage: { triage } })
    await b.ingest(envelope({ id: 'ev_1', externalId: 'ext-1' }))
    await b.tick()
    expect(store.getEventQueue('ev_1')?.state).toBe('deferred')
    expect(store.getEventQueue('ev_1')?.reason).toBe('event:budget-exceeded')
    // 计数器按本地日历日分桶：日期用 Intl 独立算，不复制生产实现。
    const localDay = new Date(NOW).toLocaleDateString('en-CA')
    expect(store.getCursor(`event:tokens:${localDay}`)).toBe('100')

    await b.ingest(envelope({ id: 'ev_2', externalId: 'ext-2' }))
    await b.tick()
    expect(store.getEventQueue('ev_2')?.state).toBe('deferred')
    // 预算已触顶，第二条事件一次模型调用都不该再发生。
    expect(triage).toHaveBeenCalledTimes(1)
  })

  it('时间窗不放行时延后到窗口开始', async () => {
    settings.windows = [{ id: 'peak', from: '09:00', to: '20:00', allow: ['t0'] }]
    const b = bus({ triage: triageOf({ priority: 0.2, needsHuman: 0.9 }) })
    await b.ingest(envelope())
    await b.tick()
    const queue = store.getEventQueue('ev_1')
    expect(queue?.state).toBe('deferred')
    expect(queue?.reason).toBe('event:window-closed')
  })

  it('批量窗口内同源同类型事件合并成一次判定调用', async () => {
    settings.windows = [{ id: 'night', from: '09:00', to: '20:00', allow: ['t0', 't1'], batch: true }]
    const triage = vi.fn(async () => ({
      answers: { needsHandling: 0.9, eventType: 0.6, priority: 0.75, needsHuman: 0.1, projectRelated: 0.9 },
      eventTypeLabel: 'defect',
      priorityLabel: 'high',
    }))
    const triageBatch = vi.fn(async (inputs: Array<{ subject: string }>) => ({
      results: inputs.map(() => ({
        answers: { needsHandling: 0.9, eventType: 0.6, priority: 0.75, needsHuman: 0.1, projectRelated: 0.9 },
        eventTypeLabel: 'defect',
        priorityLabel: 'high',
      })),
      tokens: 42,
    }))
    const b = bus({ triage: { triage, triageBatch } })
    await b.ingest(envelope({ id: 'ev_1', externalId: 'ext-1' }))
    await b.ingest(envelope({ id: 'ev_2', externalId: 'ext-2' }))
    const outcome = await b.tick()
    expect(triageBatch).toHaveBeenCalledTimes(1)
    expect(triageBatch.mock.calls[0]?.[0]).toHaveLength(2)
    expect(triage).not.toHaveBeenCalled()
    expect(outcome.dispatched).toBe(2)
    expect(logs.some(log => log.event === 'event:triage-batched' && log.level === 'info')).toBe(true)
    const localDay = new Date(NOW).toLocaleDateString('en-CA')
    expect(store.getCursor(`event:tokens:${localDay}`)).toBe('42')
  })

  it('不在批量窗口时逐条判定，不合并调用', async () => {
    settings.windows = [{ id: 'peak', from: '09:00', to: '20:00', allow: ['t0', 't1'] }]
    const triage = vi.fn(async () => ({
      answers: { needsHandling: 0.9, eventType: 0.6, priority: 0.75, needsHuman: 0.1, projectRelated: 0.9 },
      eventTypeLabel: 'defect',
      priorityLabel: 'high',
    }))
    const triageBatch = vi.fn(async () => ({ results: [], tokens: 0 }))
    const b = bus({ triage: { triage, triageBatch } })
    await b.ingest(envelope({ id: 'ev_1', externalId: 'ext-1' }))
    await b.ingest(envelope({ id: 'ev_2', externalId: 'ext-2' }))
    await b.tick()
    expect(triage).toHaveBeenCalledTimes(2)
    expect(triageBatch).not.toHaveBeenCalled()
  })

  it('批量判定失败时退回逐条判定，事件不丢', async () => {
    settings.windows = [{ id: 'night', from: '09:00', to: '20:00', allow: ['t0', 't1'], batch: true }]
    const triage = vi.fn(async () => ({
      answers: { needsHandling: 0.9, eventType: 0.6, priority: 0.75, needsHuman: 0.1, projectRelated: 0.9 },
      eventTypeLabel: 'defect',
      priorityLabel: 'high',
    }))
    const triageBatch = vi.fn(async () => { throw new Error('jev:http-500') })
    const b = bus({ triage: { triage, triageBatch } })
    await b.ingest(envelope({ id: 'ev_1', externalId: 'ext-1' }))
    await b.ingest(envelope({ id: 'ev_2', externalId: 'ext-2' }))
    const outcome = await b.tick()
    expect(triage).toHaveBeenCalledTimes(2)
    expect(outcome.dispatched).toBe(2)
    expect(logs.some(log => log.event === 'event:triage-batch-failed' && log.level === 'warn')).toBe(true)
  })

  it('审核批准后开单，驳回后丢弃', async () => {
    const b = bus({ triage: triageOf({ needsHuman: 0.9 }) })
    await b.ingest(envelope())
    await b.tick()
    const rejected = await b.review('ev_1', 'reject', 'ou_admin')
    expect(rejected.state).toBe('dropped')
    expect(store.listTickets({ limit: 10 })).toHaveLength(0)

    const b2 = bus({ triage: triageOf({ needsHuman: 0.9 }) })
    await b2.ingest(envelope({ id: 'ev_2', externalId: 'ext-2' }))
    await b2.tick()
    const approved = await b2.review('ev_2', 'approve', 'ou_admin')
    expect(approved.state).toBe('dispatched')
    expect(store.listTickets({ limit: 10 })).toHaveLength(1)
  })

  it('同一事件重复批准只开一张工单', async () => {
    const b = bus({ triage: triageOf({ needsHuman: 0.9 }) })
    await b.ingest(envelope())
    await b.tick()
    expect(store.getEventQueue('ev_1')?.state).toBe('pending_review')

    const first = await b.review('ev_1', 'approve', 'ou_admin')
    expect(first.state).toBe('dispatched')
    const ticketId = store.getEventQueue('ev_1')?.ticketId
    expect(ticketId).toBeTruthy()

    const second = await b.review('ev_1', 'approve', 'ou_admin')
    expect(second.state).toBe('dispatched')
    expect(store.getEventQueue('ev_1')?.ticketId).toBe(ticketId)
    expect(store.listTickets({ limit: 10 })).toHaveLength(1)
  })

  it('上次派工中途失败时复用已落库的触发消息，仍能开出工单', async () => {
    const b = bus({ triage: triageOf({ needsHuman: 0.9 }) })
    await b.ingest(envelope())
    await b.tick()
    store.insertTrigger({
      id: 'trg_event_ev_1',
      source: 'github-issue',
      externalId: 'blankPen/router-agent#12@2026-11-14',
      threadId: 'event:ev_1',
      chatId: '',
      chatName: 'github-issue',
      actorId: 'ghost',
      actorName: 'someone',
      isBot: false,
      text: 'blankPen/router-agent#12：导出功能偶发失败，需要修复',
      addressed: 'direct',
      receivedAt: NOW,
      disposition: 'pending',
    })

    const approved = await b.review('ev_1', 'approve', 'ou_admin')
    expect(approved.state).toBe('dispatched')
    expect(store.listTickets({ limit: 10 })).toHaveLength(1)
    expect(store.getEventQueue('ev_1')?.ticketId).toBe(store.listTickets({ limit: 10 })[0]?.id)
  })
})
