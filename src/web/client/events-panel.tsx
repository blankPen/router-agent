/**
 * 收件箱（事件队列）：只做两件事——把事件看清楚、把决定做出来。
 *
 * 来源订阅与判定策略属于配置，去「配置 → 事件总线」里改；
 * 这里保留队列、筛选与人工审核。页签标识仍是 `events`，深链不变。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getJson, sendJson } from './api.js'
import { Icon } from './icons.js'
import { approvePayload, needsProjectForApprove, projectOptions, type ProjectOption } from './events-model.js'

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
  /** 命中的订阅 id（等于自动化任务 id）。 */
  subscriptionId?: string
  ticketId?: string
  updatedAt: string
}

/** 订阅命中分布的一行：按任务聚合。 */
interface SubscriptionHit {
  id: string
  taskName: string
  source: string
  types: string[]
  mode: string
}

interface EventsPayload {
  events: EventRow[]
  /** 候选项目：人工批准时挑归属项目用。 */
  projects?: ProjectOption[]
  /** 按状态统计的条数；缺省时回退到列表里数（老服务端）。 */
  counts?: Record<string, number>
  /** 按订阅（= 任务）聚合的命中分布。 */
  ruleStats?: Record<string, Record<string, number>>
  /** 订阅清单：拿任务名与处理模式用。 */
  subscriptions?: SubscriptionHit[]
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
  notified: '已通知',
}

/** 处理方式标签：三种去向用不同色。 */
const MODE_LABEL: Record<string, string> = {
  auto: '自动执行',
  review: '待人审',
  notify: '仅提醒',
}

const MODE_CLASS: Record<string, string> = {
  auto: 'tag mode-auto',
  review: 'tag mode-review',
  notify: 'tag mode-notify',
}

