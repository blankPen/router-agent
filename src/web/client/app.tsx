import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import {
  FIELD_PATHS,
  SECTIONS,
  fieldError,
  fromInputValue,
  getByPath,
  humanizeMs,
  humanizeTime,
  sectionsFor,
  setByPath,
  toInputValue,
  type FieldDef,
  type RuntimeChoiceView,
  type SectionDef,
} from './fields.js'
import { getJson, saveConfigPatch, sendJson, type ConfigBundle, type ConfigDoc } from './api.js'
import { Icon, LogoMark } from './icons.js'
import { RuntimeCards, type RuntimeNotice } from './runtime-cards.js'
import {
  mergeRuntimeChoices,
  runtimeStatusLabel,
} from './runtime-model.js'
import { ACP_RUNTIME_ID, ORCA_RUNTIME_ID, normalizeRuntimeId } from '../../worker/runtimes/catalog.js'

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

interface ResumeInfo {
  command: string
  sessionId?: string
  note?: string
}

interface TicketDetail {
  ticket: Ticket
  mandate: { strength: string; scope: string; rules: string[]; policyVersion: string } | null
  assignment: { id: string; handle: string; workdir: string; status: string } | null
  reports: Report[]
  inputs: TicketInput[]
  attention: { question: string; createdAt?: string } | null
  resume?: ResumeInfo | null
}

interface ProjectDraft {
  name: string
  repo: string
  defaultBranch: string
}

/** 项目清单按运行时隔离：orca 用顶层 projects，其它运行时用 runtime.projects.<id>。 */
function projectPatchPath(runtimeId: string): string {
  return runtimeId === ORCA_RUNTIME_ID ? 'projects' : `runtime.projects.${runtimeId}`
}

function projectsOf(doc: ConfigDoc, runtimeId: string): ProjectDraft[] {
  const list = runtimeId === ORCA_RUNTIME_ID
    ? doc.projects
    : doc.runtime?.projects?.[runtimeId]
  return Array.isArray(list) ? list as ProjectDraft[] : []
}

function isLocalRepoPath(repo: string): boolean {
  return repo.trim().replace(/^path:/, '').startsWith('/')
}

interface ChatDraft {
  chat: string
  mode: string
  repo: string
  branch: string
  allowed: string[]
}

interface ServiceStatus {
  stage: string
  runtime: string
  pid?: number
  startedAt?: string
  tickets: { open: number; closed: number; byStage: Record<string, number> }
  now: string
}

// ---------------------------------------------------------------------------
// 常量与工具
// ---------------------------------------------------------------------------

const STAGE_ORDER = ['todo', 'running', 'review', 'blocked', 'done']

