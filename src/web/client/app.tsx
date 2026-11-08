import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  FIELD_PATHS,
  SECTIONS,
  fieldError,
  fromInputValue,
  getByPath,
  humanizeMs,
  humanizeTime,
  setByPath,
  toInputValue,
  type FieldDef,
  type SectionDef,
} from './fields.js'

interface Ticket {
  id: string
  title: string
  stage: string
  source: string
  repo: string
  branch: string
  threadId: string
  chatId: string
  prUrl: string
  prNumber: number
  prState: string
  createdAt: string
  updatedAt: string
  closedAt?: string
}

interface Report {
  id?: string
  state: string
  turn: number
  summary: string
  humanAction?: string
  prUrl?: string
  reply?: string
  at: string
}

interface TicketInput {
  seq: number
  kind: string
  status: string
  text: string
  createdAt?: string
  ackedAt?: string
}

interface TicketDetail {
  ticket: Ticket
  mandate: { strength: string; scope: string; rules: string[]; policyVersion: string } | null
  assignment: { id: string; handle: string; workdir: string; status: string } | null
  reports: Report[]
  inputs: TicketInput[]
  attention: { question: string; createdAt?: string } | null
}

interface ConfigBundle {
  config: ConfigDoc
  defaults: ConfigDoc
  configPath: string
}

type ConfigDoc = Record<string, any>

interface ProjectDraft {
  name: string
  repo: string
  branches: string[]
  defaultBranch: string
}

interface ChatDraft {
  chat: string
  mode: string
  repo: string
  branch: string
  sync: boolean
  allowed: string[]
}

const STAGE_ORDER = ['draft', 'accepted', 'assigned', 'running', 'review', 'person', 'idle', 'closed']

const STAGE_LABEL: Record<string, string> = {
  draft: '草稿',
  accepted: '已接单',
  assigned: '已派工',
  running: '执行中',
  review: '待评审',
  person: '等人',
  idle: '空闲',
  closed: '已关闭',
}

const REPORT_STATE_LABEL: Record<string, string> = {
  progress: '进展',
  waiting: '等待',
  ready: '完成',
  blocked: '受阻',
  failed: '失败',
  dropped: '放弃',
}

const INPUT_STATUS_LABEL: Record<string, string> = {
  pending: '待投递',
  delivered: '已投递',
  acked: '已确认',
}

const PR_STATE_LABEL: Record<string, string> = {
  none: '无 PR',
  open: '开放中',
  merged: '已合并',
  closed: '已关闭',
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  const data = await res.json()
  if (!res.ok) throw new Error((data as { message?: string; error?: string }).message ?? (data as { error?: string }).error ?? `HTTP ${res.status}`)
  return data as T
}

async function sendJson<T>(path: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) {
    const failure = data as { error?: string; message?: string; errors?: { path: string; message: string }[] }
    const detail = failure.errors?.map(item => `${item.path}: ${item.message}`).join('；')
    throw new Error(detail || failure.message || failure.error || `HTTP ${res.status}`)
  }
  return data as T
}