/** 收件箱。 */
export function EventsView(): JSX.Element {
  const [events, setEvents] = useState<EventRow[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [serverCounts, setServerCounts] = useState<Record<string, number> | null>(null)
  const [subscriptions, setSubscriptions] = useState<SubscriptionHit[]>([])
  const [ruleStats, setRuleStats] = useState<Record<string, Record<string, number>>>({})
  const [picking, setPicking] = useState<EventRow | null>(null)
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
      setProjects(data.projects ?? [])
      setServerCounts(data.counts ?? null)
      setSubscriptions(data.subscriptions ?? [])
      setRuleStats(data.ruleStats ?? {})
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
    pending: serverCounts?.pending ?? events.filter(item => item.status === 'pending').length,
    review: serverCounts?.review ?? events.filter(item => item.status === 'review').length,
    done: serverCounts?.done ?? events.filter(item => item.status === 'done').length,
    invalid: serverCounts?.invalid ?? events.filter(item => item.status === 'invalid').length,
    notified: events.filter(item => item.execution === 'notified').length,
  }), [events, serverCounts])

  const updatedAt = useMemo(() => {
    const latest = events.reduce<string>((acc, item) => (item.updatedAt > acc ? item.updatedAt : acc), '')
    return latest ? formatTime(latest) : '—'
  }, [events])

  const act = async (eventId: string, action: string, project?: string) => {
    setBusy(true)
    try {
      const body = action === 'approve' ? approvePayload(project ?? '') : { action }
      const data = await sendJson<{ event?: EventRow }>(`/api/events/${encodeURIComponent(eventId)}/action`, 'POST', body)
      setNotice(noticeOf(action, data.event))
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // 批准前先补归属项目：没项目开不出单，直接批准会原地不动。
  const approve = (event: EventRow) => {
    if (needsProjectForApprove(event)) {
      setPicking(event)
      return
    }
    void act(event.id, 'approve', event.project)
  }

  if (!loaded) return <div className="empty-state tall"><p>正在读取事件队列…</p></div>

  return (
    <>
      <div className="page-head">
        <div>
          <h1>收件箱</h1>
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
          <span className="event-summary-label">已通知</span>
          <strong className="event-summary-value">{counts.notified}</strong>
        </div>
        <div className="event-summary-cell">
          <span className="event-summary-label">已完成</span>
          <strong className="event-summary-value">{counts.done}</strong>
        </div>
        <div className="event-summary-cell">
          <span className="event-summary-label">已过滤</span>
          <strong className="event-summary-value">{counts.invalid}</strong>
        </div>
        <div className="event-summary-cell quiet">
          <span className="event-summary-label">最近更新</span>
          <strong className="event-summary-time">{updatedAt}</strong>
        </div>
      </section>

      {subscriptions.length > 0 && (
        <section className="event-rule-distribution">
          <div className="event-rule-head">
            <div>
              <h2>订阅命中</h2>
              <p>按自动化任务统计；长期 0 命中的任务，多半是事件类型或关键词订错了。</p>
            </div>
          </div>
          <div className="event-rule-list">
            {subscriptions.map(subscription => {
              const stats = ruleStats[subscription.id] ?? {}
              const pending = stats.pending ?? 0
              const review = stats.review ?? 0
              const done = stats.done ?? 0
              const invalid = stats.invalid ?? 0
              const valid = pending + review + done
              const total = valid + invalid
              return (
                <div key={subscription.id} className="event-rule-row">
                  <div className="event-rule-name">
                    <strong>{subscription.taskName}</strong>
                    <span>{subscription.source} · {subscription.types.join('、') || '未指定类型'}</span>
                  </div>
                  <span className={MODE_CLASS[subscription.mode] ?? 'tag'}>{MODE_LABEL[subscription.mode] ?? subscription.mode}</span>
                  {total === 0 ? (
                    <span className="muted">尚未命中</span>
                  ) : (
                    <div className="event-rule-counts">
                      <span>有效 {valid}</span>
                      <span>人审 {review}</span>
                      <span>仅提醒 {done}</span>
                      <span className="quiet">合计 {total}</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

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
              <th>归属</th>
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
                    {event.subscriptionId && <><span className="dot-sep">·</span><span>{event.subscriptionId}</span></>}
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
                        <button className="btn primary" disabled={busy} onClick={() => approve(event)}>批准</button>
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
      {picking && (
        <ProjectPicker
          event={picking}
          projects={projectOptions(projects)}
          busy={busy}
          onPick={project => {
            const target = picking
            setPicking(null)
            void act(target.id, 'approve', project)
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  )
}

/** 操作结果提示：没开成单要说清原因，别一律报「已派发」。 */
function noticeOf(action: string, event?: EventRow): string {
  if (action !== 'approve') return '已提交操作'
  if (event?.ticketId) return '已批准，事件已派发'
  const reason = event?.reason?.trim()
  return reason ? `已批准，但没能开单：${reason}` : '已批准，但没能开单'
}

/** 选归属项目：工单必须绑定项目，批准前先把项目定下来。 */
function ProjectPicker({ event, projects, busy, onPick, onClose }: {
  event: EventRow
  projects: ProjectOption[]
  busy: boolean
  onPick: (project: string) => void
  onClose: () => void
}): JSX.Element {
  const [project, setProject] = useState('')
  return (
    <div className="modal-layer">
      <button className="modal-backdrop" aria-label="关闭" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label="选择归属项目">
        <header className="modal-head">
          <div>
            <h3>选择归属项目</h3>
            <p>「{event.title}」还没判定出归属项目，批准前先定下派到哪个项目。</p>
          </div>
          <button className="icon-btn" title="关闭" onClick={onClose}><Icon name="close" size={14} /></button>
        </header>
        <div className="modal-body">
          {projects.length === 0 ? (
            <p className="modal-hint">还没有登记任何项目：先到「配置 → 项目配置」登记项目，再回来批准。</p>
          ) : (
            <label className="modal-field">
              <span>归属项目</span>
              <select value={project} onChange={e => setProject(e.target.value)}>
                <option value="">（请选择）</option>
                {projects.map(item => (
                  <option key={item.name} value={item.name}>{item.name}（{item.repo}）</option>
                ))}
              </select>
            </label>
          )}
        </div>
        <footer className="modal-foot">
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={busy || !project} onClick={() => onPick(project)}>批准并派发</button>
        </footer>
      </div>
    </div>
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
