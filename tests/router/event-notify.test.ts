import { describe, expect, it } from 'vitest'
import { Store, type EventQueueRecord, type EventRecord } from '../../src/store/db.js'
import { defaultConfig } from '../../src/config.js'
import { notifyEventReview } from '../../src/router/event-runtime.js'

const NOW = '2026-11-14T02:00:00.000Z'

function eventRecord(over: Partial<EventRecord> = {}): EventRecord {
  return {
    id: 'ev_1',
    source: 'github-issues',
    type: 'issue.updated',
    externalId: 'blankPen/router-agent#12',
    lane: 'repo:blankPen/router-agent',
    subject: 'blankPen/router-agent#12',
    summary: '导出功能偶发失败，需要修复',
    link: 'https://github.com/blankPen/router-agent/issues/12',
    actorId: 'ghost',
    actorName: '外部用户',
    actorType: 'external',
    project: 'router-agent',
    priorityHint: 70,
    costClass: 'cheap',
    hops: 0,
    receivedAt: NOW,
    ...over,
  }
}

function queueRecord(over: Partial<EventQueueRecord> = {}): EventQueueRecord {
  return {
    eventId: 'ev_1',
    lane: 'repo:blankPen/router-agent',
    priority: 78,
    tier: 't1',
    state: 'pending_review',
    reason: 'event:needs-human',
    decidedBy: 'jev',
    attempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

function logsOf(): { info: (event: string, fields?: Record<string, unknown>) => void; warn: (event: string, fields?: Record<string, unknown>) => void; error: (event: string, fields?: Record<string, unknown>) => void } {
  return { info: () => {}, warn: () => {}, error: () => {} }
}

describe('待审核事件的通知', () => {
  it('推送一张带批准与驳回按钮的卡片', () => {
    const store = new Store(':memory:')
    const config = defaultConfig()
    config.event.notifyChat = 'oc_ops'

    notifyEventReview(store, config, { now: () => NOW }, logsOf(), eventRecord(), queueRecord())

    const items = store.listOutbox(10)
    expect(items).toHaveLength(1)
    const item = items[0]!
    expect(item.channelId).toBe('oc_ops')
    const card = item.blocks?.find(block => block.type === 'card')
    expect(card).toBeDefined()
    if (card?.type !== 'card') throw new Error('card block missing')
    expect(card.fields?.map(field => field.label)).toEqual(['来源', '对象', '优先级', '判定依据'])
    expect(card.actions?.map(action => action.label)).toEqual(['批准派单', '驳回'])
    expect(card.actions?.[0]?.value).toEqual({ eventAction: 'approve', eventId: 'ev_1' })
    expect(card.actions?.[1]?.value).toEqual({ eventAction: 'reject', eventId: 'ev_1' })
    // 卡片降级成纯文本时内容不能丢。
    expect(item.text).toContain('导出功能偶发失败')
  })

  it('来源自己配的通知群优先于全局通知群', () => {
    const store = new Store(':memory:')
    const config = defaultConfig()
    config.event.notifyChat = 'oc_global'
    config.event.sources = [{
      id: 'github-issues', type: 'github', mode: 'poll', repos: [], labels: [], state: 'open',
      intervalMs: 600_000, cron: '', path: '', secretRef: '', notifyChat: 'oc_source',
      project: 'router-agent', priorityHint: 70, costClass: 'cheap', lane: '',
    }]

    notifyEventReview(store, config, { now: () => NOW }, logsOf(), eventRecord(), queueRecord())

    expect(store.listOutbox(10)[0]?.channelId).toBe('oc_source')
  })

  it('没配通知群时只在面板可见，不发消息', () => {
    const store = new Store(':memory:')
    const config = defaultConfig()
    notifyEventReview(store, config, { now: () => NOW }, logsOf(), eventRecord(), queueRecord())
    expect(store.listOutbox(10)).toHaveLength(0)
  })

  it('同一来源的普通事件在十分钟内合并成一条通知', () => {
    const store = new Store(':memory:')
    const config = defaultConfig()
    config.event.notifyChat = 'oc_ops'

    notifyEventReview(store, config, { now: () => NOW }, logsOf(), eventRecord(), queueRecord())
    notifyEventReview(store, config, { now: () => NOW }, logsOf(), eventRecord({ id: 'ev_2', externalId: 'ext-2' }), queueRecord({ eventId: 'ev_2' }))

    expect(store.listOutbox(10)).toHaveLength(1)
  })

  it('高优先级事件单独通知，不参与合并', () => {
    const store = new Store(':memory:')
    const config = defaultConfig()
    config.event.notifyChat = 'oc_ops'

    notifyEventReview(store, config, { now: () => NOW }, logsOf(), eventRecord(), queueRecord({ priority: 92 }))
    notifyEventReview(store, config, { now: () => NOW }, logsOf(), eventRecord({ id: 'ev_2', externalId: 'ext-2' }), queueRecord({ eventId: 'ev_2', priority: 92 }))

    expect(store.listOutbox(10)).toHaveLength(2)
  })

  it('静默时段内的通知推迟到时段结束再发', () => {
    const store = new Store(':memory:')
    const config = defaultConfig()
    config.event.notifyChat = 'oc_ops'
    // 静默时段按本地时钟拼，保证任何时区下 NOW 都落在时段里。
    const localHour = new Date(NOW).getHours()
    const clock = (hour: number): string => `${String(hour % 24).padStart(2, '0')}:00`
    config.event.notifyQuietHours = { from: clock(localHour), to: clock(localHour + 2) }

    notifyEventReview(store, config, { now: () => NOW }, logsOf(), eventRecord(), queueRecord())

    const item = store.listOutbox(10)[0]!
    expect(Date.parse(item.nextAt)).toBeGreaterThan(Date.parse(NOW))
    expect(new Date(item.nextAt).getHours()).toBe((localHour + 2) % 24)
  })

  it('不在静默时段时立即可发', () => {
    const store = new Store(':memory:')
    const config = defaultConfig()
    config.event.notifyChat = 'oc_ops'
    const localHour = new Date(NOW).getHours()
    const clock = (hour: number): string => `${String(hour % 24).padStart(2, '0')}:00`
    config.event.notifyQuietHours = { from: clock(localHour + 2), to: clock(localHour + 4) }

    notifyEventReview(store, config, { now: () => NOW }, logsOf(), eventRecord(), queueRecord())

    expect(store.listOutbox(10)[0]?.nextAt).toBe(NOW)
  })
})