const STAGE_LABEL: Record<string, string> = {
  todo: '待办',
  running: '进行中',
  review: '审核中',
  blocked: '已阻塞',
  done: '已完成',
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

// ---------------------------------------------------------------------------
// 应用外壳
// ---------------------------------------------------------------------------

type Tab = 'setup' | 'tickets' | 'config' | 'sources'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

type RestartPhase = 'idle' | 'restarting' | 'done' | 'error'

function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('tickets')
  const [status, setStatus] = useState<ServiceStatus | null>(null)
  const [restartPhase, setRestartPhase] = useState<RestartPhase>('idle')
  const [restartError, setRestartError] = useState<string | null>(null)
  // 配置页 / 初始化页共享同一个「有未保存修改」标记，切走前提醒一次。
  const dirtyRef = useRef(false)

  const switchTab = useCallback((next: Tab): void => {
    if (next === tab) return
    if (dirtyRef.current && !confirm('有未保存的配置修改，切换页面后将丢失，继续？')) return
    dirtyRef.current = false
    setTab(next)
  }, [tab])

  useEffect(() => {
    const load = (): void => {
      void getJson<ServiceStatus>('/api/status').then(setStatus).catch(() => undefined)
    }
    load()
    const timer = setInterval(load, 15_000)
    return () => clearInterval(timer)
  }, [])

  const restartDaemon = useCallback(async (): Promise<void> => {
    if (restartPhase === 'restarting') return
    const beforePid = status?.pid
    setRestartPhase('restarting')
    setRestartError(null)
    try {
      await sendJson<{ ok: boolean }>('/api/restart', 'POST', {})
      // 旧进程会先退出、新进程再绑定端口；这里轮询到「pid 变了」或「中途掉线后恢复」为止。
      const deadline = Date.now() + 30_000
      let dropped = false
      while (Date.now() < deadline) {
        await sleep(700)
        try {
          const next = await getJson<ServiceStatus>('/api/status')
          if (dropped || !beforePid || next.pid !== beforePid) {
            setStatus(next)
            setRestartPhase('done')
            setTimeout(() => setRestartPhase(current => current === 'done' ? 'idle' : current), 4_000)
            return
          }
        } catch {
          dropped = true
        }
      }
      throw new Error('重启超时，请检查 ra 服务日志')
    } catch (error) {
      setRestartError(error instanceof Error ? error.message : String(error))
      setRestartPhase('error')
      setTimeout(() => setRestartPhase(current => current === 'error' ? 'idle' : current), 8_000)
    }
  }, [restartPhase, status?.pid])

  const live = status?.stage === 'running'

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><LogoMark size={34} /></span>
          <span className="brand-text">
            <strong>router-agent</strong>
            <small>control room</small>
          </span>
        </div>

        <nav className="side-nav">
          <button className={`nav-tab ${tab === 'setup' ? 'active' : ''}`} onClick={() => switchTab('setup')}>
            <Icon name="zap" />
            <span>初始化</span>
          </button>
          <button className={`nav-tab ${tab === 'tickets' ? 'active' : ''}`} onClick={() => switchTab('tickets')}>
            <Icon name="inbox" />
            <span>工单</span>
            {status && status.tickets.open > 0 && <span className="nav-count">{status.tickets.open}</span>}
          </button>
          <button className={`nav-tab ${tab === 'config' ? 'active' : ''}`} onClick={() => switchTab('config')}>
            <Icon name="sliders" />
            <span>配置</span>
          </button>
          <button className={`nav-tab ${tab === 'sources' ? 'active' : ''}`} onClick={() => switchTab('sources')}>
            <Icon name="radio" />
            <span>来源</span>
          </button>
        </nav>

        <div className="sidebar-foot">
          <span className={`status-dot ${live && restartPhase !== 'restarting' ? 'live' : ''}`} />
          <span className="sidebar-status">
<strong>{restartPhase === 'restarting' ? '正在重启…' : restartPhase === 'done' ? '服务已重启' : restartPhase === 'error' ? '重启失败' : live ? '服务运行中' : status?.stage ?? '未连接'}</strong>
            <small>{restartError ?? (status?.runtime ? `运行时 ${status.runtime}` : 'router-agent')}</small>
          </span>
          <button
            className="icon-btn restart-btn"
            title="重启 ra 服务（页面不刷新）"
            aria-label="重启 ra 服务"
            onClick={() => void restartDaemon()}
            disabled={restartPhase === 'restarting'}
          >
            <Icon name="refresh" size={14} className={restartPhase === 'restarting' ? 'spin' : undefined} />
          </button>
        </div>
      </aside>

      <div className="workspace">
        {tab === 'setup' && (
          <SetupView
            restarting={restartPhase === 'restarting'}
            onRestart={() => void restartDaemon()}
            onOpenConfig={() => switchTab('config')}
            onDirtyChange={dirty => { dirtyRef.current = dirty }}
          />
        )}
        {tab === 'tickets' && <TicketsView />}
        {tab === 'config' && (
          <ConfigView
            restarting={restartPhase === 'restarting'}
            onRestart={() => void restartDaemon()}
            onDirtyChange={dirty => { dirtyRef.current = dirty }}
          />
        )}
        {tab === 'sources' && <SourcesView />}
      </div>
    </div>
  )
}

