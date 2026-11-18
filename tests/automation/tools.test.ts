import { describe, expect, it } from 'vitest'
import { AutomationRateLimiter, BuiltinAutomationTools, scopedTools } from '../../src/automation/tools.js'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { defaultConfig, type AppConfig } from '../../src/config.js'

function setup(): { store: Store; engine: Engine; tools: BuiltinAutomationTools } {
  const store = new Store(':memory:')
  const config = defaultConfig()
  const engine = new Engine({ store, policy: { version: 'v1', acceptMode: 'auto', maxWorkers: 4 } as never })
  const tools = new BuiltinAutomationTools({ store, engine })
  return { store, engine, tools }
}

const scope = { automationId: 'auto_1', project: 'demo', repo: '/tmp/demo' }

describe('自动化内置工具集', () => {
  it('提供工单与事件的查询与写入能力', () => {
    const { tools } = setup()
    const names = tools.list().map(tool => tool.name).sort()
    expect(names).toEqual([
      'automation_create_event',
      'automation_create_ticket',
      'automation_get_ticket',
      'automation_list_events',
      'automation_list_tickets',
    ])
  })

  it('工单查询只返回本项目范围内的工单', () => {
    const { store, tools } = setup()
    store.insertTicket({
      id: 'tk-1', title: '范围内', threadId: 't1', source: 'feishu', chatId: 'c1', mandateId: 'm1',
      stage: 'todo', repo: '/tmp/demo', branch: 'main', prNumber: 0, prUrl: '', prState: 'none',
      createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    })
    store.insertTicket({
      id: 'tk-2', title: '范围外', threadId: 't2', source: 'feishu', chatId: 'c1', mandateId: 'm2',
      stage: 'todo', repo: '/tmp/other', branch: 'main', prNumber: 0, prUrl: '', prState: 'none',
      createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    })

    const result = tools.get('automation_list_tickets')!.handler({}, scope) as { tickets: Array<{ id: string }> }

    expect(result.tickets.map(ticket => ticket.id)).toEqual(['tk-1'])
  })

  it('读取范围外的工单被拒绝', () => {
    const { store, tools } = setup()
    store.insertTicket({
      id: 'tk-9', title: '别家的', threadId: 't9', source: 'feishu', chatId: 'c1', mandateId: 'm9',
      stage: 'todo', repo: '/tmp/other', branch: 'main', prNumber: 0, prUrl: '', prState: 'none',
      createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    })

    const result = tools.get('automation_get_ticket')!.handler({ ticket_id: 'tk-9' }, scope) as { error: string }

    expect(result.error).toBe('scope:denied')
  })

  it('创建工单会落到本自动化任务的项目上', () => {
    const { store, tools } = setup()
    const result = tools.get('automation_create_ticket')!.handler({
      title: '依赖有更新',
      detail: 'lodash 提示有新版本',
    }, scope) as { ticketId: string }

    expect(result.ticketId).toMatch(/^tk-\d+$/)
    const ticket = store.getTicket(result.ticketId)!
    expect(ticket.repo).toBe('/tmp/demo')
    expect(ticket.source).toBe('automation:auto_1')
  })

  it('事件写入走注入的入队能力', () => {
    const store = new Store(':memory:')
    const engine = new Engine({ store, policy: { version: 'v1', acceptMode: 'auto', maxWorkers: 4 } as never })
    let received: { title: string; eventType: string } | null = null
    const tools = new BuiltinAutomationTools({
      store,
      engine,
      ingestEvent: input => {
        received = input
        return 'evt_1'
      },
    })

    const result = tools.get('automation_create_event')!.handler({
      title: '发现异常',
      body: '构建失败',
      event_type: 'automation.build.failed',
    }, scope) as { eventId: string }

    expect(result.eventId).toBe('evt_1')
    expect(received!.eventType).toBe('automation.build.failed')
  })

  it('没有事件写入能力时明确报错', () => {
    const { tools } = setup()
    const result = tools.get('automation_create_event')!.handler({
      title: 'x', body: 'y', event_type: 'automation.x',
    }, scope) as { error: string }

    expect(result.error).toBe('operator:unavailable')
  })

  it('事件查询只返回本任务或本项目范围内的事件', () => {
    const { store, tools } = setup()
    const event = (id: string, sourceId: string, context?: Record<string, string>) => ({
      id,
      sourceId,
      sourceKind: 'automation',
      externalId: id,
      title: id,
      body: id,
      ...(context ? { context } : {}),
      receivedAt: '2026-11-01T00:00:00.000Z',
      status: 'pending' as const,
      execution: 'none' as const,
      priority: 'P3' as const,
      eventType: 'automation.demo',
      needsReview: false,
      attempts: 0,
      updatedAt: '2026-11-01T00:00:00.000Z',
    })
    store.insertEvent(event('evt_own', 'automation:auto_1'))
    store.insertEvent(event('evt_project', 'github', { repo: '/tmp/demo' }))
    store.insertEvent(event('evt_other', 'github', { repo: '/tmp/other' }))
    store.insertEvent(event('evt_unbound', 'github'))

    const result = tools.get('automation_list_events')!.handler({}, scope) as { events: Array<{ id: string }> }

    expect(result.events.map(item => item.id).sort()).toEqual(['evt_own', 'evt_project'])
  })

  it('绑定范围后工具仍共享同一份定义', () => {
    const { tools } = setup()
    const scoped = scopedTools(tools, scope)
    expect(scoped).toHaveLength(tools.list().length)
    expect(scoped[0]!.name).toBe(tools.list()[0]!.name)
  })

  it('同一任务超过限流后拒绝调用', () => {
    const { tools } = setup()
    const limiter = new AutomationRateLimiter({ windowMs: 60_000, max: 1 })
    const scoped = scopedTools(tools, scope, { limiter, now: () => 1_000 })
    const tool = scoped.find(item => item.name === 'automation_list_tickets')!

    expect((tool.handler({}, scope) as { count: number }).count).toBe(0)
    expect(tool.handler({}, scope)).toEqual(expect.objectContaining({ error: 'rate:limited' }))
  })
})