function App(): JSX.Element {
  const [tab, setTab] = useState<'tickets' | 'config' | 'sources'>('tickets')
  return (
    <div className="app">
      <header>
        <h1>router-agent</h1>
        <nav>
          <button className={tab === 'tickets' ? 'active' : ''} onClick={() => setTab('tickets')}>工单</button>
          <button className={tab === 'config' ? 'active' : ''} onClick={() => setTab('config')}>配置</button>
          <button className={tab === 'sources' ? 'active' : ''} onClick={() => setTab('sources')}>来源</button>
        </nav>
      </header>
      <main>
        {tab === 'tickets' && <TicketsView />}
        {tab === 'config' && <ConfigView />}
        {tab === 'sources' && <SourcesView />}
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 工单
// ---------------------------------------------------------------------------

function TicketsView(): JSX.Element {
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<TicketDetail | null>(null)
  const [keyword, setKeyword] = useState('')
  const [stage, setStage] = useState<string>('all')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [lastSync, setLastSync] = useState<Date | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)

  const loadDetail = useCallback((id: string): void => {
    void getJson<TicketDetail>(`/api/tickets/${id}`)
      .then(data => {
        setDetail(data)
        setDetailError(null)
      })
      .catch(error => setDetailError(error instanceof Error ? error.message : String(error)))
  }, [])

  const load = useCallback((): void => {
    void getJson<{ tickets: Ticket[] }>('/api/tickets?limit=500')
      .then(data => {
        setTickets(data.tickets)
        setLastSync(new Date())
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    load()
    if (!autoRefresh) return
    const timer = setInterval(() => {
      load()
      if (selected) loadDetail(selected)
    }, 5_000)
    return () => clearInterval(timer)
  }, [autoRefresh, load, loadDetail, selected])

  useEffect(() => {
    if (!selected) {
      setDetail(null)
      return
    }
    loadDetail(selected)
  }, [selected, loadDetail])

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const ticket of tickets) map.set(ticket.stage, (map.get(ticket.stage) ?? 0) + 1)
    return map
  }, [tickets])

  const filtered = useMemo(() => {
    const query = keyword.trim().toLowerCase()
    return tickets.filter(ticket => {
      if (stage !== 'all' && ticket.stage !== stage) return false
      if (!query) return true
      return [ticket.title, ticket.id, ticket.repo, ticket.branch, ticket.prUrl, String(ticket.prNumber)]
        .some(value => String(value ?? '').toLowerCase().includes(query))
    })
  }, [tickets, keyword, stage])

  const grouped = STAGE_ORDER
    .filter(item => stage === 'all' || item === stage)
    .map(item => ({ stage: item, items: filtered.filter(ticket => ticket.stage === item) }))
    .filter(group => group.items.length > 0)

  return (
    <div className="tickets">
      <div className="toolbar">
        <input
          className="search"
          value={keyword}
          onChange={event => setKeyword(event.target.value)}
          placeholder="搜索标题 / 工单号 / 仓库 / PR"
        />
        <div className="chips">
          <button className={`chip ${stage === 'all' ? 'active' : ''}`} onClick={() => setStage('all')}>
            全部 <span className="count">{tickets.length}</span>
          </button>
          {STAGE_ORDER.map(item => (
            <button
              key={item}
              className={`chip ${stage === item ? 'active' : ''}`}
              onClick={() => setStage(item)}
              disabled={(counts.get(item) ?? 0) === 0 && stage !== item}
            >
              {STAGE_LABEL[item]} <span className="count">{counts.get(item) ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="toolbar-right">
          <span className="muted small">{lastSync ? `更新于 ${lastSync.toLocaleTimeString('zh-CN')}` : '未同步'}</span>
          <label className="switch">
            <input type="checkbox" checked={autoRefresh} onChange={event => setAutoRefresh(event.target.checked)} />
            自动刷新
          </label>
          <button onClick={() => { load(); if (selected) loadDetail(selected) }}>立即刷新</button>
        </div>
      </div>

      <div className="split">
        <section className="list">
          {grouped.length === 0 && <p className="muted empty">没有匹配的工单</p>}
          {grouped.map(group => (
            <div key={group.stage} className="group">
              <h2>
                {STAGE_LABEL[group.stage] ?? group.stage}
                <span className="count">{group.items.length}</span>
              </h2>
              {group.items.map(ticket => (
                <button
                  key={ticket.id}
                  className={`row ${selected === ticket.id ? 'selected' : ''}`}
                  onClick={() => setSelected(ticket.id)}
                >
                  <span className="row-main">
                    <span className="title">{ticket.title}</span>
                    <span className="row-meta">
                      {ticket.repo ? `${ticket.repo}@${ticket.branch || '?'}` : ticket.id}
                      {ticket.prNumber ? ` · PR #${ticket.prNumber}` : ''}
                    </span>
                  </span>
                  <span className="row-side">
                    <span className={`pill pr-${ticket.prState}`}>{PR_STATE_LABEL[ticket.prState] ?? ticket.prState}</span>
                    <span className="muted small">{humanizeTime(ticket.updatedAt)}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </section>

        <section className="detail">
          {!selected && <p className="muted empty">从左侧选择一张工单查看详情</p>}
          {selected && detailError && <p className="alert">加载详情失败：{detailError}</p>}
          {selected && detail && <TicketDetailView detail={detail} onChanged={() => { load(); loadDetail(selected) }} />}
          {selected && !detail && !detailError && <p className="muted">加载中…</p>}
        </section>
      </div>
    </div>
  )
}

function StagePill({ stage }: { stage: string }): JSX.Element {
  return <span className={`pill stage-${stage}`}>{STAGE_LABEL[stage] ?? stage}</span>
}

function TicketDetailView({ detail, onChanged }: { detail: TicketDetail; onChanged: () => void }): JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState('')
  const { ticket } = detail
  const open = ticket.stage !== 'closed'

  const copy = async (label: string, value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
      setTimeout(() => setCopied(''), 1500)
    } catch {
      setCopied('复制失败')
    }
  }

  const sendInput = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      await sendJson(`/api/tickets/${ticket.id}/input`, 'POST', { kind: 'followup', text })
      setText('')
      onChanged()
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    if (!confirm(`确认停止「${ticket.title}」？停止后 worker 终端会被关闭。`)) return
    try {
      await sendJson(`/api/tickets/${ticket.id}/stop`, 'POST', { reason: '面板停止' })
      onChanged()
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error))
    }
  }

  const reports = [...detail.reports].sort((a, b) => {
    if (a.turn !== b.turn) return b.turn - a.turn
    return a.at < b.at ? 1 : -1
  })

  return (
    <div className="ticket-detail">
      <div className="detail-head">
        <div>
          <h2 className="detail-title">{ticket.title}</h2>
          <div className="detail-sub">
            <StagePill stage={ticket.stage} />
            <span className="mono">{ticket.id}</span>
            <button className="link-button" onClick={() => void copy('id', ticket.id)}>
              {copied === 'id' ? '已复制' : '复制'}
            </button>
          </div>
        </div>
        <div className="detail-actions">
          {ticket.prUrl && <a className="button" href={ticket.prUrl} target="_blank" rel="noreferrer">打开 PR</a>}
          {open && <button className="danger" onClick={() => void stop()}>停止工单</button>}
        </div>
      </div>

      {detail.attention && (
        <div className="alert-box">
          <strong>等待人工</strong>
          <p>{detail.attention.question}</p>
          {detail.attention.createdAt && <span className="muted small">{humanizeTime(detail.attention.createdAt)}</span>}
        </div>
      )}

      <dl className="meta-grid">
        <dt>派工</dt>
        <dd>{ticket.repo ? `${ticket.repo} @ ${ticket.branch || '未指定'}` : '—'}</dd>
        <dt>来源</dt>
        <dd>{ticket.source === 'feishu' ? '飞书' : ticket.source} · {ticket.chatId || '—'}</dd>
        <dt>PR</dt>
        <dd>
          {ticket.prUrl
            ? <a href={ticket.prUrl} target="_blank" rel="noreferrer">#{ticket.prNumber} · {PR_STATE_LABEL[ticket.prState] ?? ticket.prState}</a>
            : '—'}
        </dd>
        <dt>创建</dt>
        <dd title={ticket.createdAt}>{humanizeTime(ticket.createdAt)}</dd>
        <dt>更新</dt>
        <dd title={ticket.updatedAt}>{humanizeTime(ticket.updatedAt)}</dd>
        {detail.mandate && (<><dt>授权范围</dt><dd>{detail.mandate.scope}</dd></>)}
        {detail.mandate && (<><dt>授权强度</dt><dd>{detail.mandate.strength === 'explicit' ? '显式' : '模型推断'}</dd></>)}
        {detail.assignment && (
          <>
            <dt>终端</dt>
            <dd><span className="mono">{detail.assignment.handle || '—'}</span> · {detail.assignment.status}</dd>
            <dt>工作目录</dt>
            <dd className="mono truncate" title={detail.assignment.workdir}>{detail.assignment.workdir || '—'}</dd>
          </>
        )}
      </dl>

      <h3>进展（{reports.length}）</h3>
      {reports.length === 0 ? <p className="muted">还没有上报</p> : (
        <ol className="timeline">
          {reports.map((report, index) => (
            <li key={report.id ?? `${report.turn}-${index}`} className="timeline-item">
              <div className="timeline-head">
                <span className={`pill report-${report.state}`}>{REPORT_STATE_LABEL[report.state] ?? report.state}</span>
                <span className="muted small">第 {report.turn} 轮 · {humanizeTime(report.at)}</span>
              </div>
              <p className="timeline-summary">{report.summary}</p>
              {report.humanAction && <p className="alert">需要人工：{report.humanAction}</p>}
              {report.prUrl && <a href={report.prUrl} target="_blank" rel="noreferrer">{report.prUrl}</a>}
              {report.reply && (
                <details className="reply">
                  <summary>查看完整回复（{report.reply.length} 字）</summary>
                  <div className="reply-actions">
                    <button className="link-button" onClick={() => void copy(report.id ?? 'reply', report.reply!)}>
                      {copied === (report.id ?? 'reply') ? '已复制' : '复制回复'}
                    </button>
                  </div>
                  <pre>{report.reply}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}

      <h3>投递记录（{detail.inputs.length}）</h3>
      {detail.inputs.length === 0 ? <p className="muted">还没有投递过 follow-up</p> : (
        <ul className="inputs">
          {detail.inputs.map(input => (
            <li key={input.seq}>
              <span className={`pill input-${input.status}`}>{INPUT_STATUS_LABEL[input.status] ?? input.status}</span>
              <span className="input-text">{input.text}</span>
              <span className="muted small">{humanizeTime(input.ackedAt ?? input.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <form onSubmit={sendInput} className="inline compose">
          <input
            value={text}
            onChange={event => setText(event.target.value)}
            placeholder="给 worker 投递 follow-up，例如「顺便补一下测试」"
          />
          <button type="submit" disabled={busy || !text.trim()}>{busy ? '投递中…' : '投递'}</button>
        </form>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

function ConfigView(): JSX.Element {
  const [original, setOriginal] = useState<ConfigDoc | null>(null)
  const [draft, setDraft] = useState<ConfigDoc | null>(null)
  const [defaults, setDefaults] = useState<ConfigDoc>({})
  const [configPath, setConfigPath] = useState('')
  const [active, setActive] = useState<string>('policy')
  const [filter, setFilter] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    void getJson<ConfigBundle>('/api/config')
      .then(data => {
        setOriginal(data.config)
        setDraft(data.config)
        setDefaults(data.defaults)
        setConfigPath(data.configPath)
        setLoadError(null)
      })
      .catch(error => setLoadError(error instanceof Error ? error.message : String(error)))
  }, [])

  const changed = useMemo(() => {
    if (!draft || !original) return []
    const paths = FIELD_PATHS.filter(path => JSON.stringify(getByPath(draft, path)) !== JSON.stringify(getByPath(original, path)))
    if (JSON.stringify(draft.projects) !== JSON.stringify(original.projects)) paths.push('projects')
    if (JSON.stringify(draft.feishu?.chats) !== JSON.stringify(original.feishu?.chats)) paths.push('feishu.chats')
    return paths
  }, [draft, original])

  const errors = useMemo(() => {
    if (!draft) return new Map<string, string>()
    const map = new Map<string, string>()
    for (const section of SECTIONS) {
      for (const field of section.fields) {
        const message = fieldError(field, getByPath(draft, field.path))
        if (message) map.set(field.path, message)
      }
    }
    if (Array.isArray(draft.feishu?.chats)) {
      for (const chat of draft.feishu.chats as ChatDraft[]) {
        if (!String(chat.chat || '').trim()) map.set('feishu.chats', '每行都需要填写 chat_id')
      }
    }
    if (Array.isArray(draft.projects)) {
      for (const project of draft.projects as ProjectDraft[]) {
        if (!String(project.repo || '').trim()) map.set('projects', '每个项目都需要填写 repo')
      }
    }
    return map
  }, [draft])

  const setField = (path: string, value: unknown): void => {
    setDraft(current => (current ? setByPath(current, path, value) : current))
    setNotice(null)
  }

  const resetAll = (): void => {
    if (!original) return
    if (!confirm('放弃所有未保存的修改？')) return
    setDraft(structuredClone(original))
    setNotice(null)
  }

  const save = async (): Promise<void> => {
    if (!draft || !original || changed.length === 0 || errors.size > 0) return
    const patch: Record<string, unknown> = {}
    for (const path of changed) patch[path] = getByPath(draft, path)
    setSaving(true)
    setNotice(null)
    try {
      const result = await sendJson<ConfigBundle & { changed: string[]; restartRequired: boolean; policyChanged: boolean }>(
        '/api/config',
        'PUT',
        { patch },
      )
      setOriginal(result.config)
      setDraft(result.config)
      setDefaults(result.defaults)
      setConfigPath(result.configPath)
      setNotice({
        kind: result.restartRequired ? 'warn' : 'ok',
        text: result.restartRequired
          ? `已保存 ${result.changed.length} 项。带「重启生效」的改动需要执行 ra start 重新启动服务后才会生效。`
          : `已保存 ${result.changed.length} 项，已立即生效。`,
      })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setSaving(false)
    }
  }

  if (loadError) return <p className="alert">读取配置失败：{loadError}</p>
  if (!draft || !original) return <p className="muted">加载中…</p>

  const query = filter.trim().toLowerCase()
  const sections = [...SECTIONS, ...CUSTOM_SECTIONS]
  const matches = (section: SectionDef): boolean =>
    !query || section.title.toLowerCase().includes(query) || section.id.includes(query) ||
    section.fields.some(field => `${field.label} ${field.path} ${field.hint ?? ''}`.toLowerCase().includes(query))

  return (
    <div className="config">
      <aside className="config-nav">
        <input className="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder="筛选配置项" />
        {sections.map(section => {
          const hasFields = section.fields.length > 0
          const dirty = hasFields
            ? section.fields.some(field => changed.includes(field.path))
            : changed.includes(section.id)
          const invalid = hasFields
            ? section.fields.some(field => errors.has(field.path))
            : errors.has(section.id)
          return (
            <button
              key={section.id}
              className={`nav-item ${active === section.id ? 'active' : ''}`}
              onClick={() => {
                setActive(section.id)
                document.getElementById(`sec-${section.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
              }}
            >
              <span>{section.title}</span>
              {invalid && <span className="dot invalid" title="有字段不合法" />}
              {!invalid && dirty && <span className="dot" title="有未保存修改" />}
            </button>
          )
        })}
        <p className="muted small nav-path" title={configPath}>{configPath || '配置文件路径未知'}</p>
      </aside>

      <section className="config-body">
        {sections.filter(matches).map(section => (
          <details key={section.id} id={`sec-${section.id}`} className="config-section" open={section.id === active || Boolean(query)}>
            <summary onClick={() => setActive(section.id)}>
              <span className="section-title">{section.title}</span>
              {section.hot
                ? <span className="pill hot">立即生效</span>
                : <span className="pill cold">重启生效</span>}
              {section.fields.length > 0 && section.fields.some(field => changed.includes(field.path)) && <span className="pill dirty">已修改</span>}
              {section.fields.length === 0 && changed.includes(section.id) && <span className="pill dirty">已修改</span>}
            </summary>
            <p className="section-desc">{section.description}</p>
            {section.id === 'projects' && (
              <ProjectsEditor
                projects={draft.projects ?? []}
                error={errors.get('projects')}
                onChange={value => setField('projects', value)}
              />
            )}
            {section.id === 'feishu.chats' && (
              <ChatsEditor
                chats={draft.feishu?.chats ?? []}
                error={errors.get('feishu.chats')}
                onChange={value => setField('feishu.chats', value)}
              />
            )}
            {section.fields.length > 0 && (
              <div className="fields">
                {section.fields
                  .filter(field => !query || `${field.label} ${field.path} ${field.hint ?? ''}`.toLowerCase().includes(query))
                  .map(field => (
                    <FieldRow
                      key={field.path}
                      field={field}
                      value={getByPath(draft, field.path)}
                      defaultValue={getByPath(defaults, field.path)}
                      error={errors.get(field.path)}
                      onChange={value => setField(field.path, value)}
                    />
                  ))}
              </div>
            )}
          </details>
        ))}
        {sections.filter(matches).length === 0 && <p className="muted">没有匹配的配置项</p>}
      </section>

      <div className={`savebar ${changed.length > 0 ? 'show' : ''}`}>
        <span>
          {errors.size > 0
            ? <span className="danger-text">{errors.size} 个字段不合法，修正后才能保存</span>
            : changed.length > 0 ? `${changed.length} 项未保存` : '配置已同步'}
        </span>
        {notice && <span className={`notice ${notice.kind}`}>{notice.text}</span>}
        <span className="spacer" />
        <button onClick={resetAll} disabled={changed.length === 0 || saving}>放弃修改</button>
        <button className="primary" onClick={() => void save()} disabled={changed.length === 0 || errors.size > 0 || saving}>
          {saving ? '保存中…' : '保存配置'}
        </button>
      </div>
    </div>
  )
}

const CUSTOM_SECTIONS: SectionDef[] = [
  { id: 'projects', title: '项目清单', description: '开单前必须明确「哪个项目 + 哪个起始分支」。这里维护可派工的项目。', fields: [] },
  { id: 'feishu.chats', title: '群与绑定', description: '监控哪些群、收全部消息还是只收 @、绑定到哪个项目与分支。', fields: [] },
]

function FieldRow({ field, value, defaultValue, error, onChange }: {
  field: FieldDef
  value: unknown
  defaultValue: unknown
  error?: string
  onChange: (value: unknown) => void
}): JSX.Element {
  const hasDefault = defaultValue !== undefined && JSON.stringify(value) !== JSON.stringify(defaultValue)
  const control = (): ReactNode => {
    if (field.kind === 'switch') {
      return (
        <label className="switch">
          <input type="checkbox" checked={value === true} onChange={event => onChange(event.target.checked)} />
          {value === true ? '开启' : '关闭'}
        </label>
      )
    }
    if (field.kind === 'select') {
      return (
        <select value={String(value ?? '')} onChange={event => onChange(event.target.value)}>
          {field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      )
    }
    if (field.kind === 'number') {
      return (
        <span className="number-wrap">
          <input
            type="number"
            min={field.min}
            max={field.max}
            value={typeof value === 'number' ? value : ''}
            onChange={event => onChange(fromInputValue(event.target.value, 'number'))}
          />
          {field.unit && <span className="unit">{field.unit}</span>}
        </span>
      )
    }
    return (
      <input
        value={toInputValue(value, field.kind)}
        onChange={event => onChange(fromInputValue(event.target.value, field.kind))}
        placeholder={field.placeholder}
      />
    )
  }

  return (
    <div className={`field ${error ? 'has-error' : ''}`}>
      <div className="field-head">
        <label>{field.label}</label>
        {hasDefault && (
          <button className="link-button" title={`恢复默认值：${JSON.stringify(defaultValue)}`} onClick={() => onChange(defaultValue)}>
            恢复默认
          </button>
        )}
      </div>
      {control()}
      <div className="field-foot">
        {error ? <span className="field-error">{error}</span> : field.hint && <span className="field-hint">{field.hint}</span>}
        {field.ms && <span className="field-hint">{humanizeMs(value)}</span>}
      </div>
    </div>
  )
}

function ProjectsEditor({ projects, error, onChange }: {
  projects: ProjectDraft[]
  error?: string
  onChange: (value: ProjectDraft[]) => void
}): JSX.Element {
  const update = (index: number, patch: Partial<ProjectDraft>): void => {
    onChange(projects.map((project, i) => (i === index ? { ...project, ...patch } : project)))
  }
  return (
    <div className="editor">
      {projects.length === 0 && <p className="muted">还没有项目。没有项目时开单会先追问仓库。</p>}
      {projects.map((project, index) => (
        <div key={index} className="editor-row">
          <input value={project.name} placeholder="项目名（模型引用）" onChange={event => update(index, { name: event.target.value })} />
          <input value={project.repo} placeholder="Orca repo 选择器，如 name:dsh/router-agent" onChange={event => update(index, { repo: event.target.value })} />
          <input value={project.defaultBranch} placeholder="默认分支" onChange={event => update(index, { defaultBranch: event.target.value })} />
          <input
            value={project.branches.join(', ')}
            placeholder="允许分支，逗号分隔"
            onChange={event => update(index, { branches: event.target.value.split(',').map(item => item.trim()).filter(Boolean) })}
          />
          <button className="danger small" onClick={() => onChange(projects.filter((_, i) => i !== index))}>删除</button>
        </div>
      ))}
      {error && <p className="field-error">{error}</p>}
      <button onClick={() => onChange([...projects, { name: '', repo: '', defaultBranch: '', branches: [] }])}>添加项目</button>
    </div>
  )
}

function ChatsEditor({ chats, error, onChange }: {
  chats: ChatDraft[]
  error?: string
  onChange: (value: ChatDraft[]) => void
}): JSX.Element {
  const update = (index: number, patch: Partial<ChatDraft>): void => {
    onChange(chats.map((chat, i) => (i === index ? { ...chat, ...patch } : chat)))
  }
  return (
    <div className="editor">
      {chats.length === 0 && <p className="muted">还没有监控群。至少添加一个群，机器人才能收到消息。</p>}
      {chats.map((chat, index) => (
        <div key={index} className="editor-row chat-row">
          <input value={chat.chat} placeholder="chat_id（oc_xxx）" onChange={event => update(index, { chat: event.target.value })} />
          <select value={chat.mode} onChange={event => update(index, { mode: event.target.value })}>
            <option value="all">全部消息</option>
            <option value="mention">仅 @</option>
          </select>
          <input value={chat.repo} placeholder="绑定项目（可空）" onChange={event => update(index, { repo: event.target.value })} />
          <input value={chat.branch} placeholder="绑定分支（可空）" onChange={event => update(index, { branch: event.target.value })} />
          <label className="switch">
            <input type="checkbox" checked={chat.sync === true} onChange={event => update(index, { sync: event.target.checked })} />
            补拉历史
          </label>
          <input
            value={chat.allowed.join(', ')}
            placeholder="本群允许名单（可空）"
            onChange={event => update(index, { allowed: event.target.value.split(',').map(item => item.trim()).filter(Boolean) })}
          />
          <button className="danger small" onClick={() => onChange(chats.filter((_, i) => i !== index))}>删除</button>
        </div>
      ))}
      {error && <p className="field-error">{error}</p>}
      <button onClick={() => onChange([...chats, { chat: '', mode: 'all', repo: '', branch: '', sync: false, allowed: [] }])}>添加群</button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 来源
// ---------------------------------------------------------------------------

function SourcesView(): JSX.Element {
  const [data, setData] = useState<{
    chats: { chat: string; mode: string; repo: string; branch: string; allowed?: string[] }[]
    directMessages: boolean
    allowed: string[]
  } | null>(null)
  const [status, setStatus] = useState<{
    backend: string
    stage: string
    tickets: { open: number; closed: number; byStage: Record<string, number> }
    now: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void getJson<typeof data>('/api/sources/feishu/chats').then(setData).catch(error => setError(String(error)))
    void getJson<typeof status>('/api/status').then(setStatus).catch(error => setError(String(error)))
  }, [])

  if (error) return <p className="alert">{error}</p>
  if (!data) return <p className="muted">加载中…</p>

  return (
    <div className="sources">
      <div className="cards">
        <div className="card">
          <span className="card-label">服务状态</span>
          <strong>{status?.stage === 'running' ? '运行中' : status?.stage ?? '—'}</strong>
        </div>
        <div className="card">
          <span className="card-label">开放工单</span>
          <strong>{status?.tickets.open ?? 0}</strong>
        </div>
        <div className="card">
          <span className="card-label">已关闭</span>
          <strong>{status?.tickets.closed ?? 0}</strong>
        </div>
        <div className="card">
          <span className="card-label">Worker 后端</span>
          <strong>{status?.backend ?? '—'}</strong>
        </div>
      </div>

      <section className="panel-block">
        <h3>监控群</h3>
        {data.chats.length === 0 ? <p className="muted">还没有配置监控群。</p> : (
          <table className="table">
            <thead>
              <tr><th>群</th><th>接收</th><th>绑定</th><th>本群名单</th></tr>
            </thead>
            <tbody>
              {data.chats.map(chat => (
                <tr key={chat.chat}>
                  <td className="mono">{chat.chat}</td>
                  <td>{chat.mode === 'mention' ? '仅 @' : '全部消息'}</td>
                  <td>{chat.repo ? `${chat.repo}@${chat.branch || '?'}` : <span className="muted">开工前追问</span>}</td>
                  <td>{chat.allowed && chat.allowed.length > 0 ? `${chat.allowed.length} 人` : <span className="muted">沿用全局</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">要调整群和绑定，请到「配置 → 群与绑定」。</p>
      </section>

      <section className="panel-block">
        <h3>接收范围</h3>
        <dl className="meta-grid">
          <dt>私聊</dt><dd>{data.directMessages ? '接收' : '关闭'}</dd>
          <dt>全局许可名单</dt><dd>{data.allowed.join('，') || '—'}</dd>
        </dl>
      </section>
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)