import { describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import type { EventRecord, EventQueueRecord } from '../../src/store/db.js'

function store(): Store {
  return new Store(':memory:')
}

function event(over: Partial<EventRecord> = {}): EventRecord {
  return {
    id: 'ev_1',
    source: 'github-issue',
    type: 'issue.updated',
    externalId: 'blankPen/router-agent#12@2026-01-01T00:00:00Z',
    lane: 'repo:blankPen/router-agent',
    subject: 'blankPen/router-agent#12',
    summary: '导出功能偶发失败',
    actorId: 'ghost',
    actorName: 'someone',
    actorType: 'external',
    project: 'router-agent',
    priorityHint: 70,
    costClass: 'cheap',
    hops: 0,
    receivedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function queue(over: Partial<EventQueueRecord> = {}): EventQueueRecord {
  return {
    eventId: 'ev_1',
    lane: 'repo:blankPen/router-agent',
    priority: 70,
    tier: 't1',
    state: 'queued',
    reason: 'event:to-triage',
    decidedBy: 'rule',
    notBefore: '2026-01-01T00:00:00.000Z',
    attempts: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

describe('事件表', () => {
  it('同一来源同一外部 ID 只入队一次', () => {
    const db = store()
    expect(db.insertEvent(event())).toBe(true)
    expect(db.insertEvent(event({ id: 'ev_2' }))).toBe(false)
    expect(db.getEvent('ev_1')).not.toBeNull()
    db.close()
  })

  it('按来源与外部 ID 能查到事件', () => {
    const db = store()
    db.insertEvent(event())
    const found = db.getEventByKey('github-issue', 'blankPen/router-agent#12@2026-01-01T00:00:00Z')
    expect(found?.id).toBe('ev_1')
    db.close()
  })

  it('能按状态与优先级列出事件', () => {
    const db = store()
    db.insertEvent(event({ id: 'ev_a', source: 'cron', externalId: 'a' }))
    db.insertEvent(event({ id: 'ev_b', source: 'webhook', externalId: 'b' }))
    db.insertEvent(event({ id: 'ev_c', source: 'webhook', externalId: 'c' }))
    db.insertEventQueue(queue({ eventId: 'ev_a', state: 'pending_review', tier: 't1', priority: 60 }))
    db.insertEventQueue(queue({ eventId: 'ev_b', state: 'queued', tier: 't0', priority: 95 }))
    db.insertEventQueue(queue({ eventId: 'ev_c', state: 'queued', tier: 't2', priority: 40 }))

    const review = db.listEventQueue({ state: 'pending_review' })
    expect(review.map(item => item.eventId)).toEqual(['ev_a'])

    const queued = db.listEventQueue({ state: 'queued' })
    expect(queued.map(item => item.eventId)).toEqual(['ev_b', 'ev_c'])
    db.close()
  })

  it('队列状态可以更新', () => {
    const db = store()
    db.insertEvent(event())
    db.insertEventQueue(queue())
    db.updateEventQueue('ev_1', { state: 'pending_review', tier: 't1', reason: 'event:needs-human', decidedBy: 'jev' })
    const record = db.getEventQueue('ev_1')
    expect(record?.state).toBe('pending_review')
    expect(record?.decidedBy).toBe('jev')
    db.close()
  })

  it('只挑到期且优先级最高的队列项', () => {
    const db = store()
    db.insertEvent(event({ id: 'ev_a', externalId: 'a' }))
    db.insertEvent(event({ id: 'ev_b', externalId: 'b' }))
    db.insertEvent(event({ id: 'ev_c', externalId: 'c' }))
    db.insertEventQueue(queue({ eventId: 'ev_a', state: 'ready', priority: 95, notBefore: '2026-01-01T00:00:00.000Z' }))
    db.insertEventQueue(queue({ eventId: 'ev_b', state: 'ready', priority: 70, notBefore: '2026-01-01T00:00:00.000Z' }))
    db.insertEventQueue(queue({ eventId: 'ev_c', state: 'ready', priority: 99, notBefore: '2026-01-02T00:00:00.000Z' }))

    const picked = db.pickEventQueue('2026-01-01T00:00:00.000Z', 10)
    expect(picked.map(item => item.eventId)).toEqual(['ev_a', 'ev_b'])
    db.close()
  })

  it('统计各状态与各档位的事件数', () => {
    const db = store()
    db.insertEvent(event({ id: 'ev_a', externalId: 'a' }))
    db.insertEvent(event({ id: 'ev_b', externalId: 'b' }))
    db.insertEventQueue(queue({ eventId: 'ev_a', state: 'pending_review', tier: 't1' }))
    db.insertEventQueue(queue({ eventId: 'ev_b', state: 'queued', tier: 't0' }))
    const stats = db.eventQueueStats()
    expect(stats.total).toBe(2)
    expect(stats.byState['pending_review']).toBe(1)
    expect(stats.byTier['t1']).toBe(1)
    db.close()
  })

  it('队列里记下了关联工单号', () => {
    const db = store()
    db.insertEvent(event())
    db.insertEventQueue(queue())
    db.updateEventQueue('ev_1', { state: 'dispatched', ticketId: 'tk-9' })
    expect(db.getEventQueue('ev_1')?.ticketId).toBe('tk-9')
    db.close()
  })
})
