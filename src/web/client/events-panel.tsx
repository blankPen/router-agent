/**
 * 事件面板：来源订阅、事件队列、待审核与决策 prompt。
 *
 * 面板只做两件事：把事件看清楚、把决定做出来。
 * 判定依据（决策 prompt）与策略都存在服务端配置里，这里改完保存即生效。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getJson, saveConfigPatch, sendJson, type ConfigDoc } from './api.js'
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

interface EventSourceView {
  id: string
  kind: string
  enabled: boolean
  builtin: boolean
  status: string
  message?: string
  lastPolledAt?: string
  fields: Array<{ key: string; label: string; kind: string; hint?: string; options?: string[] }>
}

interface DecisionView {
  provider: string
  prompt: string
  confidenceThreshold: number
  fallback: string
  version: number
}

interface EventsPayload {
  events: EventRow[]
  sources: EventSourceView[]
  decision: DecisionView
  sourceSecrets: Record<string, boolean>
}

const PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4']
const STATUS_LABEL: Record<string, string> = {
  pending: '待处理',
  review: '待审核',
  done: '已完成',
  invalid: '无效',
}
const PRIORITY_TONE: Record<string, string> = {
  P0: 'hot',
  P1: 'mixed',
  P2: 'cold',
  P3: 'cold',
  P4: 'cold',
}

/** 事件面板。 */
export function EventsView(): JSX.Element {
  const [data, setData] = useState<EventsPayload | null>(null)
  const [config, setConfig] = useState<ConfigDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [priority, setPriority] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [editing, setEditing] = useState<EventSourceView | null>(null)

  const load = useCallback(async () => {
    try {
      const [events, bundle] = await Promise.all([
        getJson<EventsPayload>('/api/events'),
        getJson<{ config: ConfigDoc }>('/api/config'),
      ])
      setData(events)
      setConfig(bundle.config)
      setPrompt(current => (current ? current : events.decision.prompt))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => { void load() }, 10_000)
    return () => clearInterval(timer)
  }, [load])

  const visible = useMemo(() => {
    if (!data) return []
    return data.events.filter(event =>
      (!priority || event.priority === priority)
      && (!status || event.status === status))
  }, [data, priority, status])

  const stats = useMemo(() => {
    const events = data?.events ?? []
    return [
      { label: '待处理', value: String(events.filter(item => item.status === 'pending').length) },
      { label: '待审核', value: String(events.filter(item => item.status === 'review').length) },
      { label: '已完成', value: String(events.filter(item => item.status === 'done').length) },
      { label: '无效', value: String(events.filter(item => item.status === 'invalid').length) },
    ]
  }, [data])

  const act = async (eventId: string, action: string, extra: Record<string, unknown> = {}) => {
    setBusy(true)
    try {
      await sendJson(`/api/events/${encodeURIComponent(eventId)}/action`, 'POST', { action, ...extra })
      setNotice('已提交操作')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const savePrompt = async () => {
    setBusy(true)
    try {
      await saveConfigPatch({ 'events.decision.prompt': prompt })
      setNotice('决策 prompt 已保存，保存后立即生效')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const toggleSource = async (source: EventSourceView) => {
    setBusy(true)
    try {
      await saveConfigPatch({ [`events.sources.${source.id}.enabled`]: !source.enabled })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (error && !data) return <div className="banner danger"><Icon name="alert" />{error}</div>
  if (!data) return <div className="empty-state tall"><p>正在读取事件队列…</p></div>

  const reviewCount = data.events.filter(item => item.status === 'review').length

  return (
    <>
      <div className="page-head">
        <div>
          <h1>事件</h1>
          <p>多来源事件统一进队列，由决策模型判定后分级派发：能直接做的开单，需要人看的推审核。</p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => void load()} disabled={busy}>刷新</button>
        </div>
      </div>

      {error && <div className="banner danger"><Icon name="alert" />{error}</div>}
      {notice && <div className="banner" onClick={() => setNotice(null)}>{notice}</div>}

      <div className="stat-grid">
        {stats.map(stat => (
          <div key={stat.label} className="stat-card">
            <span className="stat-label">{stat.label}</span>
            <strong className="stat-value ink">{stat.value}</strong>
          </div>
        ))}
      </div>

      <section className="settings-card">
        <header className="settings-head">
          <div>
            <h2>事件来源</h2>
            <p>来源只是「从哪里收事件」；判定与派发统一由决策模型做。</p>
          </div>
          <span className="badge cold">{data.sources.filter(item => item.enabled).length} 个已启用</span>
        </header>
        <div className="event-source-grid">
          {data.sources.map(source => (
            <div key={source.id} className="channel-card">
              <div className="channel-card-text">
                <strong>{source.id}</strong>
                <span>{source.kind} · {source.enabled ? '已启用' : '未启用'}</span>
                {source.message && <span>{source.message}</span>}
                {source.lastPolledAt && <span>最近拉取 {formatTime(source.lastPolledAt)}</span>}
              </div>
              <div className="runtime-card-actions">
                <button className="btn" onClick={() => setEditing(source)}>设置</button>
                <button className="btn ghost" onClick={() => void toggleSource(source)} disabled={busy}>
                  {source.enabled ? '停用' : '启用'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="settings-card">
        <header className="settings-head">
          <div>
            <h2>决策 prompt</h2>
            <p>判定依据：写清「哪类事件归哪个项目、走哪种处理方式、什么算急、拿不准怎么办」。改完保存立即生效。</p>
          </div>
          <span className="badge cold">v{data.decision.version} · {data.decision.provider}</span>
        </header>
        <div className="config-block-body">
          <textarea
            className="spec-textarea"
            style={{ minHeight: 240 }}
            value={prompt}
            onChange={event => setPrompt(event.target.value)}
            rows={12}
            spellCheck={false}
          />
          <div className="editor-foot">
            <span className="editor-hint">置信度阈值 {data.decision.confidenceThreshold}；低于阈值转人工。判定失败兜底：{data.decision.fallback === 'review' ? '待审核' : '留队重试'}。</span>
            <button className="btn primary" onClick={() => void savePrompt()} disabled={busy}>保存 prompt</button>
          </div>
        </div>
      </section>

      <section className="settings-card">
        <header className="settings-head">
          <div>
            <h2>事件队列</h2>
            <p>按优先级筛选；待审核的事件可以直接批准、驳回或延后。</p>
          </div>
          {reviewCount > 0 && <span className="badge hot">{reviewCount} 条待审核</span>}
        </header>
        <div className="log-toolbar">
          <div className="log-menu-list">
            {PRIORITIES.map(item => (
              <button
                key={item}
                className={`log-chip ${priority === item ? 'active' : ''}`}
                onClick={() => setPriority(current => (current === item ? '' : item))}
              >
                {item}
              </button>
            ))}
            <button className={`log-chip ${status === 'review' ? 'active' : ''}`} onClick={() => setStatus(current => (current === 'review' ? '' : 'review'))}>
              待审核
            </button>
            <button className={`log-chip ${status === 'pending' ? 'active' : ''}`} onClick={() => setStatus(current => (current === 'pending' ? '' : 'pending'))}>
              待处理
            </button>
            <button className={`log-chip ${status === 'done' ? 'active' : ''}`} onClick={() => setStatus(current => (current === 'done' ? '' : 'done'))}>
              已完成
            </button>
          </div>
        </div>
        {visible.length === 0 ? (
          <p className="editor-empty">队列里还没有事件。</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>优先级</th>
                <th>事件</th>
                <th>来源</th>
                <th>判定</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(event => (
                <tr key={event.id}>
                  <td><span className={`badge ${PRIORITY_TONE[event.priority] ?? 'cold'}`}>{event.priority}</span></td>
                  <td>
                    <strong>{event.title}</strong>
                    <div className="muted">{event.eventType || 'event'} · {formatTime(event.receivedAt)}</div>
                    {event.reason && <div className="muted">{event.reason}</div>}
                  </td>
                  <td className="mono">{event.sourceId}</td>
                  <td>
                    <div>{event.project || '未判定项目'}{event.skill ? ` · ${event.skill}` : ''}</div>
                    {event.ticketId && <div className="muted">工单 {event.ticketId}</div>}
                  </td>
                  <td>
                    <span className="badge cold">{STATUS_LABEL[event.status] ?? event.status}</span>
                    {event.execution !== 'none' && <div className="muted">{event.execution}</div>}
                  </td>
                  <td>
                    <div className="detail-actions">
                      {event.status === 'review' && (
                        <>
                          <button className="btn primary" disabled={busy} onClick={() => void act(event.id, 'approve')}>批准</button>
                          <button className="btn danger" disabled={busy} onClick={() => void act(event.id, 'reject')}>驳回</button>
                          <button className="btn" disabled={busy} onClick={() => void act(event.id, 'defer')}>延后</button>
                        </>
                      )}
                      {event.status === 'pending' && !event.ticketId && (
                        <button className="btn" disabled={busy} onClick={() => void act(event.id, 'retry')}>重试</button>
                      )}
                      {event.status !== 'done' && event.status !== 'invalid' && (
                        <button className="btn ghost" disabled={busy} onClick={() => void act(event.id, 'ignore')}>忽略</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {editing && (
        <SourceSettingsModal
          source={editing}
          config={config}
          busy={busy}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load() }}
        />
      )}
    </>
  )
}

/** 来源设置弹窗：按来源自己声明的字段渲染。 */
function SourceSettingsModal({ source, config, busy, onClose, onSaved }: {
  source: EventSourceView
  config: ConfigDoc | null
  busy: boolean
  onClose: () => void
  onSaved: () => Promise<void>
}): JSX.Element {
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const current = (config?.events?.sources?.[source.id] ?? {}) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const field of source.fields) {
      const value = current[field.key]
      out[field.key] = Array.isArray(value) ? value.join(', ') : value === undefined || value === null ? '' : String(value)
    }
    return out
  })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const patch: Record<string, unknown> = {}
      for (const field of source.fields) {
        const raw = draft[field.key] ?? ''
        if (field.kind === 'number') patch[`events.sources.${source.id}.${field.key}`] = raw === '' ? 0 : Number(raw)
        else if (field.kind === 'boolean') patch[`events.sources.${source.id}.${field.key}`] = raw === 'true'
        else if (field.kind === 'list') patch[`events.sources.${source.id}.${field.key}`] = raw.split(',').map(item => item.trim()).filter(Boolean)
        else patch[`events.sources.${source.id}.${field.key}`] = raw
      }
      await saveConfigPatch(patch)
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-layer">
      <button className="modal-backdrop" aria-label="关闭" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label={`${source.id} 设置`}>
        <header className="modal-head">
          <div>
            <h3>{source.id} 设置</h3>
            <p>{source.kind} 来源。保存后立即生效。</p>
          </div>
          <button className="icon-btn" title="关闭" onClick={onClose}><Icon name="close" size={14} /></button>
        </header>
        <div className="modal-body">
          {error && <p className="modal-error">{error}</p>}
          {source.fields.length === 0 && <p className="modal-hint">这个来源没有可配置项。</p>}
          {source.fields.map(field => (
            <label key={field.key} className="modal-field">
              <span>{field.label}</span>
              {field.kind === 'select' ? (
                <select value={draft[field.key] ?? ''} onChange={event => setDraft(current => ({ ...current, [field.key]: event.target.value }))}>
                  <option value="">（不设置）</option>
                  {(field.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
                </select>
              ) : (
                <input
                  value={draft[field.key] ?? ''}
                  onChange={event => setDraft(current => ({ ...current, [field.key]: event.target.value }))}
                  placeholder={field.hint}
                />
              )}
            </label>
          ))}
        </div>
        <footer className="modal-foot">
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => void save()} disabled={saving || busy}>保存</button>
        </footer>
      </div>
    </div>
  )
}

/** 时间显示：到分钟。 */
function formatTime(value: string): string {
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return value
  return at.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
