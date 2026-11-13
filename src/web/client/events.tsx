/**
 * 面板「事件」页。
 *
 * 三块内容：事件队列（TODO 面板）、统一待审核列表（需求终审 + 事件审核同页）、
 * 成本闸门（时间窗与预算）。样式全部走 app.css 已有的 token 与组件类。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getJson, sendJson } from './api.js'
import { Icon } from './icons.js'

/** 队列里的一条事件（队列投影 + 事件本体）。 */
export interface EventRow {
  queue: {
    eventId: string
    lane: string
    priority: number
    tier: string
    state: string
    reason?: string
    decidedBy?: string
    notBefore?: string
    ticketId?: string
    attempts: number
    createdAt: string
    updatedAt: string
  }
  event: {
    id: string
    source: string
    type: string
    subject: string
    summary: string
    link?: string
    actorName: string
    actorType: string
    project?: string
    priorityHint: number
    costClass: string
    receivedAt: string
  } | null
}

/** 统一待审核列表的一项。 */
export interface ReviewItem {
  kind: 'intake' | 'event'
  id: string
  title: string
  summary: string
  source?: string
  actorName: string
  project: string
  priority?: number
  reason?: string
  status: string
  updatedAt: string
}

/** 事件总线配置。 */
export interface EventConfigView {
  enabled: boolean
  sources: {
    id: string
    type: string
    mode: string
    repos: string[]
    labels: string[]
    state: string
    intervalMs: number
    cron: string
    path: string
    secretRef: string
    notifyChat: string
    project: string
    priorityHint: number
    costClass: string
    lane: string
  }[]
  windows: { id: string; from: string; to: string; allow: string[]; batch?: boolean }[]
  budget: { dailyTokens: number; dailyEvents: number }
  maxQueueDepth: number
  approvers: string[]
  notifyChat: string
}

const TIER_LABEL: Record<string, string> = {
  t0: 'T0 直派',
  t1: 'T1 待审',
  t2: 'T2 归档',
  t3: 'T3 丢弃',
}

const STATE_LABEL: Record<string, string> = {
  queued: '排队中',
  triaged: '已判定',
  ready: '待派发',
  dispatched: '已派发',
  pending_review: '待审核',
  deferred: '已延后',
  dropped: '已丢弃',
  expired: '已过期',
  archived: '已归档',
}

const STATE_TONE: Record<string, string> = {
  queued: 'cold',
  triaged: 'cold',
  ready: 'mixed',
  dispatched: 'hot',
  pending_review: 'dirty',
  deferred: 'mixed',
  dropped: 'cold',
  expired: 'cold',
  archived: 'cold',
}

const COST_LABEL: Record<string, string> = {
  free: '免费',
  cheap: '低成本',
  llm: '模型',
  heavy: '高成本',
}