function PageHead({ title, subtitle, actions }: {
  title: string
  subtitle?: JSX.Element | string
  actions?: JSX.Element
}): JSX.Element {
  return (
    <header className="page-head">
      <div>
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

  const closeDrawer = useCallback((): void => {
    setSelected(null)
    setDetail(null)
    setDetailError(null)
  }, [])

  useEffect(() => {
    if (!selected) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeDrawer()
    }
    window.addEventListener('keydown', onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [selected, closeDrawer])

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const ticket of tickets) map.set(ticket.stage, (map.get(ticket.stage) ?? 0) + 1)
    return map
  }, [tickets])

  const openCount = tickets.filter(ticket => ticket.stage !== 'done').length

  const filtered = useMemo(() => {
    const query = keyword.trim().toLowerCase()
    return tickets.filter(ticket => {
      if (stage !== 'all' && ticket.stage !== stage) return false
      if (!query) return true
      return [ticket.title, ticket.id, ticket.repo, ticket.branch, ticket.prUrl, String(ticket.prNumber)]
        .some(value => String(value ?? '').toLowerCase().includes(query))
    })
  }, [tickets, keyword, stage])

  const columns = STAGE_ORDER
    .filter(item => stage === 'all' || item === stage)
    .map(item => ({ stage: item, items: filtered.filter(ticket => ticket.stage === item) }))

  const refresh = (): void => {
    load()
    if (selected) loadDetail(selected)
  }

  return (
    <>
      <PageHead
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

      <div className="board" role="list" aria-label="工单看板">
        {columns.map(column => (
          <section key={column.stage} className={`board-col stage-${column.stage}`} role="listitem">
            <header className="board-col-head">
              <span className="group-dot" />
              <span>{STAGE_LABEL[column.stage] ?? column.stage}</span>
              <span className="board-col-count">{column.items.length}</span>
            </header>
            <div className="board-col-body">
              {column.items.length === 0 && <div className="board-empty">无任务</div>}
              {column.items.map(ticket => (
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
                    <span className="ticket-foot">
                      <span className="ticket-time">{humanizeTime(ticket.updatedAt)}</span>
                      {ticket.prState !== 'none' && <span className={`pr-badge pr-${ticket.prState}`}>{PR_STATE_LABEL[ticket.prState] ?? ticket.prState}</span>}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>

      {selected && (
        <div className="drawer-layer">
          <button className="drawer-backdrop" aria-label="关闭工单详情" onClick={closeDrawer} />
          <aside className="drawer" role="dialog" aria-modal="true" aria-label="工单详情">
            <div className="drawer-bar">
              <span className="drawer-bar-title">工单详情</span>
              <button className="icon-btn" title="关闭" aria-label="关闭" onClick={closeDrawer} autoFocus>
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="drawer-scroll">
              {detailError && <div className="banner danger"><Icon name="alert" />加载详情失败：{detailError}</div>}
              {!detailError && !detail && <div className="empty-state"><p>正在加载…</p></div>}
              {detail && (
                <TicketDetailView
                  detail={detail}
                  onChanged={() => {
                    load()
                    if (selected) loadDetail(selected)
                  }}
                />
              )}
            </div>
            {detail && detail.ticket.stage !== 'done' && (
              <FollowupComposer
                ticketId={detail.ticket.id}
                onSent={() => {
                  load()
                  if (selected) loadDetail(selected)
                }}
              />
            )}
          </aside>
        </div>
      )}
    </>
  )
}

function StagePill({ stage }: { stage: string }): JSX.Element {
  return <span className={`stage-pill stage-${stage}`}><span className="stage-dot" />{STAGE_LABEL[stage] ?? stage}</span>
}

function TicketDetailView({ detail, onChanged }: { detail: TicketDetail; onChanged: () => void }): JSX.Element {
  const [copied, setCopied] = useState('')
  const { ticket } = detail
  const open = ticket.stage !== 'done'
  const resume = detail.resume

  const copy = async (label: string, value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
      setTimeout(() => setCopied(''), 1500)
    } catch {
      setCopied('复制失败')
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
          {resume && (
            <button
              className="btn"
              title={resume.note ? `${resume.command}\n${resume.note}` : resume.command}
              onClick={() => void copy('resume', resume.command)}
            >
              <Icon name={copied === 'resume' ? 'check' : 'terminal'} size={14} />
              {copied === 'resume' ? '已复制' : '恢复'}
            </button>
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
    </article>
  )
}

function FollowupComposer({ ticketId, onSent }: { ticketId: string; onSent: () => void }): JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      await sendJson(`/api/tickets/${ticketId}/input`, 'POST', { kind: 'followup', text })
      setText('')
      onSent()
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={send} className="composer drawer-composer">
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
  {
    id: 'projects',
    title: '项目与群绑定',
    description: '维护可派工的项目，以及每个群绑定到哪个项目 / 分支。项目清单按 Worker 后端隔离。',
    fields: [],
  },
]

/** 项目清单校验：repo 必填；非 orca 运行时必须是本地绝对路径。 */
function projectIssue(runtimeId: string, projects: ProjectDraft[]): string | null {
  for (const project of projects) {
    if (!String(project.repo || '').trim()) return '每个项目都需要填写 repo'
    if (runtimeId !== ORCA_RUNTIME_ID && !isLocalRepoPath(project.repo)) {
      return 'repo 必须是本地仓库绝对路径（例如 /Users/me/project 或 path:/Users/me/project）'
    }
  }
  return null
}

function chatsIssue(chats: unknown): string | null {
  if (!Array.isArray(chats)) return null
  for (const chat of chats as ChatDraft[]) {
    if (!String(chat.chat || '').trim()) return '每行都需要填写 chat_id'
  }
  return null
}

function ConfigView({ restarting, onRestart, onDirtyChange }: {
  restarting: boolean
  onRestart: () => void
  onDirtyChange?: (dirty: boolean) => void
}): JSX.Element {
  const [original, setOriginal] = useState<ConfigDoc | null>(null)
  const [draft, setDraft] = useState<ConfigDoc | null>(null)
  const [defaults, setDefaults] = useState<ConfigDoc>({})
  const [configPath, setConfigPath] = useState('')
  const [runtimeChoices, setRuntimeChoices] = useState<RuntimeChoiceView[]>([])
  const [detecting, setDetecting] = useState(false)
  const [active, setActive] = useState<string>('policy')
  const [filter, setFilter] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<RuntimeNotice | null>(null)
  const [pendingRestart, setPendingRestart] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // 重启开始后不再提示「需重启」。
  useEffect(() => {
    if (restarting) setPendingRestart(false)
  }, [restarting])

  useEffect(() => {
    void getJson<ConfigBundle>('/api/config')
      .then(data => {
        setOriginal(data.config)
        setDraft(data.config)
        setDefaults(data.defaults)
        setConfigPath(data.configPath)
        setRuntimeChoices(data.runtimeChoices ?? [])
        setDetecting(Boolean(data.detecting))
        setLoadError(null)
      })
      .catch(error => setLoadError(error instanceof Error ? error.message : String(error)))
  }, [])

  // 探测轮询由 RuntimeCards 负责；这里只保留静态目录兜底 + 服务端快照合并。
  const runtimeCatalog = useMemo(() => mergeRuntimeChoices(runtimeChoices), [runtimeChoices])

  const sections = useMemo(() => [...sectionsFor(runtimeChoices), ...CUSTOM_SECTIONS], [runtimeChoices])

  const changed = useMemo(() => {
    if (!draft || !original) return []
    const paths = FIELD_PATHS.filter(path => JSON.stringify(getByPath(draft, path)) !== JSON.stringify(getByPath(original, path)))
    for (const runtime of runtimeCatalog) {
      if (JSON.stringify(projectsOf(draft, runtime.id)) !== JSON.stringify(projectsOf(original, runtime.id))) {
        paths.push(projectPatchPath(runtime.id))
      }
    }
    if (JSON.stringify(draft.feishu?.chats) !== JSON.stringify(original.feishu?.chats)) paths.push('feishu.chats')
    return paths
  }, [draft, original, runtimeCatalog])

  useEffect(() => {
    onDirtyChange?.(changed.length > 0)
  }, [changed.length, onDirtyChange])

  const errors = useMemo(() => {
    if (!draft) return new Map<string, string>()
    const map = new Map<string, string>()
    for (const section of sections) {
      for (const field of section.fields) {
        const message = fieldError(field, getByPath(draft, field.path))
        if (message) map.set(field.path, message)
      }
    }
    const chatMessage = chatsIssue(draft.feishu?.chats)
    if (chatMessage) map.set('feishu.chats', chatMessage)
    for (const runtime of runtimeCatalog) {
      const issue = projectIssue(runtime.id, projectsOf(draft, runtime.id))
      if (issue) map.set(projectPatchPath(runtime.id), `${runtime.label}：${issue}`)
    }
    return map
  }, [draft, sections, runtimeCatalog])

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

  const requestRestart = (): void => {
    if (changed.length > 0 && !confirm('有未保存的修改，重启后不会自动保存，继续？')) return
    onRestart()
  }

  const save = async (): Promise<void> => {
    if (!draft || !original || changed.length === 0 || errors.size > 0) return
    const patch: Record<string, unknown> = {}
    for (const path of changed) patch[path] = getByPath(draft, path)
    setSaving(true)
    setNotice(null)
    try {
      const result = await saveConfigPatch(patch)
      setOriginal(result.config)
      setDraft(result.config)
      setDefaults(result.defaults)
      setConfigPath(result.configPath)
      if (result.runtimeChoices) setRuntimeChoices(result.runtimeChoices)
      if (typeof result.detecting === 'boolean') setDetecting(result.detecting)
      setPendingRestart(result.restartRequired)
      const message = {
        kind: result.restartRequired ? 'warn' as const : 'ok' as const,
        text: result.restartRequired
          ? `已保存 ${result.changed.length} 项，其中部分配置需要重启服务才生效；点右上角「重启服务」即可（页面不会刷新）。`
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
  const runtimeId = normalizeRuntimeId(typeof draft.runtime?.default === 'string' ? draft.runtime.default : ORCA_RUNTIME_ID)
  const runtimeLabel = runtimeCatalog.find(runtime => runtime.id === runtimeId)?.label ?? runtimeId
  const activeProjectsPath = projectPatchPath(runtimeId)
  const activeProjects = projectsOf(draft, runtimeId)
  const projectErrors = runtimeCatalog
    .map(runtime => errors.get(projectPatchPath(runtime.id)))
    .filter((message): message is string => Boolean(message))
    .join('；')
  const visible = sections.filter(section =>
    !query ||
    section.title.toLowerCase().includes(query) ||
    section.id.includes(query) ||
    section.fields.some(field => `${field.label} ${field.path} ${field.hint ?? ''}`.toLowerCase().includes(query)),
  )

  return (
    <>
      <PageHead
        title="配置"
        subtitle="修改 config.yaml。策略项立即生效，其余配置在重启服务后生效。"
        actions={
          <>
            <button className="btn tiny" onClick={requestRestart} disabled={restarting} title="重启 ra 服务，当前页面不会刷新">
              <Icon name="refresh" size={13} className={restarting ? 'spin' : undefined} />
              {restarting ? '重启中…' : '重启服务'}
            </button>
            {changed.length > 0
              ? <span className="unsaved-badge">{changed.length} 项未保存</span>
              : <span className="saved-badge"><Icon name="check" size={13} />已同步</span>}
          </>
        }
      />

      {pendingRestart && (
        <div className="banner warn restart-banner">
          <Icon name="alert" />
          <span>有配置需要重启服务后生效。</span>
          <button className="btn tiny" onClick={requestRestart} disabled={restarting}>
            <Icon name="refresh" size={12} className={restarting ? 'spin' : undefined} />
            {restarting ? '重启中…' : '立即重启'}
          </button>
        </div>
      )}

      <div className="config-layout">
        <aside className="config-nav">
          <div className="search-box slim">
            <Icon name="search" size={14} />
            <input value={filter} onChange={event => setFilter(event.target.value)} placeholder="筛选配置项" />
          </div>
          <div className="config-nav-list">
            {sections.map(section => {
              const hasFields = section.fields.length > 0
              const projectSection = section.id === 'projects'
              const dirty = hasFields
                ? section.fields.some(field => changed.includes(field.path))
                : projectSection
                  ? runtimeCatalog.some(runtime => changed.includes(projectPatchPath(runtime.id))) || changed.includes('feishu.chats')
                  : changed.includes(section.id)
              const invalid = hasFields
                ? section.fields.some(field => errors.has(field.path))
                : projectSection
                  ? runtimeCatalog.some(runtime => errors.has(projectPatchPath(runtime.id))) || errors.has('feishu.chats')
                  : errors.has(section.id)
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
              : section.id === 'projects'
                ? runtimeCatalog.some(runtime => changed.includes(projectPatchPath(runtime.id))) || changed.includes('feishu.chats')
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
                  <>
                    <div className="editor-block">
                      <h3 className="editor-subtitle">项目清单</h3>
                      <p className="editor-hint">
                        当前编辑：<strong>{runtimeLabel}</strong> 的项目清单。项目按运行时隔离，切换上方「Worker 运行时」即可编辑另一套。
                      </p>
                      <ProjectsEditor
                        runtimeId={runtimeId}
                        projects={activeProjects}
                        error={projectErrors || undefined}
                        onChange={value => setField(activeProjectsPath, value)}
                      />
                    </div>
                    <div className="editor-block">
                      <h3 className="editor-subtitle">群与绑定</h3>
                      <p className="editor-hint">配置监控哪些群、收全部消息还是只收 @；绑定项目只能从当前后端的项目清单里选，分支自动跟随项目的默认分支。</p>
                      <ChatsEditor
                        chats={draft.feishu?.chats ?? []}
                        projects={activeProjects}
                        error={errors.get('feishu.chats')}
                        onChange={value => setField('feishu.chats', value)}
                      />
                    </div>
                  </>
                )}

                {section.id === 'delivery' && (
                  <RuntimeCards
                    choices={runtimeChoices}
                    detecting={detecting}
                    selected={runtimeId}
                    onSelect={id => setField('runtime.default', id)}
                    onChoices={setRuntimeChoices}
                    onDetecting={setDetecting}
                    onNotice={setNotice}
                    onPendingRestart={() => setPendingRestart(true)}
                  />
                )}

                {section.fields.length > 0 && (
                  <div className="settings-rows">
                    {section.fields
                      .filter(field => field.path !== 'runtime.default')
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

      <SaveDock
        changed={changed}
        errors={errors}
        notice={notice}
        saving={saving}
        onReset={resetAll}
        onSave={() => void save()}
      />
    </>
  )
}

function SaveDock({ changed, errors, notice, saving, onReset, onSave }: {
  changed: string[]
  errors: Map<string, string>
  notice: RuntimeNotice | null
  saving: boolean
  onReset: () => void
  onSave: () => void
}): JSX.Element {
  return (
    <div className={`save-dock ${changed.length > 0 ? 'dirty' : ''} ${errors.size > 0 ? 'invalid' : ''} ${changed.length === 0 && errors.size === 0 && !notice ? 'hidden' : ''}`}>
      <div className="save-status">
        {errors.size > 0
          ? <span className="danger-text"><Icon name="alert" size={13} />{errors.size} 个字段不合法</span>
          : changed.length > 0 ? <span>{changed.length} 项未保存</span> : <span className="muted">配置已同步</span>}
        {notice && <span className={`notice ${notice.kind}`}>{notice.text}</span>}
      </div>
      <div className="save-buttons">
        <button className="btn ghost" onClick={onReset} disabled={changed.length === 0 || saving}>放弃</button>
        <button className="btn primary" onClick={onSave} disabled={changed.length === 0 || errors.size > 0 || saving}>
          {saving ? '保存中…' : '保存配置'}
        </button>
      </div>
    </div>
  )
}

const SETUP_FEISHU_FIELDS: FieldDef[] = (() => {
  const all = SECTIONS.flatMap(section => section.fields)
  return ['feishu.appId', 'feishu.larkHome', 'feishu.directMessages']
    .map(path => all.find(field => field.path === path))
    .filter((field): field is FieldDef => Boolean(field))
})()

/** 初始化页：只做启动必需项（运行时 / 项目 / 飞书 / 群），其余配置留在「配置」页。 */
function SetupView({ restarting, onRestart, onOpenConfig, onDirtyChange }: {
  restarting: boolean
  onRestart: () => void
  onOpenConfig: () => void
  onDirtyChange?: (dirty: boolean) => void
}): JSX.Element {
  const [original, setOriginal] = useState<ConfigDoc | null>(null)
  const [draft, setDraft] = useState<ConfigDoc | null>(null)
  const [defaults, setDefaults] = useState<ConfigDoc>({})
  const [configPath, setConfigPath] = useState('')
  const [runtimeChoices, setRuntimeChoices] = useState<RuntimeChoiceView[]>([])
  const [detecting, setDetecting] = useState(false)
  const [feishuMode, setFeishuMode] = useState<'reuse' | 'dedicated'>('reuse')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<RuntimeNotice | null>(null)
  const [pendingRestart, setPendingRestart] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // 重启开始后不再提示「需重启」。
  useEffect(() => {
    if (restarting) setPendingRestart(false)
  }, [restarting])

  useEffect(() => {
    void getJson<ConfigBundle>('/api/config')
      .then(data => {
        setOriginal(data.config)
        setDraft(data.config)
        setDefaults(data.defaults)
        setConfigPath(data.configPath)
        setRuntimeChoices(data.runtimeChoices ?? [])
        setDetecting(Boolean(data.detecting))
        setFeishuMode(data.config.feishu?.appId || data.config.feishu?.larkHome ? 'dedicated' : 'reuse')
        setLoadError(null)
      })
      .catch(error => setLoadError(error instanceof Error ? error.message : String(error)))
  }, [])

  const runtimeCatalog = useMemo(() => mergeRuntimeChoices(runtimeChoices), [runtimeChoices])
  const runtimeId = normalizeRuntimeId(
    draft && typeof draft.runtime?.default === 'string' ? draft.runtime.default : ORCA_RUNTIME_ID,
  )
  const activeProjectsPath = projectPatchPath(runtimeId)
  const activeProjects = draft ? projectsOf(draft, runtimeId) : []
  const runtimeLabel = runtimeCatalog.find(runtime => runtime.id === runtimeId)?.label ?? runtimeId

  const changed = useMemo(() => {
    if (!draft || !original) return []
    const paths = ['runtime.default', 'feishu.appId', 'feishu.larkHome', 'feishu.directMessages', 'feishu.chats']
    for (const runtime of runtimeCatalog) paths.push(projectPatchPath(runtime.id))
    return paths.filter(path => JSON.stringify(getByPath(draft, path)) !== JSON.stringify(getByPath(original, path)))
  }, [draft, original, runtimeCatalog])

  useEffect(() => {
    onDirtyChange?.(changed.length > 0)
  }, [changed.length, onDirtyChange])

  const errors = useMemo(() => {
    const map = new Map<string, string>()
    if (!draft) return map
    const changedSet = new Set(changed)
    for (const field of SETUP_FEISHU_FIELDS) {
      const message = fieldError(field, getByPath(draft, field.path))
      if (message) map.set(field.path, message)
    }
    if (feishuMode === 'dedicated' && !String(draft.feishu?.appId ?? '').trim() && !String(draft.feishu?.larkHome ?? '').trim()) {
      map.set('feishu.appId', '专属机器人至少填写 App ID 或配置目录')
    }
    if (changedSet.has('feishu.chats')) {
      const chatMessage = chatsIssue(draft.feishu?.chats)
      if (chatMessage) map.set('feishu.chats', chatMessage)
    }
    for (const runtime of runtimeCatalog) {
      const path = projectPatchPath(runtime.id)
      // 只校验当前运行时的清单 + 本次确实要提交的其它清单，避免历史脏数据挡住保存。
      if (runtime.id !== runtimeId && !changedSet.has(path)) continue
      const issue = projectIssue(runtime.id, projectsOf(draft, runtime.id))
      if (issue) map.set(path, `${runtime.label}：${issue}`)
    }
    // 自定义 acp 没有 command 时重启会直接启动失败，保存前就挡住。
    const selected = runtimeCatalog.find(runtime => runtime.id === runtimeId)
    if (runtimeId === ACP_RUNTIME_ID && selected?.status === 'not-installed') {
      map.set('runtime.default', '自定义 acp 未配置 runtime.options.acp.command，重启后服务会启动失败')
    }
    return map
  }, [draft, changed, feishuMode, runtimeCatalog, runtimeId])

  const setField = (path: string, value: unknown): void => {
    setDraft(current => (current ? setByPath(current, path, value) : current))
    setNotice(null)
  }

  const resetAll = (): void => {
    if (!original) return
    if (!confirm('放弃所有未保存的修改？')) return
    setDraft(structuredClone(original))
    setFeishuMode(original.feishu?.appId || original.feishu?.larkHome ? 'dedicated' : 'reuse')
    setNotice(null)
  }

  const requestRestart = (): void => {
    if (changed.length > 0 && !confirm('有未保存的修改，重启后不会自动保存，继续？')) return
    onRestart()
  }

  const save = async (): Promise<void> => {
    if (!draft || !original || changed.length === 0 || errors.size > 0) return
    const patch: Record<string, unknown> = {}
    for (const path of changed) patch[path] = getByPath(draft, path)
    setSaving(true)
    setNotice(null)
    try {
      const result = await saveConfigPatch(patch)
      setOriginal(result.config)
      setDraft(result.config)
      setDefaults(result.defaults)
      setConfigPath(result.configPath)
      if (result.runtimeChoices) setRuntimeChoices(result.runtimeChoices)
      if (typeof result.detecting === 'boolean') setDetecting(result.detecting)
      setPendingRestart(result.restartRequired)
      const message = {
        kind: result.restartRequired ? 'warn' as const : 'ok' as const,
        text: result.restartRequired
          ? `已保存 ${result.changed.length} 项，重启服务后生效；点上方「立即重启」即可。`
          : `已保存 ${result.changed.length} 项，已立即生效。`,
      }
      setNotice(message)
      window.setTimeout(() => setNotice(current => (current === message ? null : current)), 8_000)
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

  const chats = (draft.feishu?.chats ?? []) as ChatDraft[]
  const runtimeChoice = runtimeCatalog.find(choice => choice.id === runtimeId)
  const runtimeReady = runtimeChoice?.status === 'ready' || runtimeChoice?.status === 'unverified'
  const projectReady = activeProjects.length > 0 && !projectIssue(runtimeId, activeProjects)
  const feishuReady = feishuMode === 'reuse'
    || Boolean(String(draft.feishu?.appId ?? '').trim() || String(draft.feishu?.larkHome ?? '').trim())
  const chatReady = chats.length > 0 && !chatsIssue(chats)
  const steps = [
    { label: '运行时可用', hint: runtimeReady ? '已就绪' : runtimeChoice ? runtimeStatusLabel(runtimeChoice.status) : '未选择', done: runtimeReady },
    { label: '已登记项目', hint: projectReady ? `${activeProjects.length} 个项目` : '至少一个', done: projectReady },
    { label: '飞书已接入', hint: feishuMode === 'reuse' ? '复用当前 profile' : '专属机器人', done: feishuReady },
    { label: '监控群已添加', hint: chatReady ? `${chats.length} 个群` : '至少一个', done: chatReady },
  ]
  const completed = steps.filter(step => step.done).length
  const directMessagesField = SETUP_FEISHU_FIELDS.find(field => field.path === 'feishu.directMessages')
  const missingBindings = chats.filter(chat => chat.repo && !activeProjects.some(project => project.name === chat.repo))

  return (
    <>
      <PageHead
        title="初始化配置"
        subtitle="只配置服务跑起来必需的四件事；人格、会话复用、闲置治理等高级项仍在「配置」里。"
        actions={
          <>
            <button className="btn tiny" onClick={onOpenConfig}>
              <Icon name="sliders" size={13} />
              完整配置
            </button>
            <button className="btn tiny" onClick={requestRestart} disabled={restarting}>
              <Icon name="refresh" size={13} className={restarting ? 'spin' : undefined} />
              {restarting ? '重启中…' : '重启服务'}
            </button>
            <span className={completed === steps.length ? 'saved-badge' : 'unsaved-badge'}>
              {completed}/{steps.length} 已完成
            </span>
          </>
        }
      />

      {pendingRestart && (
        <div className="banner warn restart-banner">
          <Icon name="alert" />
          <span>有配置需要重启服务后生效。</span>
          <button className="btn tiny" onClick={requestRestart} disabled={restarting}>
            <Icon name="refresh" size={12} className={restarting ? 'spin' : undefined} />
            {restarting ? '重启中…' : '立即重启'}
          </button>
        </div>
      )}

      <div className="setup-progress">
        {steps.map((step, index) => (
          <div key={step.label} className={`setup-step ${step.done ? 'done' : ''}`}>
            <span className="setup-step-index">{step.done ? <Icon name="check" size={12} /> : index + 1}</span>
            <div>
              <strong>{step.label}</strong>
              <small>{step.hint}</small>
            </div>
          </div>
        ))}
      </div>

      <section className="settings-card" id="setup-runtime">
        <header className="settings-head">
          <div>
            <h2>1. 选择运行时</h2>
            <p>只能选一个作为 Worker 后端。卡片会检测 CLI 是否安装、ACP 依赖是否齐全，并支持引导安装与握手试启动。</p>
          </div>
          <div className="settings-badges">
            {runtimeReady ? <span className="badge hot">已就绪</span> : <span className="badge cold">未完成</span>}
          </div>
        </header>
        {errors.get('runtime.default') && <p className="field-error">{errors.get('runtime.default')}</p>}
        <RuntimeCards
          choices={runtimeChoices}
          detecting={detecting}
          selected={runtimeId}
          onSelect={id => setField('runtime.default', id)}
          onChoices={setRuntimeChoices}
          onDetecting={setDetecting}
          onNotice={setNotice}
          onPendingRestart={() => setPendingRestart(true)}
        />
      </section>

      <section className="settings-card" id="setup-projects">
        <header className="settings-head">
          <div>
            <h2>2. 登记项目</h2>
            <p>当前运行时：<strong>{runtimeLabel}</strong>。至少登记一个项目，群绑定才能选；非 orca 运行时填本地仓库绝对路径。</p>
          </div>
          <div className="settings-badges">
            {projectReady ? <span className="badge hot">已完成</span> : <span className="badge cold">未完成</span>}
          </div>
        </header>
        <ProjectsEditor
          runtimeId={runtimeId}
          projects={activeProjects}
          error={errors.get(activeProjectsPath)}
          onChange={value => setField(activeProjectsPath, value)}
        />
      </section>

      <section className="settings-card" id="setup-feishu">
        <header className="settings-head">
          <div>
            <h2>3. 飞书接入</h2>
            <p>机器人身份来自 lark-cli profile：可以复用当前登录，也可以给 router-agent 指定专属配置目录。</p>
          </div>
          <div className="settings-badges">
            {feishuReady ? <span className="badge hot">已完成</span> : <span className="badge cold">未完成</span>}
          </div>
        </header>
        <div className="segmented">
          <button
            className={feishuMode === 'reuse' ? 'active' : ''}
            onClick={() => {
              setFeishuMode('reuse')
              setField('feishu.appId', '')
              setField('feishu.larkHome', '')
            }}
          >
            复用当前 lark-cli profile
          </button>
          <button className={feishuMode === 'dedicated' ? 'active' : ''} onClick={() => setFeishuMode('dedicated')}>
            专属机器人
          </button>
        </div>
        {feishuMode === 'reuse' ? (
          <p className="editor-hint">将清空 <code>feishu.appId</code> / <code>feishu.larkHome</code>，直接复用终端里 lark-cli 当前登录的机器人。</p>
        ) : (
          <div className="settings-rows">
            {SETUP_FEISHU_FIELDS.filter(field => field.path !== 'feishu.directMessages').map(field => (
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
        {directMessagesField && (
          <div className="settings-rows">
            <FieldRow
              field={directMessagesField}
              value={getByPath(draft, directMessagesField.path)}
              defaultValue={getByPath(defaults, directMessagesField.path)}
              error={errors.get(directMessagesField.path)}
              onChange={value => setField(directMessagesField.path, value)}
            />
          </div>
        )}
      </section>

      <section className="settings-card" id="setup-chats">
        <header className="settings-head">
          <div>
            <h2>4. 群与绑定</h2>
            <p>至少添加一个监控群；绑定项目后 Router 开工不再追问，分支跟随项目默认分支。</p>
          </div>
          <div className="settings-badges">
            {chatReady ? <span className="badge hot">已完成</span> : <span className="badge cold">未完成</span>}
          </div>
        </header>
        {missingBindings.length > 0 && (
          <div className="banner warn compact">
            <Icon name="alert" size={14} />
            <span>{missingBindings.length} 个群绑定的项目不在当前运行时清单里：{missingBindings.map(chat => chat.repo).join('、')}。请重新选择，或回到「配置」页调整。</span>
          </div>
        )}
        <ChatsEditor
          chats={chats}
          projects={activeProjects}
          error={errors.get('feishu.chats')}
          onChange={value => setField('feishu.chats', value)}
        />
      </section>

      <p className="editor-foot setup-config-path">配置文件：{configPath || '未知'}。保存后如需生效，请点上方「立即重启」。</p>

      <SaveDock
        changed={changed}
        errors={errors}
        notice={notice}
        saving={saving}
        onReset={resetAll}
        onSave={() => void save()}
      />
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
          {field.options?.map(option => (
            <option
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              title={option.reason ?? option.hint}
            >
              {option.label}
            </option>
          ))}
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

function ProjectsEditor({ runtimeId, projects, error, onChange }: {
  runtimeId: string
  projects: ProjectDraft[]
  error?: string
  onChange: (value: ProjectDraft[]) => void
}): JSX.Element {
  const isOrca = runtimeId === ORCA_RUNTIME_ID
  const update = (index: number, patch: Partial<ProjectDraft>): void => {
    onChange(projects.map((project, i) => (i === index ? { ...project, ...patch } : project)))
  }
  return (
    <div className="editor">
      {projects.length === 0 && <p className="editor-empty">该运行时还没有项目。没有项目时开单会先追问仓库。</p>}
      {projects.length > 0 && (
        <div className="editor-head">
          <span>项目名</span>
          <span>{isOrca ? 'Orca 选择器' : '本地仓库路径'}</span>
          <span>默认分支</span>
          <span />
        </div>
      )}
      {projects.map((project, index) => (
        <div key={index} className="editor-row project-row">
          <input value={project.name} placeholder="router-agent" onChange={event => update(index, { name: event.target.value })} />
          <input
            value={project.repo}
            placeholder={isOrca ? 'name:dsh/router-agent' : '/Users/me/router-agent'}
            onChange={event => update(index, { repo: event.target.value })}
          />
          <input value={project.defaultBranch} placeholder="main" onChange={event => update(index, { defaultBranch: event.target.value })} />
          <button className="icon-btn danger" title="删除项目" onClick={() => onChange(projects.filter((_, i) => i !== index))}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}
      {error && <p className="field-error">{error}</p>}
      <button className="btn add" onClick={() => onChange([...projects, { name: '', repo: '', defaultBranch: '' }])}>
        <Icon name="plus" size={13} />添加项目
      </button>
    </div>
  )
}

function ChatsEditor({ chats, projects, error, onChange }: {
  chats: ChatDraft[]
  projects: ProjectDraft[]
  error?: string
  onChange: (value: ChatDraft[]) => void
}): JSX.Element {
  const projectOf = (name: string): ProjectDraft | undefined => projects.find(project => project.name === name)
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
          <span className="select-wrap compact">
            <select
              value={chat.repo}
              onChange={event => {
                const name = event.target.value
                update(index, { repo: name, branch: projectOf(name)?.defaultBranch ?? '' })
              }}
            >
              <option value="">不绑定（开工前追问）</option>
              {projects.map(project => <option key={project.name} value={project.name}>{project.name}</option>)}
              {chat.repo && !projectOf(chat.repo) && <option value={chat.repo}>{chat.repo}（不在当前清单）</option>}
            </select>
            <Icon name="chevron" size={12} className="select-chevron" />
          </span>
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
      <button className="btn add" onClick={() => onChange([...chats, { chat: '', mode: 'all', repo: '', branch: '', allowed: [] }])}>
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
      <PageHead title="来源" subtitle="机器人从哪里收消息，收到后又派到哪里去。" />

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
        <p className="editor-foot">要调整群和绑定，请到「配置 → 项目与群绑定」。</p>
      </section>

      <section className="settings-card">
        <header className="settings-head">
          <div>
            <h2>接收范围</h2>
            <p>私聊与全局许可名单；群级名单在「项目与群绑定」里单独配置。</p>
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