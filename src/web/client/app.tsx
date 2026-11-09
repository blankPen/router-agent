import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
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

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

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

interface ServiceStatus {
  stage: string
  runtime: string
  tickets: { open: number; closed: number; byStage: Record<string, number> }
  now: string
}

// ---------------------------------------------------------------------------
// 常量与工具
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 图标（内联 SVG，不引外部资源）
// ---------------------------------------------------------------------------

type IconName =
  | 'inbox' | 'sliders' | 'radio' | 'search' | 'refresh' | 'copy' | 'external'
  | 'stop' | 'alert' | 'plus' | 'trash' | 'branch' | 'terminal' | 'clock' | 'check' | 'chevron'

function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }): JSX.Element {
  const paths: Record<IconName, JSX.Element> = {
    inbox: (
      <>
        <path d="M22 12h-6l-2 3h-4l-2-3H2" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
      </>
    ),
    sliders: (
      <>
        <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
        <path d="M1 14h6M9 8h6M17 16h6" />
      </>
    ),
    radio: (
      <>
        <circle cx="12" cy="12" r="2" />
        <path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
      </>
    ),
    refresh: (
      <>
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
      </>
    ),
    copy: (
      <>
        <rect x="9" y="9" width="12" height="12" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </>
    ),
    external: (
      <>
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <path d="M15 3h6v6M10 14 21 3" />
      </>
    ),
    stop: <rect x="6" y="6" width="12" height="12" rx="2.5" />,
    alert: (
      <>
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        <path d="M12 9v4M12 17h.01" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    trash: (
      <>
        <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6M14 11v6" />
      </>
    ),
    branch: (
      <>
        <path d="M6 3v12" />
        <circle cx="18" cy="6" r="3" />
        <circle cx="6" cy="18" r="3" />
        <path d="M18 9a9 9 0 0 1-9 9" />
      </>
    ),
    terminal: (
      <>
        <path d="m4 17 6-6-6-6" />
        <path d="M12 19h8" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    check: <path d="m4 12 5 5L20 6" />,
    chevron: <path d="m9 6 6 6-6 6" />,
  }
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// 应用外壳
// ---------------------------------------------------------------------------

type Tab = 'tickets' | 'config' | 'sources'

function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('tickets')
  const [status, setStatus] = useState<ServiceStatus | null>(null)

  useEffect(() => {
    const load = (): void => {
      void getJson<ServiceStatus>('/api/status').then(setStatus).catch(() => undefined)
    }
    load()
    const timer = setInterval(load, 15_000)
    return () => clearInterval(timer)
  }, [])

  const live = status?.stage === 'running'

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">ra</span>
          <span className="brand-text">
            <strong>router-agent</strong>
            <small>control room</small>
          </span>
        </div>

        <nav className="side-nav">
          <button className={`nav-tab ${tab === 'tickets' ? 'active' : ''}`} onClick={() => setTab('tickets')}>
            <Icon name="inbox" />
            <span>工单</span>
            {status && status.tickets.open > 0 && <span className="nav-count">{status.tickets.open}</span>}
          </button>
          <button className={`nav-tab ${tab === 'config' ? 'active' : ''}`} onClick={() => setTab('config')}>
            <Icon name="sliders" />
            <span>配置</span>
          </button>
          <button className={`nav-tab ${tab === 'sources' ? 'active' : ''}`} onClick={() => setTab('sources')}>
            <Icon name="radio" />
            <span>来源</span>
          </button>
        </nav>

        <div className="sidebar-foot">
          <span className={`status-dot ${live ? 'live' : ''}`} />
          <span className="sidebar-status">
            <strong>{live ? '服务运行中' : status?.stage ?? '未连接'}</strong>
            <small>{status?.runtime ? `运行时 ${status.runtime}` : 'router-agent'}</small>
          </span>
        </div>
      </aside>

      <div className="workspace">
        {tab === 'tickets' && <TicketsView />}
        {tab === 'config' && <ConfigView />}
        {tab === 'sources' && <SourcesView />}
      </div>
    </div>
  )
}

function PageHead({ eyebrow, title, subtitle, actions }: {
  eyebrow: string
  title: string
  subtitle?: JSX.Element | string
  actions?: JSX.Element
}): JSX.Element {
  return (
    <header className="page-head">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
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

  const openCount = tickets.filter(ticket => ticket.stage !== 'closed').length

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

  const refresh = (): void => {
    load()
    if (selected) loadDetail(selected)
  }

  return (
    <>
      <PageHead
        eyebrow="TICKETS"
        title="工单"
        subtitle={lastSync
          ? `${openCount} 张进行中 · ${tickets.length - openCount} 张已关闭 · 更新于 ${lastSync.toLocaleTimeString('zh-CN')}`
          : '正在读取工单…'}
        actions={
          <>
            <label className="switch">
              <input type="checkbox" checked={autoRefresh} onChange={event => setAutoRefresh(event.target.checked)} />
              <span className="switch-track"><span className="switch-knob" /></span>
              自动刷新
            </label>
            <button className="btn" onClick={refresh}>
              <Icon name="refresh" size={14} />
              刷新
            </button>
          </>
        }
      />

      <div className="filter-bar">
        <div className="search-box">
          <Icon name="search" size={15} />
          <input
            value={keyword}
            onChange={event => setKeyword(event.target.value)}
            placeholder="搜索标题、工单号、仓库或 PR"
          />
        </div>
        <div className="stage-chips">
          <button className={`chip ${stage === 'all' ? 'active' : ''}`} onClick={() => setStage('all')}>
            全部<span className="chip-count">{tickets.length}</span>
          </button>
          {STAGE_ORDER.map(item => {
            const count = counts.get(item) ?? 0
            return (
              <button
                key={item}
                className={`chip stage-${item} ${stage === item ? 'active' : ''}`}
                onClick={() => setStage(item)}
                disabled={count === 0 && stage !== item}
              >
                <span className="chip-dot" />
                {STAGE_LABEL[item]}
                <span className="chip-count">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="split">
        <section className="ticket-list">
          {grouped.length === 0 && (
            <div className="empty-state">
              <Icon name="inbox" size={22} />
              <p>没有匹配的工单</p>
              <small>调整筛选条件，或等待新的消息进来。</small>
            </div>
          )}
          {grouped.map(group => (
            <div key={group.stage} className="ticket-group">
              <div className="group-head">
                <span className={`group-dot stage-${group.stage}`} />
                <span>{STAGE_LABEL[group.stage] ?? group.stage}</span>
                <span className="group-count">{group.items.length}</span>
              </div>
              {group.items.map(ticket => (
                <button
                  key={ticket.id}
                  className={`ticket-card ${selected === ticket.id ? 'selected' : ''}`}
                  onClick={() => setSelected(ticket.id)}
                >
                  <span className={`stage-bar stage-${ticket.stage}`} />
                  <span className="ticket-body">
                    <span className="ticket-title">{ticket.title}</span>
                    <span className="ticket-meta">
                      <span className="mono">{ticket.id}</span>
                      {ticket.repo && <><span className="meta-sep">·</span><Icon name="branch" size={12} />{ticket.repo}@{ticket.branch || '?'}</>}
                    </span>
                  </span>
                  <span className="ticket-side">
                    <span className="ticket-time">{humanizeTime(ticket.updatedAt)}</span>
                    {ticket.prState !== 'none' && <span className={`pr-badge pr-${ticket.prState}`}>{PR_STATE_LABEL[ticket.prState] ?? ticket.prState}</span>}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </section>

        <section className="detail-pane">
          {!selected && (
            <div className="empty-state tall">
              <Icon name="inbox" size={26} />
              <p>选择一张工单</p>
              <small>左侧工单会按阶段分组，点开即可查看进展、投递 follow-up 或停止执行。</small>
            </div>
          )}
          {selected && detailError && <div className="banner danger"><Icon name="alert" />加载详情失败：{detailError}</div>}
          {selected && detail && (
            <TicketDetailView
              detail={detail}
              onChanged={() => {
                load()
                if (selected) loadDetail(selected)
              }}
            />
          )}
          {selected && !detail && !detailError && <div className="empty-state tall"><p>正在加载…</p></div>}
        </section>
      </div>
    </>
  )
}

function StagePill({ stage }: { stage: string }): JSX.Element {
  return <span className={`stage-pill stage-${stage}`}><span className="stage-dot" />{STAGE_LABEL[stage] ?? stage}</span>
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
    <article className="detail">
      <header className="detail-head">
        <div className="detail-title-block">
          <div className="detail-kicker">
            <StagePill stage={ticket.stage} />
            <span className="mono id-text">{ticket.id}</span>
            <button className="icon-btn" title="复制工单号" onClick={() => void copy('id', ticket.id)}>
              {copied === 'id' ? <Icon name="check" size={13} /> : <Icon name="copy" size={13} />}
            </button>
          </div>
          <h2>{ticket.title}</h2>
        </div>
        <div className="detail-actions">
          {ticket.prUrl && (
            <a className="btn" href={ticket.prUrl} target="_blank" rel="noreferrer">
              <Icon name="external" size={14} />PR #{ticket.prNumber}
            </a>
          )}
          {open && (
            <button className="btn danger" onClick={() => void stop()}>
              <Icon name="stop" size={13} />停止
            </button>
          )}
        </div>
      </header>

      {detail.attention && (
        <div className="banner warn">
          <Icon name="alert" />
          <div>
            <strong>等待人工</strong>
            <p>{detail.attention.question}</p>
            {detail.attention.createdAt && <small>{humanizeTime(detail.attention.createdAt)}</small>}
          </div>
        </div>
      )}

      <section className="meta-card">
        <MetaItem label="派工" value={ticket.repo ? `${ticket.repo} @ ${ticket.branch || '未指定'}` : '—'} mono />
        <MetaItem label="来源" value={ticket.source === 'feishu' ? `飞书 · ${ticket.chatId || '—'}` : ticket.source} />
        <MetaItem
          label="PR"
          value={ticket.prUrl ? `#${ticket.prNumber} · ${PR_STATE_LABEL[ticket.prState] ?? ticket.prState}` : '尚未关联'}
          href={ticket.prUrl || undefined}
        />
        <MetaItem label="创建" value={humanizeTime(ticket.createdAt)} title={ticket.createdAt} />
        <MetaItem label="更新" value={humanizeTime(ticket.updatedAt)} title={ticket.updatedAt} />
        <MetaItem label="授权强度" value={detail.mandate ? (detail.mandate.strength === 'explicit' ? '显式指派' : '模型推断') : '—'} />
        {detail.mandate && <MetaItem label="授权范围" value={detail.mandate.scope} wide />}
        {detail.assignment && (
          <>
            <MetaItem label="终端" value={`${detail.assignment.handle || '—'} · ${detail.assignment.status}`} mono />
            <MetaItem label="工作目录" value={detail.assignment.workdir || '—'} mono />
          </>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h3>进展</h3>
          <span className="section-count">{reports.length}</span>
        </div>
        {reports.length === 0 ? <p className="muted">还没有上报。</p> : (
          <ol className="timeline">
            {reports.map((report, index) => (
              <li key={report.id ?? `${report.turn}-${index}`} className="report">
                <span className={`report-marker report-${report.state}`} />
                <div className="report-body">
                  <div className="report-head">
                    <span className={`report-state report-${report.state}`}>{REPORT_STATE_LABEL[report.state] ?? report.state}</span>
                    <span className="report-turn">第 {report.turn} 轮</span>
                    <span className="report-time">{humanizeTime(report.at)}</span>
                  </div>
                  <p className="report-summary">{report.summary}</p>
                  {report.humanAction && <div className="banner danger compact"><Icon name="alert" />{report.humanAction}</div>}
                  {report.prUrl && <a className="inline-link" href={report.prUrl} target="_blank" rel="noreferrer">{report.prUrl}</a>}
                  {report.reply && (
                    <details className="reply">
                      <summary>查看完整回复 · {report.reply.length} 字</summary>
                      <div className="reply-tools">
                        <button className="btn tiny" onClick={() => void copy(report.id ?? 'reply', report.reply!)}>
                          {copied === (report.id ?? 'reply') ? '已复制' : '复制'}
                        </button>
                      </div>
                      <pre>{report.reply}</pre>
                    </details>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h3>投递记录</h3>
          <span className="section-count">{detail.inputs.length}</span>
        </div>
        {detail.inputs.length === 0 ? <p className="muted">还没有投递过 follow-up。</p> : (
          <ul className="input-list">
            {detail.inputs.map(input => (
              <li key={input.seq}>
                <span className={`input-state input-${input.status}`}>{INPUT_STATUS_LABEL[input.status] ?? input.status}</span>
                <span className="input-text">{input.text}</span>
                <span className="input-time">{humanizeTime(input.ackedAt ?? input.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {open && (
        <form onSubmit={sendInput} className="composer">
          <Icon name="terminal" size={15} />
          <input
            value={text}
            onChange={event => setText(event.target.value)}
            placeholder="给 worker 投递 follow-up，例如「顺便补一下测试」"
          />
          <button type="submit" className="btn primary" disabled={busy || !text.trim()}>
            {busy ? '投递中…' : '投递'}
          </button>
        </form>
      )}
    </article>
  )
}

function MetaItem({ label, value, href, mono, wide, title }: {
  label: string
  value: string
  href?: string
  mono?: boolean
  wide?: boolean
  title?: string
}): JSX.Element {
  return (
    <div className={`meta-item ${wide ? 'wide' : ''}`}>
      <span className="meta-label">{label}</span>
      {href
        ? <a className={`meta-value ${mono ? 'mono' : ''}`} href={href} target="_blank" rel="noreferrer" title={title}>{value}</a>
        : <span className={`meta-value ${mono ? 'mono' : ''}`} title={title}>{value}</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const CUSTOM_SECTIONS: SectionDef[] = [
  { id: 'projects', title: '项目清单', description: '开单前必须明确「哪个项目 + 哪个起始分支」。这里维护可派工的项目。', fields: [] },
  { id: 'feishu.chats', title: '群与绑定', description: '监控哪些群、收全部消息还是只收 @、绑定到哪个项目与分支。', fields: [] },
]

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
      const message = {
        kind: result.restartRequired ? 'warn' as const : 'ok' as const,
        text: result.restartRequired
          ? `已保存 ${result.changed.length} 项，其中需要重启 ra start 的改动尚未生效。`
          : `已保存 ${result.changed.length} 项，已立即生效。`,
      }
      setNotice(message)
      window.setTimeout(() => setNotice(current => (current === message ? null : current)), 6_000)
    } catch (error) {
      const message = { kind: 'error' as const, text: error instanceof Error ? error.message : String(error) }
      setNotice(message)
      window.setTimeout(() => setNotice(current => (current === message ? null : current)), 8_000)
    } finally {
      setSaving(false)
    }
  }

  if (loadError) return <div className="banner danger"><Icon name="alert" />读取配置失败：{loadError}</div>
  if (!draft || !original) return <div className="empty-state tall"><p>正在读取配置…</p></div>

  const query = filter.trim().toLowerCase()
  const sections = [...SECTIONS, ...CUSTOM_SECTIONS]
  const visible = sections.filter(section =>
    !query ||
    section.title.toLowerCase().includes(query) ||
    section.id.includes(query) ||
    section.fields.some(field => `${field.label} ${field.path} ${field.hint ?? ''}`.toLowerCase().includes(query)),
  )

  return (
    <>
      <PageHead
        eyebrow="SETTINGS"
        title="配置"
        subtitle="修改 config.yaml。策略项立即生效，其余配置在重启服务后生效。"
        actions={
          changed.length > 0
            ? <span className="unsaved-badge">{changed.length} 项未保存</span>
            : <span className="saved-badge"><Icon name="check" size={13} />已同步</span>
        }
      />

      <div className="config-layout">
        <aside className="config-nav">
          <div className="search-box slim">
            <Icon name="search" size={14} />
            <input value={filter} onChange={event => setFilter(event.target.value)} placeholder="筛选配置项" />
          </div>
          <div className="config-nav-list">
            {sections.map(section => {
              const hasFields = section.fields.length > 0
              const dirty = hasFields ? section.fields.some(field => changed.includes(field.path)) : changed.includes(section.id)
              const invalid = hasFields ? section.fields.some(field => errors.has(field.path)) : errors.has(section.id)
              return (
                <button
                  key={section.id}
                  className={`config-nav-item ${active === section.id ? 'active' : ''}`}
                  onClick={() => {
                    setActive(section.id)
                    document.getElementById(`sec-${section.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
                  }}
                >
                  <span>{section.title}</span>
                  {invalid ? <span className="dot invalid" title="有字段不合法" /> : dirty ? <span className="dot" title="有未保存修改" /> : null}
                </button>
              )
            })}
          </div>
          <div className="config-path" title={configPath}>
            <Icon name="sliders" size={13} />
            <span>{configPath || '配置文件路径未知'}</span>
          </div>
        </aside>

        <div className="config-body">
          {visible.length === 0 && <div className="empty-state"><p>没有匹配的配置项</p></div>}
          {visible.map(section => {
            const dirty = section.fields.length > 0
              ? section.fields.some(field => changed.includes(field.path))
              : changed.includes(section.id)
            return (
              <section key={section.id} id={`sec-${section.id}`} className="settings-card">
                <header className="settings-head">
                  <div>
                    <h2>{section.title}</h2>
                    <p>{section.description}</p>
                  </div>
                  <div className="settings-badges">
                    {section.hot
                      ? <span className="badge hot">立即生效</span>
                      : <span className="badge cold">重启生效</span>}
                    {dirty && <span className="badge dirty">已修改</span>}
                  </div>
                </header>

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
                  <div className="settings-rows">
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
              </section>
            )
          })}
        </div>
      </div>

      <div className={`save-dock ${changed.length > 0 ? 'dirty' : ''} ${errors.size > 0 ? 'invalid' : ''} ${changed.length === 0 && errors.size === 0 && !notice ? 'hidden' : ''}`}>
        <div className="save-status">
          {errors.size > 0
            ? <span className="danger-text"><Icon name="alert" size={13} />{errors.size} 个字段不合法</span>
            : changed.length > 0 ? <span>{changed.length} 项未保存</span> : <span className="muted">配置已同步</span>}
          {notice && <span className={`notice ${notice.kind}`}>{notice.text}</span>}
        </div>
        <div className="save-buttons">
          <button className="btn ghost" onClick={resetAll} disabled={changed.length === 0 || saving}>放弃</button>
          <button className="btn primary" onClick={() => void save()} disabled={changed.length === 0 || errors.size > 0 || saving}>
            {saving ? '保存中…' : '保存配置'}
          </button>
        </div>
      </div>
    </>
  )
}

function FieldRow({ field, value, defaultValue, error, onChange }: {
  field: FieldDef
  value: unknown
  defaultValue: unknown
  error?: string
  onChange: (value: unknown) => void
}): JSX.Element {
  const changedFromDefault = defaultValue !== undefined && JSON.stringify(value) !== JSON.stringify(defaultValue)
  const hint = error
    ? <span className="field-error">{error}</span>
    : <>
        {field.hint && <span>{field.hint}</span>}
        {field.ms && <span>{humanizeMs(value)}</span>}
      </>

  return (
    <div className={`setting ${error ? 'has-error' : ''}`}>
      <div className="setting-info">
        <div className="setting-label">
          <span>{field.label}</span>
          {changedFromDefault && (
            <button
              className="reset-link"
              title={`恢复默认值：${JSON.stringify(defaultValue)}`}
              onClick={() => onChange(defaultValue)}
            >
              恢复默认
            </button>
          )}
        </div>
        {(field.hint || field.ms || error) && <div className="setting-hint">{hint}</div>}
      </div>
      <div className="setting-control">{control(field, value, onChange)}</div>
    </div>
  )
}

function control(field: FieldDef, value: unknown, onChange: (value: unknown) => void): JSX.Element {
  if (field.kind === 'switch') {
    const on = value === true
    return (
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={`toggle ${on ? 'on' : ''}`}
        onClick={() => onChange(!on)}
      >
        <span className="toggle-track"><span className="toggle-knob" /></span>
        <span className="toggle-label">{on ? '开启' : '关闭'}</span>
      </button>
    )
  }
  if (field.kind === 'select') {
    return (
      <span className="select-wrap">
        <select value={String(value ?? '')} onChange={event => onChange(event.target.value)}>
          {field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <Icon name="chevron" size={13} className="select-chevron" />
      </span>
    )
  }
  if (field.kind === 'number') {
    return (
      <span className="input-box">
        <input
          type="number"
          min={field.min}
          max={field.max}
          value={typeof value === 'number' ? value : ''}
          onChange={event => onChange(fromInputValue(event.target.value, 'number'))}
        />
        {field.unit && <span className="input-unit">{field.unit}</span>}
      </span>
    )
  }
  return (
    <input
      className="text-input"
      value={toInputValue(value, field.kind)}
      onChange={event => onChange(fromInputValue(event.target.value, field.kind))}
      placeholder={field.placeholder}
    />
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
      {projects.length === 0 && <p className="editor-empty">还没有项目。没有项目时开单会先追问仓库。</p>}
      {projects.length > 0 && (
        <div className="editor-head">
          <span>项目名</span>
          <span>仓库选择器</span>
          <span>默认分支</span>
          <span>允许分支</span>
          <span />
        </div>
      )}
      {projects.map((project, index) => (
        <div key={index} className="editor-row project-row">
          <input value={project.name} placeholder="router-agent" onChange={event => update(index, { name: event.target.value })} />
          <input value={project.repo} placeholder="name:dsh/router-agent" onChange={event => update(index, { repo: event.target.value })} />
          <input value={project.defaultBranch} placeholder="main" onChange={event => update(index, { defaultBranch: event.target.value })} />
          <input
            value={project.branches.join(', ')}
            placeholder="main, release"
            onChange={event => update(index, { branches: event.target.value.split(',').map(item => item.trim()).filter(Boolean) })}
          />
          <button className="icon-btn danger" title="删除项目" onClick={() => onChange(projects.filter((_, i) => i !== index))}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}
      {error && <p className="field-error">{error}</p>}
      <button className="btn add" onClick={() => onChange([...projects, { name: '', repo: '', defaultBranch: '', branches: [] }])}>
        <Icon name="plus" size={13} />添加项目
      </button>
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
      {chats.length === 0 && <p className="editor-empty">还没有监控群。至少添加一个群，机器人才能收到消息。</p>}
      {chats.length > 0 && (
        <div className="editor-head chat-head">
          <span>chat_id</span>
          <span>接收</span>
          <span>绑定项目</span>
          <span>绑定分支</span>
          <span>补拉</span>
          <span>本群名单</span>
          <span />
        </div>
      )}
      {chats.map((chat, index) => (
        <div key={index} className="editor-row chat-row">
          <input value={chat.chat} placeholder="oc_xxx" onChange={event => update(index, { chat: event.target.value })} />
          <span className="select-wrap compact">
            <select value={chat.mode} onChange={event => update(index, { mode: event.target.value })}>
              <option value="all">全部消息</option>
              <option value="mention">仅 @</option>
            </select>
            <Icon name="chevron" size={12} className="select-chevron" />
          </span>
          <input value={chat.repo} placeholder="可空" onChange={event => update(index, { repo: event.target.value })} />
          <input value={chat.branch} placeholder="可空" onChange={event => update(index, { branch: event.target.value })} />
          <button
            type="button"
            role="switch"
            aria-checked={chat.sync === true}
            className={`toggle small ${chat.sync ? 'on' : ''}`}
            onClick={() => update(index, { sync: !chat.sync })}
          >
            <span className="toggle-track"><span className="toggle-knob" /></span>
          </button>
          <input
            value={chat.allowed.join(', ')}
            placeholder="可空，沿用全局"
            onChange={event => update(index, { allowed: event.target.value.split(',').map(item => item.trim()).filter(Boolean) })}
          />
          <button className="icon-btn danger" title="删除群" onClick={() => onChange(chats.filter((_, i) => i !== index))}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}
      {error && <p className="field-error">{error}</p>}
      <button className="btn add" onClick={() => onChange([...chats, { chat: '', mode: 'all', repo: '', branch: '', sync: false, allowed: [] }])}>
        <Icon name="plus" size={13} />添加群
      </button>
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
  const [status, setStatus] = useState<ServiceStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void getJson<typeof data>('/api/sources/feishu/chats').then(setData).catch(error => setError(String(error)))
    void getJson<ServiceStatus>('/api/status').then(setStatus).catch(error => setError(String(error)))
  }, [])

  if (error) return <div className="banner danger"><Icon name="alert" />{error}</div>
  if (!data) return <div className="empty-state tall"><p>正在读取来源…</p></div>

  const stats = [
    { label: '服务状态', value: status?.stage === 'running' ? '运行中' : status?.stage ?? '—', tone: status?.stage === 'running' ? 'ok' : 'muted' },
    { label: '开放工单', value: String(status?.tickets.open ?? 0), tone: 'ink' },
    { label: '已关闭', value: String(status?.tickets.closed ?? 0), tone: 'muted' },
    { label: 'Worker 运行时', value: status?.runtime ?? '—', tone: 'ink' },
  ]

  return (
    <>
      <PageHead eyebrow="SOURCES" title="来源" subtitle="机器人从哪里收消息，收到后又派到哪里去。" />

      <div className="stat-grid">
        {stats.map(stat => (
          <div key={stat.label} className="stat-card">
            <span className="stat-label">{stat.label}</span>
            <strong className={`stat-value ${stat.tone}`}>{stat.value}</strong>
          </div>
        ))}
      </div>

      <section className="settings-card">
        <header className="settings-head">
          <div>
            <h2>监控群</h2>
            <p>群消息进入 Router 后，会按这里的接收方式与绑定关系决定是否开单、派到哪。</p>
          </div>
          <span className="badge cold">{data.chats.length} 个群</span>
        </header>
        {data.chats.length === 0 ? (
          <p className="editor-empty">还没有配置监控群。</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>群</th>
                <th>接收方式</th>
                <th>派工绑定</th>
                <th>本群名单</th>
              </tr>
            </thead>
            <tbody>
              {data.chats.map(chat => (
                <tr key={chat.chat}>
                  <td className="mono">{chat.chat}</td>
                  <td>{chat.mode === 'mention' ? '仅 @ 机器人' : '全部消息'}</td>
                  <td>{chat.repo ? <span className="mono">{chat.repo}@{chat.branch || '?'}</span> : <span className="muted">开工前追问</span>}</td>
                  <td>{chat.allowed && chat.allowed.length > 0 ? `${chat.allowed.length} 人` : <span className="muted">沿用全局</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="editor-foot">要调整群和绑定，请到「配置 → 群与绑定」。</p>
      </section>

      <section className="settings-card">
        <header className="settings-head">
          <div>
            <h2>接收范围</h2>
            <p>私聊与全局许可名单；群级名单在「群与绑定」里单独配置。</p>
          </div>
        </header>
        <div className="meta-card flush">
          <MetaItem label="私聊" value={data.directMessages ? '接收' : '关闭'} />
          <MetaItem label="全局许可名单" value={data.allowed.join('，') || '—'} />
        </div>
      </section>
    </>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)