/** 等待时长：人看得懂的口语。 */
function waitLabel(from: string): string {
  const ms = Date.now() - Date.parse(from)
  if (!Number.isFinite(ms) || ms < 0) return '刚刚'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时`
  return `${Math.floor(hours / 24)} 天`
}

export function EventsView(): JSX.Element {
  const [rows, setRows] = useState<EventRow[]>([])
  const [review, setReview] = useState<ReviewItem[]>([])
  const [stats, setStats] = useState<{ byState: Record<string, number>; byTier: Record<string, number> } | null>(null)
  const [config, setConfig] = useState<EventConfigView | null>(null)
  const [tier, setTier] = useState('')
  const [source, setSource] = useState('')
  const [state, setState] = useState('')
  const [keyword, setKeyword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback((): void => {
    const query = new URLSearchParams()
    if (tier) query.set('tier', tier)
    if (source) query.set('source', source)
    if (state) query.set('state', state)
    if (keyword.trim()) query.set('q', keyword.trim())
    void getJson<{ events: EventRow[] }>(`/api/events?${query.toString()}`)
      .then(data => setRows(data.events))
      .catch(err => setError(String(err)))
    void getJson<{ items: ReviewItem[] }>('/api/review')
      .then(data => setReview(data.items))
      .catch(err => setError(String(err)))
    void getJson<{ stats: { byState: Record<string, number>; byTier: Record<string, number> } }>('/api/events/stats')
      .then(data => setStats(data.stats))
      .catch(() => undefined)
    void getJson<{ event: EventConfigView }>('/api/events/config')
      .then(data => setConfig(data.event))
      .catch(() => undefined)
  }, [tier, source, state, keyword])

  useEffect(() => {
    load()
    const timer = setInterval(load, 5_000)
    return () => clearInterval(timer)
  }, [load])

  const act = useCallback(async (id: string, action: 'dispatch' | 'reject' | 'defer'): Promise<void> => {
    try {
      await sendJson(`/api/events/${id}/${action}`, 'POST', {})
      setNotice(action === 'dispatch' ? '已派发' : action === 'reject' ? '已驳回' : '已延后')
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [load])

  const sources = useMemo(() => Array.from(new Set(rows.map(row => row.event?.source ?? '').filter(Boolean))), [rows])
  const pending = stats?.byState?.pending_review ?? 0
  const dispatched = stats?.byState?.dispatched ?? 0
  const deferred = stats?.byState?.deferred ?? 0

  return (
    <>
      <div className="page-head">
        <div>
          <h1>事件</h1>
          <p className="page-sub">所有来源的事件进同一个队列池，由判定层决定直派、待审还是归档。</p>
        </div>
      </div>

      {error && <div className="banner danger"><Icon name="alert" />{error}</div>}
      {notice && <div className="banner ok"><Icon name="check" />{notice}</div>}

      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-label">待审核</span>
          <strong className={`stat-value ${pending > 0 ? 'ok' : 'muted'}`}>{pending}</strong>
        </div>
        <div className="stat-card">
          <span className="stat-label">已派发</span>
          <strong className="stat-value">{dispatched}</strong>
        </div>
        <div className="stat-card">
          <span className="stat-label">延后中</span>
          <strong className="stat-value muted">{deferred}</strong>
        </div>
        <div className="stat-card">
          <span className="stat-label">队列总数</span>
          <strong className="stat-value">{stats ? Object.values(stats.byState).reduce((sum, n) => sum + n, 0) : '—'}</strong>
        </div>
      </div>

      <section className="settings-card">
        <header className="settings-head">
          <div>
            <h2>事件队列</h2>
            <p>按优先级筛选；来源只决定基线优先级，直派还是待审由判定结论决定。</p>
          </div>
          <div className="settings-badges">
            <button className="btn ghost tiny" onClick={load}><Icon name="refresh" size={13} />刷新</button>
          </div>
        </header>

        <div className="event-filters">
          <div className="segmented">
            <button className={tier === '' ? 'active' : ''} onClick={() => setTier('')}>全部</button>
            {Object.keys(TIER_LABEL).map(key => (
              <button key={key} className={tier === key ? 'active' : ''} onClick={() => setTier(key)}>{key.toUpperCase()}</button>
            ))}
          </div>
          <select className="text-input" value={source} onChange={event => setSource(event.target.value)}>
            <option value="">全部来源</option>
            {sources.map(item => <option key={item} value={item}>{item}</option>)}
          </select>
          <select className="text-input" value={state} onChange={event => setState(event.target.value)}>
            <option value="">全部状态</option>
            {Object.keys(STATE_LABEL).map(key => <option key={key} value={key}>{STATE_LABEL[key]}</option>)}
          </select>
          <input
            className="text-input"
            placeholder="搜索摘要或对象"
            value={keyword}
            onChange={event => setKeyword(event.target.value)}
          />
        </div>

        {rows.length === 0 ? (
          <p className="editor-empty">队列里还没有事件。</p>
        ) : (
          <table className="data-table event-table">
            <thead>
              <tr>
                <th>档位</th>
                <th>来源</th>
                <th>摘要</th>
                <th>项目</th>
                <th>状态</th>
                <th>等待</th>
                <th>判定依据</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.queue.eventId}>
                  <td><span className={`tier-pill tier-${row.queue.tier || 't3'}`}>{row.queue.tier ? row.queue.tier.toUpperCase() : '—'}</span></td>
                  <td className="mono">{row.event?.source ?? '—'}</td>
                  <td className="event-cell-summary">
                    <div className="event-summary">{row.event?.summary ?? row.queue.eventId}</div>
                    <div className="event-subject mono">{row.event?.subject ?? ''}</div>
                  </td>
                  <td className="mono">{row.event?.project ?? <span className="muted">未绑定</span>}</td>
                  <td><span className={`badge ${STATE_TONE[row.queue.state] ?? 'cold'}`}>{STATE_LABEL[row.queue.state] ?? row.queue.state}</span></td>
                  <td className="muted">{waitLabel(row.queue.createdAt)}</td>
                  <td className="muted mono">{row.queue.reason ?? '—'}</td>
                  <td>
                    <div className="row-actions">
                      {row.queue.state === 'pending_review' ? (
                        <>
                          <button className="btn tiny" onClick={() => void act(row.queue.eventId, 'dispatch')}>批准</button>
                          <button className="btn tiny danger" onClick={() => void act(row.queue.eventId, 'reject')}>驳回</button>
                        </>
                      ) : row.queue.state === 'deferred' ? (
                        <button className="btn tiny" onClick={() => void act(row.queue.eventId, 'dispatch')}>立即处理</button>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="settings-card">
        <header className="settings-head">
          <div>
            <h2>待审核</h2>
            <p>需求终审与事件审核在同一张列表里处理，行为一致。</p>
          </div>
          <span className="badge dirty">{review.length} 项</span>
        </header>
        {review.length === 0 ? (
          <p className="editor-empty">没有待审核的条目。</p>
        ) : (
          <table className="data-table event-table">
            <thead>
              <tr>
                <th>类型</th>
                <th>摘要</th>
                <th>发起人</th>
                <th>项目</th>
                <th>判定建议</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {review.map(item => (
                <tr key={`${item.kind}-${item.id}`}>
                  <td><span className={`badge ${item.kind === 'event' ? 'mixed' : 'cold'}`}>{item.kind === 'event' ? '事件' : '需求'}</span></td>
                  <td><div className="event-summary">{item.summary || item.title}</div></td>
                  <td>{item.actorName || <span className="muted">—</span>}</td>
                  <td className="mono">{item.project || <span className="muted">未绑定</span>}</td>
                  <td className="muted mono">{item.reason ?? (item.kind === 'intake' ? '需求终审' : '—')}</td>
                  <td>
                    {item.kind === 'event' ? (
                      <div className="row-actions">
                        <button className="btn tiny" onClick={() => void act(item.id, 'dispatch')}>批准派单</button>
                        <button className="btn tiny danger" onClick={() => void act(item.id, 'reject')}>驳回</button>
                        <button className="btn tiny ghost" onClick={() => void act(item.id, 'defer')}>延后</button>
                      </div>
                    ) : (
                      <span className="muted">在飞书里处理</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <EventGateCard config={config} onSaved={() => { setNotice('成本闸门已保存'); load() }} onError={setError} />
    </>
  )
}

/** 成本闸门：时间窗与预算，改完立即生效。 */
function EventGateCard({ config, onSaved, onError }: {
  config: EventConfigView | null
  onSaved: () => void
  onError: (message: string | null) => void
}): JSX.Element {
  const [draft, setDraft] = useState<EventConfigView | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDraft(config)
  }, [config])

  if (!draft) return <section className="settings-card"><p className="editor-empty">正在读取成本闸门配置…</p></section>

  const update = (patch: Partial<EventConfigView>): void => {
    setDraft({ ...draft, ...patch })
  }
  const updateWindow = (index: number, patch: Partial<EventConfigView['windows'][number]>): void => {
    const windows = draft.windows.map((window, position) => position === index ? { ...window, ...patch } : window)
    update({ windows })
  }
  const save = async (): Promise<void> => {
    setSaving(true)
    onError(null)
    try {
      await sendJson('/api/events/config', 'PUT', {
        'event.budget.dailyTokens': draft.budget.dailyTokens,
        'event.budget.dailyEvents': draft.budget.dailyEvents,
        'event.windows': draft.windows,
        'event.maxQueueDepth': draft.maxQueueDepth,
        'event.notifyChat': draft.notifyChat,
      })
      onSaved()
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-card">
      <header className="settings-head">
        <div>
          <h2>成本闸门</h2>
          <p>时间窗留空表示一直放行；预算填 0 表示不限制。</p>
        </div>
        <div className="settings-badges">
          <button className="btn primary tiny" onClick={() => void save()} disabled={saving}>保存</button>
        </div>
      </header>

      <div className="meta-card flush">
        <div className="meta-item">
          <span className="meta-label">每日 token 上限</span>
          <input
            className="text-input"
            type="number"
            min={0}
            value={draft.budget.dailyTokens}
            onChange={event => update({ budget: { ...draft.budget, dailyTokens: Number(event.target.value) } })}
          />
        </div>
        <div className="meta-item">
          <span className="meta-label">每日事件数上限</span>
          <input
            className="text-input"
            type="number"
            min={0}
            value={draft.budget.dailyEvents}
            onChange={event => update({ budget: { ...draft.budget, dailyEvents: Number(event.target.value) } })}
          />
        </div>
        <div className="meta-item">
          <span className="meta-label">队列深度上限</span>
          <input
            className="text-input"
            type="number"
            min={1}
            value={draft.maxQueueDepth}
            onChange={event => update({ maxQueueDepth: Number(event.target.value) })}
          />
        </div>
        <div className="meta-item">
          <span className="meta-label">审核通知群</span>
          <input
            className="text-input"
            value={draft.notifyChat}
            placeholder="群 chat_id，留空则只在面板可见"
            onChange={event => update({ notifyChat: event.target.value })}
          />
        </div>
      </div>

      <div className="settings-rows">
        <table className="data-table event-table">
          <thead>
            <tr>
              <th>时间窗</th>
              <th>开始</th>
              <th>结束</th>
              <th>放行档位</th>
              <th>批量</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {draft.windows.map((window, index) => (
              <tr key={window.id}>
                <td><input className="text-input" value={window.id} onChange={event => updateWindow(index, { id: event.target.value })} /></td>
                <td><input className="text-input" value={window.from} onChange={event => updateWindow(index, { from: event.target.value })} /></td>
                <td><input className="text-input" value={window.to} onChange={event => updateWindow(index, { to: event.target.value })} /></td>
                <td>
                  <div className="row-actions">
                    {Object.keys(TIER_LABEL).map(key => (
                      <label key={key} className="tier-check">
                        <input
                          type="checkbox"
                          checked={window.allow.includes(key)}
                          onChange={event => updateWindow(index, {
                            allow: event.target.checked
                              ? [...window.allow, key]
                              : window.allow.filter(item => item !== key),
                          })}
                        />
                        {key.toUpperCase()}
                      </label>
                    ))}
                  </div>
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={Boolean(window.batch)}
                    onChange={event => updateWindow(index, { batch: event.target.checked })}
                  />
                </td>
                <td>
                  <button
                    className="btn tiny danger"
                    onClick={() => update({ windows: draft.windows.filter((_, position) => position !== index) })}
                  ><Icon name="trash" size={13} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="editor-foot event-window-foot">
          <button
            className="btn add"
            onClick={() => update({ windows: [...draft.windows, { id: `window-${draft.windows.length + 1}`, from: '09:00', to: '20:00', allow: ['t0', 't1'] }] })}
          ><Icon name="plus" size={13} />添加时间窗</button>
          <span className="muted">留空 = 一直放行。</span>
        </div>
      </div>
    </section>
  )
}
