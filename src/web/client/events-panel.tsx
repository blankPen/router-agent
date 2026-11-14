/**
 * 事件面板：只做两件事——把事件看清楚、把决定做出来。
 *
 * 来源订阅与判定策略属于配置，去「配置 → 事件总线」里改；
 * 这里保留队列、筛选与人工审核。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getJson, sendJson } from './api.js'
import { Icon } from './icons.js'

interface EventRow {
  id: string
  sourceId: string
  sourceKind: string
  externalId: string
  title: string
  body: string
  url?: string
  receivedAt: string
  status: string
  execution: string
  priority: string
  eventType: string
  project?: string
  skill?: string
  needsReview: boolean
  reason?: string
  confidence?: number
  ticketId?: string
  updatedAt: string
}

interface EventsPayload {
  events: EventRow[]
}

const PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4']

const STATUS_FILTERS = [
  { value: 'review', label: '待审核' },
  { value: 'pending', label: '待处理' },
  { value: 'done', label: '已完成' },
  { value: 'invalid', label: '无效' },
]

const STATUS_LABEL: Record<string, string> = {
  pending: '待处理',
  review: '待审核',
  done: '已完成',
  invalid: '无效',
}

const STATUS_TEXT: Record<string, string> = {
  none: '',
  deferred: '已顺延',
  retry: '待重试',
  failed: '执行失败',
}

/** 事件面板。 */
export function EventsView(): JSX.Element {
  const [events, setEvents] = useState<EventRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [priority, setPriority] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await getJson<EventsPayload>('/api/events')
      setEvents(data.events ?? [])
      setLoaded(true)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => { void load() }, 10_000)
    return () => clearInterval(timer)
  }, [load])

  const visible = useMemo(() => events.filter(event =>
    (!priority || event.priority === priority)
    && (!status || event.status === status)), [events, priority, status])

  const counts = useMemo(() => ({
    pending: events.filter(item => item.status === 'pending').length,
    review: events.filter(item => item.status === 'review').length,
    done: events.filter(item => item.status === 'done').length,
    invalid: events.filter(item => item.status === 'invalid').length,
  }), [events])

  const updatedAt = useMemo(() => {
    const latest = events.reduce<string>((acc, item) => (item.updatedAt > acc ? item.updatedAt : acc), '')
    return latest ? formatTime(latest) : '—'
  }, [events])

  const act = async (eventId: string, action: string) => {
    setBusy(true)
    try {
      await sendJson(`/api/events/${encodeURIComponent(eventId)}/action`, 'POST', { action })
      setNotice(action === 'approve' ? '已批准，事件已派发' : '已提交操作')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!loaded) return <div className="empty-state tall"><p>正在读取事件队列…</p></div>

  return (
    <>
      <div className="page-head">
        <div>
          <h1>事件</h1>
          <p>所有来源的事件先进同一个队列，判定后分级派发：能自动做的直接开单，需要人决定的在这里处理。</p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={() => { window.location.hash = '#config' }}>来源与策略</button>
          <button className="btn" onClick={() => void load()} disabled={busy}>刷新</button>
        </div>
      </div>

      {error && <div className="banner danger"><Icon name="alert" />{error}</div>}
      {notice && <div className="banner" onClick={() => setNotice(null)}>{notice}</div>}

      <section className="event-summary">
        <div className="event-summary-cell">
          <span className="event-summary-label">待审核</span>
          <strong className={`event-summary-value ${counts.review > 0 ? 'attention' : ''}`}>{counts.review}</strong>
        </div>
        <div className="event-summary-cell">
          <span className="event-summary-label">待处理</span>
          <strong className="event-summary-value">{counts.pending}</strong>
        </div>
        <div className="event-summary-cell">
          <span className="event-summary-label">已完成</span>
          <strong className="event-summary-value">{counts.done}</strong>
        </div>
        <div className="event-summary-cell">
          <span className="event-summary-label">无效</span>
          <strong className="event-summary-value">{counts.invalid}</strong>
        </div>
        <div className="event-summary-cell quiet">
          <span className="event-summary-label">最近更新</span>
          <strong className="event-summary-time">{updatedAt}</strong>
        </div>
      </section>

      <div className="event-filters">
        <div className="event-filter-group">
          <span className="event-filter-label">优先级</span>
          <button className={`event-chip ${priority === '' ? 'active' : ''}`} onClick={() => setPriority('')}>全部</button>
          {PRIORITIES.map(item => (
            <button
              key={item}
              className={`event-chip ${priority === item ? 'active' : ''}`}
              onClick={() => setPriority(current => (current === item ? '' : item))}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="event-filter-group">
          <span className="event-filter-label">状态</span>
          {STATUS_FILTERS.map(item => (
            <button
              key={item.value}
              className={`event-chip ${status === item.value ? 'active' : ''}`}
              onClick={() => setStatus(current => (current === item.value ? '' : item.value))}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="empty-state">
          <p>{events.length === 0 ? '队列里还没有事件。' : '没有符合筛选条件的事件。'}</p>
          {events.length === 0 && <p className="muted">来源订阅与判定策略在「配置 → 事件总线」里设置。</p>}
        </div>
      ) : (
        <table className="event-table">
          <thead>
            <tr>
              <th className="event-col-priority">优先级</th>
              <th>事件</th>
              <th>判定</th>
              <th>状态</th>
              <th className="event-col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(event => (
              <tr key={event.id} className={event.status === 'review' ? 'is-review' : undefined}>
                <td><span className={`event-priority p${event.priority.slice(1)}`}>{event.priority}</span></td>
                <td>
                  <strong className="event-title">{event.title}</strong>
                  <div className="event-meta">
                    <span>{event.sourceId}</span>
                    <span className="dot-sep">·</span>
                    <span>{event.eventType || 'event'}</span>
                    <span className="dot-sep">·</span>
                    <span>{formatTime(event.receivedAt)}</span>
                  </div>
                  {event.body && <div className="event-excerpt">{excerpt(event.body)}</div>}
                </td>
                <td>
                  <div className="event-verdict">
                    {event.project ? <span className="event-project">{event.project}</span> : <span className="muted">未判定项目</span>}
                    {event.skill && <span className="event-skill">{event.skill}</span>}
                  </div>
                  {event.reason && <div className="event-reason">{event.reason}</div>}
                  {typeof event.confidence === 'number' && (
                    <div className="muted">置信度 {event.confidence.toFixed(2)}</div>
                  )}
                </td>
                <td>
                  <span className={`event-status s-${event.status}`}>
                    <i aria-hidden="true" />
                    {STATUS_LABEL[event.status] ?? event.status}
                  </span>
                  {STATUS_TEXT[event.execution] && <div className="muted">{STATUS_TEXT[event.execution]}</div>}
                  {event.ticketId && <div className="muted">工单 {event.ticketId}</div>}
                </td>
                <td className="event-col-actions">
                  <div className="event-actions">
                    {event.status === 'review' && (
                      <>
                        <button className="btn primary" disabled={busy} onClick={() => void act(event.id, 'approve')}>批准</button>
                        <button className="btn ghost" disabled={busy} onClick={() => void act(event.id, 'reject')}>驳回</button>
                        <button className="btn ghost" disabled={busy} onClick={() => void act(event.id, 'defer')}>延后</button>
                      </>
                    )}
                    {event.status === 'pending' && !event.ticketId && (
                      <button className="btn" disabled={busy} onClick={() => void act(event.id, 'retry')}>重试</button>
                    )}
                    {event.status !== 'done' && event.status !== 'invalid' && (
                      <button className="btn ghost" disabled={busy} onClick={() => void act(event.id, 'ignore')}>忽略</button>
                    )}
                    {event.url && (
                      <a className="btn ghost" href={event.url} target="_blank" rel="noreferrer">原文</a>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

/** 正文摘要：只留一行，避免长文本把表格撑开。 */
function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat
}

/** 时间显示：到分钟。 */
function formatTime(value: string): string {
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return value
  return at.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
