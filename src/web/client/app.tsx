import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import {
  FIELD_PATHS,
  LLM_FIELDS,
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
import {
  importLocalProvider,
  listLocalProviders,
  getJson,
  saveConfigPatch,
  sendJson,
  type ConfigBundle,
  type ConfigDoc,
  type ConfigSaveResult,
  type LocalProviderImportResult,
  type LocalProviderList,
  type LocalProviderView,
} from './api.js'
import { Icon, LogoMark } from './icons.js'
import {
  describeEntry,
  problemEntries,
  summarizeBot,
  summarizeIdentity,
  type IdentityStatusView,
} from './identity-status.js'
import { RuntimeCards, type RuntimeNotice } from './runtime-cards.js'
import { FeishuBotPanel } from './feishu-panel.js'
import { SpecsEditor } from './specs-editor.js'
import {
  mergeRuntimeChoices,
  runtimeStatusLabel,
} from './runtime-model.js'
import { hashForTab, tabFromHash, type Tab } from './tabs.js'
import { THEME_MODE_LABEL, nextThemeMode, useThemeMode, type ThemeMode } from './theme.js'
import {
  readSkippedVersion,
  updateBannerVisible,
  writeSkippedVersion,
  type UpdateRunPhase,
  type UpdateSnapshot,
} from './update.js'
import { ACP_RUNTIME_ID, ORCA_RUNTIME_ID, normalizeRuntimeId } from '../../worker/runtimes/catalog.js'
import type {
  WorkspaceCleanupResultView,
  WorkspaceOverviewView,
  WorkspaceRuntimeGroupView,
  WorkspaceSkipView,
} from '../../worker/workspaces/overview.js'

/** 三态各自一个图标：跟随系统用显示器，亮色用太阳，暗色用月亮。 */
const THEME_ICON: Record<ThemeMode, 'monitor' | 'sun' | 'moon'> = {
  system: 'monitor',
  light: 'sun',
  dark: 'moon',
}

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
  /** 当前服务进程实际运行的版本；旧版服务没有该字段。 */
  version?: string
  runtime: string
  pid?: number
  startedAt?: string
  tickets: { open: number; closed: number; byStage: Record<string, number> }
  now: string
}

interface LogEntry {
  at: string
  level: string
  message: string
  data?: Record<string, unknown>
}

interface LogBatch {
  path: string
  exists: boolean
  size: number
  cursor: number
  entries: LogEntry[]
  more?: boolean
  reset?: boolean
}

/** 面板缓冲区里的一行：seq 只用于 React key，保证前插/截断时列表不串位。 */
interface LogLine extends LogEntry {
  seq: number
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

const LOG_LEVELS = ['all', 'info', 'warn', 'error', 'raw'] as const
const LOG_LEVEL_LABEL: Record<string, string> = { all: '全部', info: 'INFO', warn: 'WARN', error: 'ERROR', raw: 'TEXT' }
const LOG_LEVEL_COLOR: Record<string, string> = {
  // 颜色只落在状态上：总数用中性灰，其余按级别取语义色。
  all: 'var(--muted)',
  info: 'var(--info)',
  warn: 'var(--warning)',
  error: 'var(--negative)',
  raw: 'var(--faint)',
}
/** 面板最多保留的日志行数；超出后从最旧的开始丢，避免长时间开着吃内存。 */
const LOG_BUFFER_MAX = 2_000
const LOG_POLL_MS = 2_000

// ---------------------------------------------------------------------------
// 应用外壳
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

type RestartPhase = 'idle' | 'restarting' | 'done' | 'error'

function App(): JSX.Element {
  // `ra start` 会带 #setup 打开面板；刷新时也从 hash 恢复当前页签。
  const [tab, setTab] = useState<Tab>(() => tabFromHash(window.location.hash) ?? 'tickets')
  const [status, setStatus] = useState<ServiceStatus | null>(null)
  const [restartPhase, setRestartPhase] = useState<RestartPhase>('idle')
  const [restartError, setRestartError] = useState<string | null>(null)
  // 版本更新是独立于「重启服务」的流程：安装成功后服务会自动重启，面板轮询到新 pid 再收尾。
  const [updateInfo, setUpdateInfo] = useState<UpdateSnapshot | null>(null)
  const [skippedVersion, setSkippedVersion] = useState<string | null>(readSkippedVersion)
  const [updatePhase, setUpdatePhase] = useState<UpdateRunPhase>('idle')
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [updatedTo, setUpdatedTo] = useState<string | null>(null)
  // 主题是纯前端偏好：不进配置页，也不写服务端配置，只落在浏览器 localStorage。
  const theme = useThemeMode()
  const nextTheme = nextThemeMode(theme.mode, theme.systemDark)
  // 配置页 / 初始化页共享同一个「有未保存修改」标记，切走前提醒一次。
  const dirtyRef = useRef(false)
  // 窄屏下导航横向滚动，切页时把当前项滚进可视区，避免选中项被裁在屏幕外。
  const navRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    navRef.current?.querySelector<HTMLElement>('.nav-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [tab])

  const switchTab = useCallback((next: Tab): void => {
    if (next === tab) return
    if (dirtyRef.current && !confirm('有未保存的配置修改，切换页面后将丢失，继续？')) return
    dirtyRef.current = false
    setTab(next)
    // 让地址栏与当前页签保持同步：刷新页面或分享链接时能回到同一页。
    window.history.replaceState(null, '', hashForTab(next))
  }, [tab])

  // 外部直接改 hash（例如再次执行 ra start）时切到对应页签。
  useEffect(() => {
    const sync = (): void => {
      const next = tabFromHash(window.location.hash)
      if (next && next !== tab) setTab(next)
    }
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [tab])

  useEffect(() => {
    const load = (): void => {
      void getJson<ServiceStatus>('/api/status').then(setStatus).catch(() => undefined)
    }
    load()
    const timer = setInterval(load, 15_000)
    return () => clearInterval(timer)
  }, [])

  // 版本状态由服务端缓存（启动查一次 + 每 6 小时刷新）；面板只低频读快照，避免每次开页都打 registry。
  useEffect(() => {
    const load = (): void => {
      void getJson<UpdateSnapshot>('/api/update').then(setUpdateInfo).catch(() => undefined)
    }
    load()
    const timer = setInterval(load, 30 * 60_000)
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

  /** 安装最新版；成功后服务由后端在响应结束后自动重启，这里只负责把界面跟进到新版本。 */
  const runUpdate = useCallback(async (): Promise<void> => {
    if (updatePhase === 'updating' || updatePhase === 'restarting') return
    const beforePid = status?.pid
    const target = updateInfo?.latest ?? null
    setUpdatePhase('updating')
    setUpdateError(null)
    try {
      const result = await sendJson<UpdateSnapshot & { restarting?: boolean }>('/api/update', 'POST', {})
      setUpdateInfo(result)
      if (result.phase === 'failed') throw new Error(result.message ?? result.error ?? '更新失败')
      if (!result.restarting) {
        // 已是最新版本，或服务没在运行：不需要等重启。
        setUpdatedTo(result.installedVersion ?? null)
        setUpdatePhase('done')
        setTimeout(() => setUpdatePhase(current => current === 'done' ? 'idle' : current), 6_000)
        return
      }
      setUpdatePhase('restarting')
      const deadline = Date.now() + 60_000
      let dropped = false
      while (Date.now() < deadline) {
        await sleep(800)
        try {
          const next = await getJson<ServiceStatus>('/api/status')
          if (dropped || !beforePid || next.pid !== beforePid) {
            setStatus(next)
            setUpdatedTo(next.version ?? target)
            setSkippedVersion(null)
            writeSkippedVersion(null)
            setUpdatePhase('done')
            // 新进程的检查缓存可能还是空的；读不到就先本地隐藏提示，避免又弹旧版本。
            void getJson<UpdateSnapshot>('/api/update').then(setUpdateInfo).catch(() => {
              setUpdateInfo(previous => (previous ? { ...previous, hasUpdate: false } : previous))
            })
            setTimeout(() => setUpdatePhase(current => current === 'done' ? 'idle' : current), 6_000)
            return
          }
        } catch {
          dropped = true
        }
      }
      throw new Error('更新已安装，但服务重启超时；请手动执行 ra stop && ra start')
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error))
      setUpdatePhase('error')
      setTimeout(() => setUpdatePhase(current => current === 'error' ? 'idle' : current), 10_000)
    }
  }, [updatePhase, status?.pid, updateInfo?.latest])

  /** 忽略当前版本：下次 npm 上出现更高版本还会再提示。 */
  const dismissUpdate = useCallback((): void => {
    const version = updateInfo?.latest ?? null
    writeSkippedVersion(version)
    setSkippedVersion(version)
  }, [updateInfo?.latest])

  const live = status?.stage === 'running'
  const showUpdateBanner = updateBannerVisible(updateInfo, skippedVersion, updatePhase)
  const footerDetail = restartError ?? (status
    ? [status.version ? `v${status.version}` : null, status.runtime ? `运行时 ${status.runtime}` : null].filter(Boolean).join(' · ') || 'router-agent'
    : 'router-agent')

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><LogoMark size={34} /></span>
          <span className="brand-text">
            <strong>router-agent</strong>
            <small>control room</small>
          </span>
          <button
            className="icon-btn theme-toggle"
            title={`主题：${THEME_MODE_LABEL[theme.mode]}，点击切换到${THEME_MODE_LABEL[nextTheme]}`}
            aria-label={`主题：${THEME_MODE_LABEL[theme.mode]}，点击切换到${THEME_MODE_LABEL[nextTheme]}`}
            onClick={() => theme.setMode(nextTheme)}
          >
            <Icon name={THEME_ICON[theme.mode]} size={15} />
          </button>
        </div>

        <nav className="side-nav" ref={navRef}>
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
          {/* 日志是排障时的末位入口，放在菜单最后，日常操作优先。 */}
          <button className={`nav-tab ${tab === 'logs' ? 'active' : ''}`} onClick={() => switchTab('logs')}>
            <Icon name="file-text" />
            <span>日志</span>
          </button>
        </nav>

        <div className="sidebar-bottom">
          {/* 更新提示贴在「服务启动状态」上方；窄屏退化为右下角悬浮按钮。 */}
          {showUpdateBanner && (
            <UpdateNotice
              snapshot={updateInfo}
              phase={updatePhase}
              error={updateError}
              updatedTo={updatedTo}
              onUpdate={() => void runUpdate()}
              onDismiss={dismissUpdate}
            />
          )}
          <div className="sidebar-foot">
            <span className={`status-dot ${live && restartPhase !== 'restarting' ? 'live' : ''}`} />
            <span className="sidebar-status">
<strong>{restartPhase === 'restarting' ? '正在重启…' : restartPhase === 'done' ? '服务已重启' : restartPhase === 'error' ? '重启失败' : live ? '服务运行中' : status?.stage ?? '未连接'}</strong>
              <small>{footerDetail}</small>
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
        </div>
      </aside>

      {/* key 绑 tab：切页时重建滚动容器，回到页面顶部而不是沿用上一页的滚动位置。 */}
      <div className={`workspace tab-${tab}`} key={tab}>
        {tab === 'setup' && (
          <SetupView
            restarting={restartPhase === 'restarting'}
            onRestart={() => void restartDaemon()}
            onOpenConfig={() => switchTab('config')}
            onDirtyChange={dirty => { dirtyRef.current = dirty }}
          />
        )}
        {tab === 'tickets' && <TicketsView />}
        {tab === 'logs' && <LogsView />}
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

function UpdateNotice({ snapshot, phase, error, updatedTo, onUpdate, onDismiss }: {
  snapshot: UpdateSnapshot | null
  phase: UpdateRunPhase
  error: string | null
  updatedTo: string | null
  onUpdate: () => void
  onDismiss: () => void
}): JSX.Element {
  const target = snapshot?.latest ?? updatedTo
  const busy = phase === 'updating' || phase === 'restarting'
  const title = phase === 'updating'
    ? `正在更新 v${target ?? ''}…`
    : phase === 'restarting'
      ? '正在重启服务…'
      : phase === 'done'
        ? updatedTo ? `已更新到 v${updatedTo}` : '已是最新版本'
        : phase === 'error'
          ? '更新失败'
          : `新版本 v${target ?? ''}`
  const detail = phase === 'error'
    ? error ?? '查看 ra 日志后重试'
    : phase === 'done'
      ? updatedTo ? '服务已按新版本重启' : '无需更新'
      : phase === 'idle'
        ? `当前 v${snapshot?.current ?? '-'}`
        : phase === 'updating' ? '安装完成后自动重启' : '等待新进程接管'
  return (
    <div className={`update-notice ${phase}`} role="status" title={phase === 'error' ? detail : undefined}>
      <div className="update-notice-head">
        <span className="update-notice-icon">
          <Icon
            name={phase === 'error' ? 'alert' : phase === 'done' ? 'check' : busy ? 'refresh' : 'download'}
            size={14}
            className={busy ? 'spin' : undefined}
          />
        </span>
        <span className="update-notice-copy">
          <strong>{title}</strong>
          <small>{detail}</small>
        </span>
        {phase === 'idle' && (
          <button className="icon-btn update-dismiss" title="忽略这个版本" aria-label="忽略这个版本" onClick={onDismiss}>
            <Icon name="close" size={12} />
          </button>
        )}
      </div>
      {phase === 'idle' && (
        <button className="btn primary update-now" title="安装最新版本并自动重启服务" onClick={onUpdate}>
          更新并重启
        </button>
      )}
      {phase === 'error' && (
        <div className="update-actions">
          <button className="btn tiny" onClick={onUpdate}>重试</button>
          <button className="btn ghost tiny" onClick={onDismiss}>关闭</button>
        </div>
      )}
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
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [lastSync, setLastSync] = useState<Date | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [cleanupOpen, setCleanupOpen] = useState(false)

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

  const openCount = tickets.filter(ticket => ticket.stage !== 'done').length

  // 去掉顶部分类筛选栏后，看板直接展示全部阶段列。
  const columns = STAGE_ORDER
    .map(stage => ({ stage, items: tickets.filter(ticket => ticket.stage === stage) }))

  const refresh = (): void => {
    load()
    if (selected) loadDetail(selected)
  }

  return (
    <>
      <PageHead
        title="工单"
        subtitle={lastSync
          ? `${openCount} 张在办 · ${tickets.length - openCount} 张已完成 · 更新于 ${lastSync.toLocaleTimeString('zh-CN')}`
          : '正在读取工单…'}
        actions={
          <>
            <label className="switch">
              <input type="checkbox" checked={autoRefresh} onChange={event => setAutoRefresh(event.target.checked)} />
              <span className="switch-track"><span className="switch-knob" /></span>
              自动刷新
            </label>
            <button className="btn" onClick={() => setCleanupOpen(true)}>
              <Icon name="trash" size={14} />
              清理工作区
            </button>
            <button className="btn" onClick={refresh}>
              <Icon name="refresh" size={14} />
              刷新
            </button>
          </>
        }
      />

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

      {cleanupOpen && <WorkspaceCleanupDialog onClose={() => setCleanupOpen(false)} />}
    </>
  )
}

/** 工单页「清理工作区」：按运行时分组展示工作区，勾选工单后批量清理。 */
function WorkspaceCleanupDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [overview, setOverview] = useState<WorkspaceOverviewView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn'; text: string; skipped: WorkspaceSkipView[] } | null>(null)

  const load = useCallback((): void => {
    void getJson<WorkspaceOverviewView>('/api/workspaces')
      .then(data => {
        setOverview(data)
        setError(null)
        // 工作区已经不在清单里的工单自动从选中集合里剔除。
        const available = new Set(data.runtimes.flatMap(group => group.entries.filter(entry => entry.cleanable).map(entry => entry.ticketId)))
        setSelected(current => new Set([...current].filter(id => available.has(id))))
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [busy, onClose])

  const toggle = (ticketId: string): void => {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(ticketId)) next.delete(ticketId)
      else next.add(ticketId)
      return next
    })
  }

  const toggleGroup = (group: WorkspaceRuntimeGroupView): void => {
    const cleanable = group.entries.filter(entry => entry.cleanable).map(entry => entry.ticketId)
    const allSelected = cleanable.length > 0 && cleanable.every(id => selected.has(id))
    setSelected(current => {
      const next = new Set(current)
      for (const id of cleanable) {
        if (allSelected) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  const clean = async (): Promise<void> => {
    const ticketIds = [...selected]
    if (ticketIds.length === 0) return
    if (!confirm(`确认清理所选 ${ticketIds.length} 个工单的工作区？\nOrca 会关闭 worktree 并删除目录；Claude Code 会删除 agent view 与 worktree；ACP 直接删除 worktree。\n有未提交改动的目录会被跳过，不会强删。`)) return
    setBusy(true)
    setNotice(null)
    try {
      const result = await sendJson<WorkspaceCleanupResultView>('/api/workspaces/cleanup', 'POST', { ticketIds })
      setNotice({
        tone: result.skipped.length > 0 ? 'warn' : 'ok',
        text: `已清理 ${result.removed.length} 个${result.skipped.length > 0 ? `，跳过 ${result.skipped.length} 个` : ''}`,
        skipped: result.skipped,
      })
      setError(null)
      setSelected(new Set())
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-layer">
      <button className="modal-backdrop" aria-label="关闭" onClick={() => { if (!busy) onClose() }} />
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label="清理工作区">
        <header className="modal-head">
          <div>
            <h3>清理工作区</h3>
            <p>按 Worker 运行时分组列出仍在磁盘上的工单工作区，勾选后批量清理。Orca 会关闭 worktree 并删除目录，Claude Code 会删除 agent view 与 worktree，ACP 直接删除 worktree；有未提交改动的目录会被跳过，不会强删。</p>
          </div>
          <button className="icon-btn" title="关闭" onClick={() => { if (!busy) onClose() }} disabled={busy}>
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="modal-body">
          {error && <p className="modal-error">{error}</p>}
          {notice && (
            <div className={`ws-result ws-result-${notice.tone}`}>
              <strong>{notice.text}</strong>
              {notice.skipped.length > 0 && (
                <ul>
                  {notice.skipped.map(item => (
                    <li key={`${item.ticketId}:${item.workdir}`}>
                      <code>{item.ticketId}</code>{item.workdir ? <>（<code>{item.workdir}</code>）</> : ''}：{item.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {!overview && !error && <p className="modal-hint">正在读取工作区…</p>}
          {overview && overview.runtimes.length === 0 && (
            <p className="modal-hint">没有发现遗留工作区。已关闭工单的 worktree 会在关单后自动回收。</p>
          )}
          {overview?.runtimes.map(group => {
            const cleanable = group.entries.filter(entry => entry.cleanable)
            const allSelected = cleanable.length > 0 && cleanable.every(entry => selected.has(entry.ticketId))
            return (
              <section key={group.runtimeId} className="ws-group">
                <header className="ws-group-head">
                  <div className="ws-group-title">
                    <strong>{group.label}</strong>
                    <span className="mono ws-runtime-id">{group.runtimeId}</span>
                    {group.isDefault && <span className="ws-tag">默认</span>}
                    <small>{group.entries.length} 个工作区 · {group.cleanableCount} 个可清理</small>
                  </div>
                  <label className={`ws-select-all ${cleanable.length === 0 ? 'disabled' : ''}`}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      disabled={busy || cleanable.length === 0}
                      onChange={() => toggleGroup(group)}
                    />
                    本组全选
                  </label>
                </header>
                {!group.supported && (
                  <p className="modal-hint">当前服务未注册该运行时，只能查看、不能自动清理。</p>
                )}
                {group.entries.length === 0 ? (
                  <p className="muted ws-empty">没有遗留工作区。</p>
                ) : (
                  <ul className="ws-list">
                    {group.entries.map(entry => (
                      <li key={entry.assignmentId} className={`ws-item ${entry.cleanable ? 'ws-item-cleanable' : ''}`}>
                        <label className={`ws-item-main ${entry.cleanable ? '' : 'disabled'}`}>
                          <input
                            type="checkbox"
                            checked={selected.has(entry.ticketId)}
                            disabled={busy || !entry.cleanable}
                            onChange={() => toggle(entry.ticketId)}
                          />
                          <span className="ws-ticket">{entry.title || entry.ticketId}</span>
                          <span className="mono ws-ticket-id">{entry.ticketId}</span>
                          <span className={`ws-state ${entry.cleanable ? 'ok' : 'hold'}`}>
                            {entry.cleanable ? '已关闭 · 可清理' : entry.reason ?? '使用中'}
                          </span>
                        </label>
                        <code className="ws-path">{entry.workdir}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
        <footer className="modal-foot ws-foot">
          <span className="ws-selected">已选 <strong>{selected.size}</strong> 个</span>
          <button className="btn" onClick={load} disabled={busy}>
            <Icon name="refresh" size={13} />刷新
          </button>
          <button className="btn primary" onClick={() => void clean()} disabled={busy || selected.size === 0}>
            <Icon name="trash" size={13} />
            {busy ? '清理中…' : '清理所选'}
          </button>
          <button className="btn" onClick={onClose} disabled={busy}>关闭</button>
        </footer>
      </div>
    </div>
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
    id: 'specs',
    title: '规范文件',
    description: 'Router 与 Worker 的提示词规范统一存放在内置存储里，可直接查看、编辑、保存或恢复默认；不再需要指定外部文件路径。',
    fields: [],
  },
  {
    id: 'projects',
    title: '项目与群绑定',
    description: '维护可派工的项目，以及每个群绑定到哪个项目 / 分支。项目清单按 Worker 后端隔离；支持添加本地项目或从 Git 地址 clone。',
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
  const [identity, setIdentity] = useState<IdentityStatusView | undefined>(undefined)
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
        setIdentity(data.identity)
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

  // 返回是否保存成功，供「保存并重启」判断要不要接着触发重启。
  const save = async (): Promise<boolean> => {
    if (!draft || !original || changed.length === 0 || errors.size > 0) return false
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
      // 保存后服务端会重解析名单，这里同步最新状态（解析失败也不影响保存结果）。
      if (result.identity) setIdentity(result.identity)
      setPendingRestart(result.restartRequired)
      const message = secretDropNotice(patch, result) ?? {
        kind: result.restartRequired ? 'warn' as const : 'ok' as const,
        text: result.restartRequired
          ? `已保存 ${result.changed.length} 项，其中部分配置需要重启服务才生效；点右上角「重启服务」即可（页面不会刷新）。`
          : `已保存 ${result.changed.length} 项，已立即生效。`,
      }
      setNotice(message)
      window.setTimeout(() => setNotice(current => (current === message ? null : current)), 6_000)
      return true
    } catch (error) {
      const message = { kind: 'error' as const, text: error instanceof Error ? error.message : String(error) }
      setNotice(message)
      window.setTimeout(() => setNotice(current => (current === message ? null : current)), 8_000)
      return false
    } finally {
      setSaving(false)
    }
  }

  const saveAndRestart = async (): Promise<void> => {
    if (await save()) onRestart()
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
                    {section.id === 'specs'
                      ? <span className="badge cold">保存后按项生效</span>
                      : section.hot
                        ? <span className="badge hot">立即生效</span>
                        : <span className="badge cold">重启生效</span>}
                    {dirty && <span className="badge dirty">已修改</span>}
                  </div>
                </header>

                {section.id === 'specs' && <SpecsEditor />}

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
                      <p className="editor-hint">配置监控哪些群、收全部消息还是只收 @；绑定项目只能从当前后端的项目清单里选，分支自动跟随项目的默认分支。群级名单推荐填邮箱（兼容 ou_xxx）：配了却解析不到人时，该群会拒绝所有人，不会退回全局名单。</p>
                      <ChatsEditor
                        chats={draft.feishu?.chats ?? []}
                        projects={activeProjects}
                        error={errors.get('feishu.chats')}
                        onChange={value => setField('feishu.chats', value)}
                      />
                    </div>
                  </>
                )}

                {section.id === 'feishu' && (
                  <>
                    <IdentityNotices
                      identity={identity}
                      stale={changed.includes('feishu.allowed') || changed.includes('feishu.chats')}
                    />
                    <FeishuBotPanel
                      appId={String(draft.feishu?.appId ?? '')}
                      onConfigSaved={config => {
                        const nextAppId = String(config.feishu?.appId ?? '')
                        setOriginal(current => (current ? setByPath(current, 'feishu.appId', nextAppId) : current))
                        setDraft(current => (current ? setByPath(current, 'feishu.appId', nextAppId) : current))
                      }}
                    />
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
        restarting={restarting}
        onReset={resetAll}
        onSave={() => void save()}
        onSaveAndRestart={() => void saveAndRestart()}
      />
    </>
  )
}

/**
 * 允许名单与机器人身份的解析状态提示。
 *
 * 解析失败**不阻断保存**，所以这里只说明「这些人的消息收不到」，
 * 不能写成「保存失败」的口气。
 */
function IdentityNotices({ identity, stale }: {
  identity?: IdentityStatusView
  stale?: boolean
}): JSX.Element | null {
  if (!identity) return null
  const summary = summarizeIdentity(identity)
  const bot = summarizeBot(identity)
  const problems = problemEntries(identity)
  return (
    <>
      {stale && (
        <div className="banner warn compact">
          <Icon name="alert" size={13} />
          <span>允许名单有未保存的修改，下面的解析状态还是上一次保存后的结果。</span>
        </div>
      )}
      {/* 正常状态不占一条横幅：只在确实有问题（解析失败 / 待重试）时提示。 */}
      {summary.kind !== 'ok' && (
        <div className={`banner ${summary.kind === 'error' ? 'danger' : 'warn'} compact`}>
          <Icon name="alert" size={13} />
          <span>{summary.text}</span>
        </div>
      )}
      {bot.kind !== 'ok' && (
        <div className={`banner ${bot.kind === 'error' ? 'danger' : 'warn'} compact`}>
          <Icon name="alert" size={13} />
          <span>{bot.text}</span>
        </div>
      )}
      {problems.length > 0 && (
        <ul className="identity-entries">
          {problems.map((entry, index) => (
            <li key={`${entry.entry}-${index}`}>{describeEntry(entry)}</li>
          ))}
        </ul>
      )}
      {summary.kind === 'error' && (
        <p className="editor-hint identity-hint">
          名单条目没解析到就等于没有这个人：他们的消息收不到；如果某个群的名单配了却解析不到，该群会直接拒绝所有人（不会退回全局名单）。
        </p>
      )}
    </>
  )
}

function SaveDock({ changed, errors, notice, saving, restarting, onReset, onSave, onSaveAndRestart }: {
  changed: string[]
  errors: Map<string, string>
  notice: RuntimeNotice | null
  saving: boolean
  restarting?: boolean
  onReset: () => void
  onSave: () => void
  onSaveAndRestart: () => void
}): JSX.Element {
  const blocked = changed.length === 0 || errors.size > 0 || saving
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
        <button className="btn primary" onClick={onSave} disabled={blocked}>
          {saving ? '保存中…' : '保存配置'}
        </button>
        <button className="btn" onClick={onSaveAndRestart} disabled={blocked || restarting} title="保存后立即重启 ra 服务（页面不会刷新）">
          <Icon name="refresh" size={13} className={restarting ? 'spin' : undefined} />
          {restarting ? '重启中…' : '保存并重启'}
        </button>
      </div>
    </div>
  )
}

/**
 * 后端没把密钥写进去时给出明确提示，避免「面板显示已保存，但 config.yaml 里没有」。
 * 常见原因是服务仍在运行不支持 llm.apiKey 的旧版本，重启后即可。
 */
function secretDropNotice(patch: Record<string, unknown>, result: ConfigSaveResult): RuntimeNotice | null {
  if (!('llm.apiKey' in patch)) return null
  const keySet = Boolean((result.config.llm as { apiKeySet?: boolean } | undefined)?.apiKeySet)
  if (result.changed.includes('llm.apiKey') || keySet) return null
  return { kind: 'error', text: 'API Key 没有写入 config.yaml：服务可能还在运行旧版本，请重启服务后再保存一次。' }
}

const SETUP_FEISHU_FIELDS: FieldDef[] = (() => {
  const all = SECTIONS.flatMap(section => section.fields)
  return ['feishu.appId', 'feishu.directMessages']
    .map(path => all.find(field => field.path === path))
    .filter((field): field is FieldDef => Boolean(field))
})()

/**
 * 初始化页 · 本地 Provider 选择弹窗。
 * 打开即扫描本机配置，选中一份后调用导入接口；扫描与导入失败都留在弹窗内提示。
 */
function LocalProviderImportDialog({ hasUnsavedChanges, onClose, onImported }: {
  hasUnsavedChanges: boolean
  onClose: () => void
  onImported: (candidate: LocalProviderView, result: LocalProviderImportResult) => void
}): JSX.Element {
  const [providers, setProviders] = useState<LocalProviderList | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(false)
  const [importingId, setImportingId] = useState('')
  const [error, setError] = useState<string | null>(null)

  const scan = useCallback((): void => {
    setLoading(true)
    setError(null)
    void listLocalProviders()
      .then(list => {
        setProviders(list)
        // 候选集会随扫描变化：原选择还在就保留，否则默认选中第一份可用配置。
        setSelectedId(current => (
          list.candidates.some(candidate => candidate.id === current)
            ? current
            : list.candidates[0]?.id ?? ''
        ))
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { scan() }, [scan])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !importingId) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [importingId, onClose])

  const busy = Boolean(importingId)
  const selected = providers?.candidates.find(candidate => candidate.id === selectedId)

  const apply = async (): Promise<void> => {
    if (!selected) return
    if (hasUnsavedChanges && !confirm('导入会覆盖当前草稿里未保存的修改。继续？')) return
    setImportingId(selected.id)
    setError(null)
    try {
      onImported(selected, await importLocalProvider(selected.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setImportingId('')
    }
  }

  return (
    <div className="modal-layer">
      <button className="modal-backdrop" aria-label="关闭" onClick={() => { if (!busy) onClose() }} />
      <div className="modal provider-picker" role="dialog" aria-modal="true" aria-label="从本地配置导入">
        <header className="modal-head">
          <div>
            <h3>从本地配置导入</h3>
            <p>只读扫描本机 Claude Code、CCSwitch、Pi、OpenCode、Magpie 的 Provider 配置，选一份写入当前 LLM Provider。原文件不会改动，密钥不回显。</p>
          </div>
          <button className="icon-btn" title="关闭" onClick={() => { if (!busy) onClose() }} disabled={busy}>
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="modal-body">
          {error && <p className="modal-error">{error}</p>}
          {loading && <p className="modal-hint">正在扫描本地配置…</p>}
          {!loading && providers && providers.candidates.length === 0 && (
            <>
              <p className="modal-hint">没有找到完整的 Provider（Base URL / 模型 / Key 三项都要有）。</p>
              <ul className="provider-source-list">
                {providers.sources.map(source => (
                  <li key={source.id}>
                    <span className={source.found ? 'source-ok' : 'source-missing'}>{source.found ? '已找到' : '未找到'}</span>
                    <strong>{source.label}</strong>
                    <code>{source.path}</code>
                    {source.error && <em>{source.error}</em>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {!loading && providers && providers.candidates.length > 0 && (
            <ul className="provider-pick-list">
              {providers.candidates.map(candidate => (
                <li key={candidate.id}>
                  <label className={`provider-pick ${candidate.id === selectedId ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="local-provider"
                      checked={candidate.id === selectedId}
                      disabled={busy}
                      onChange={() => setSelectedId(candidate.id)}
                    />
                    <span className="provider-pick-info">
                      <strong>{candidate.name}</strong>
                      <span>
                        {candidate.sourceLabel} · {candidate.api}
                        {candidate.contextWindow ? ` · 上下文 ${candidate.contextWindow.toLocaleString()} tokens` : ''}
                      </span>
                      <code>{candidate.baseUrl}</code>
                      <small>模型：{candidate.model}{candidate.apiKeySet ? ' · 已带 Key' : ' · 缺少 Key'}</small>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer className="modal-foot">
          <button className="btn" onClick={scan} disabled={loading || busy}>
            <Icon name="refresh" size={13} className={loading ? 'spin' : undefined} />
            重新扫描
          </button>
          <span className="provider-pick-spacer" />
          <button className="btn" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn primary" onClick={() => void apply()} disabled={!selected || busy}>
            {busy ? '导入中…' : '导入所选'}
          </button>
        </footer>
      </div>
    </div>
  )
}

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
  const [feishuReady, setFeishuReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<RuntimeNotice | null>(null)
  const [pendingRestart, setPendingRestart] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [providerPickerOpen, setProviderPickerOpen] = useState(false)

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

  const runtimeCatalog = useMemo(() => mergeRuntimeChoices(runtimeChoices), [runtimeChoices])
  const runtimeId = normalizeRuntimeId(
    draft && typeof draft.runtime?.default === 'string' ? draft.runtime.default : ORCA_RUNTIME_ID,
  )
  const activeProjectsPath = projectPatchPath(runtimeId)
  const activeProjects = draft ? projectsOf(draft, runtimeId) : []
  const runtimeLabel = runtimeCatalog.find(runtime => runtime.id === runtimeId)?.label ?? runtimeId

  const changed = useMemo(() => {
    if (!draft || !original) return []
    const paths = ['llm.baseUrl', 'llm.model', 'llm.apiKey', 'llm.api', 'llm.authHeader', 'runtime.default', 'feishu.appId', 'feishu.directMessages', 'feishu.chats']
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
    for (const field of LLM_FIELDS) {
      const message = fieldError(field, getByPath(draft, field.path))
      if (message) map.set(field.path, message)
    }
    for (const field of SETUP_FEISHU_FIELDS) {
      const message = fieldError(field, getByPath(draft, field.path))
      if (message) map.set(field.path, message)
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
  }, [draft, changed, runtimeCatalog, runtimeId])

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

  // 返回是否保存成功，供「保存并重启」判断要不要接着触发重启。
  const save = async (): Promise<boolean> => {
    if (!draft || !original || changed.length === 0 || errors.size > 0) return false
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
      const message = secretDropNotice(patch, result) ?? {
        kind: result.restartRequired ? 'warn' as const : 'ok' as const,
        text: result.restartRequired
          ? `已保存 ${result.changed.length} 项，重启服务后生效；点上方「立即重启」即可。`
          : `已保存 ${result.changed.length} 项，已立即生效。`,
      }
      setNotice(message)
      window.setTimeout(() => setNotice(current => (current === message ? null : current)), 8_000)
      return true
    } catch (error) {
      const message = { kind: 'error' as const, text: error instanceof Error ? error.message : String(error) }
      setNotice(message)
      window.setTimeout(() => setNotice(current => (current === message ? null : current)), 8_000)
      return false
    } finally {
      setSaving(false)
    }
  }

  const saveAndRestart = async (): Promise<void> => {
    if (await save()) onRestart()
  }

  // 弹窗里导入成功后直接用返回的配置替换草稿，并关掉弹窗、提示结果。
  const applyLocalProvider = (candidate: LocalProviderView, result: LocalProviderImportResult): void => {
    setOriginal(result.config)
    setDraft(result.config)
    setDefaults(result.defaults)
    setConfigPath(result.configPath)
    if (result.runtimeChoices) setRuntimeChoices(result.runtimeChoices)
    if (typeof result.detecting === 'boolean') setDetecting(result.detecting)
    setPendingRestart(result.restartRequired)
    setProviderPickerOpen(false)
    const message = {
      kind: result.restartRequired ? 'warn' as const : 'ok' as const,
      text: `已导入 ${candidate.sourceLabel} · ${candidate.name}${result.restartRequired ? '，重启服务后生效' : ''}。`,
    }
    setNotice(message)
    window.setTimeout(() => setNotice(current => (current === message ? null : current)), 8_000)
  }

  if (loadError) return <div className="banner danger"><Icon name="alert" />读取配置失败：{loadError}</div>
  if (!draft || !original) return <div className="empty-state tall"><p>正在读取配置…</p></div>

  const chats = (draft.feishu?.chats ?? []) as ChatDraft[]
  const runtimeChoice = runtimeCatalog.find(choice => choice.id === runtimeId)
  const runtimeReady = runtimeChoice?.status === 'ready' || runtimeChoice?.status === 'unverified'
  const projectReady = activeProjects.length > 0 && !projectIssue(runtimeId, activeProjects)
  const chatReady = chats.length > 0 && !chatsIssue(chats)
  const llmConfig = (draft.llm ?? {}) as { baseUrl?: string; model?: string; apiKey?: string; apiKeySet?: boolean }
  // LLM Provider 必填：baseUrl + model + apiKey 缺一不可（本次新填、尚未保存的密钥也算）。
  const keyConfigured = Boolean(llmConfig.apiKeySet || String(llmConfig.apiKey ?? '').trim())
  const llmReady = Boolean(
    String(llmConfig.baseUrl ?? '').trim() && String(llmConfig.model ?? '').trim() && keyConfigured,
  )
  const steps = [
    { label: 'LLM 已配置', hint: llmReady ? '已就绪' : '填写 Base URL / 模型 / API Key', done: llmReady },
    { label: '运行时可用', hint: runtimeReady ? '已就绪' : runtimeChoice ? runtimeStatusLabel(runtimeChoice.status) : '未选择', done: runtimeReady },
    { label: '已登记项目', hint: projectReady ? `${activeProjects.length} 个项目` : '至少一个', done: projectReady },
    { label: '飞书机器人已就绪', hint: feishuReady ? '已就绪' : '写入 App ID / App Secret', done: feishuReady },
    { label: '监控群已添加', hint: chatReady ? `${chats.length} 个群` : '至少一个', done: chatReady },
  ]
  const completed = steps.filter(step => step.done).length
  const directMessagesField = SETUP_FEISHU_FIELDS.find(field => field.path === 'feishu.directMessages')
  const missingBindings = chats.filter(chat => chat.repo && !activeProjects.some(project => project.name === chat.repo))

  return (
    <>
      <PageHead
        title="初始化配置"
        subtitle="只配置服务跑起来必需的五件事；人格、会话复用、闲置治理等高级项仍在「配置」里。"
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

      <section className="settings-card" id="setup-llm">
        <header className="settings-head">
          <div>
            <h2>1. LLM Provider</h2>
            <p>Router 研判与图片转写使用的大模型接入，三项均为必填；未配置时服务无法启动。API Key 只写入 config.yaml，保存后不回显。</p>
          </div>
          <div className="settings-badges">
            {llmReady ? <span className="badge hot">已就绪</span> : <span className="badge cold">未完成</span>}
            {keyConfigured && <span className="badge cold">密钥已配置</span>}
            <button className="btn tiny" onClick={() => setProviderPickerOpen(true)}>
              <Icon name="download" size={13} />
              从本地配置导入
            </button>
          </div>
        </header>
        <div className="settings-rows">
          {LLM_FIELDS.map(field => (
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
      </section>

      <section className="settings-card" id="setup-runtime">
        <header className="settings-head">
          <div>
            <h2>2. 选择运行时</h2>
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
            <h2>3. 登记项目</h2>
            <p>当前运行时：<strong>{runtimeLabel}</strong>。至少登记一个项目，群绑定才能选；可以选本机已有目录，也可以填 Git 地址自动 clone。</p>
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
            <h2>4. 飞书机器人</h2>
            <p>写入 App ID / App Secret 后，可在这里检查并完成飞书授权。</p>
          </div>
          <div className="settings-badges">
            {feishuReady ? <span className="badge hot">已就绪</span> : <span className="badge cold">未完成</span>}
          </div>
        </header>
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
        <FeishuBotPanel
          appId={String(draft.feishu?.appId ?? '')}
          onConfigSaved={config => {
            const nextAppId = String(config.feishu?.appId ?? '')
            setOriginal(current => (current ? setByPath(current, 'feishu.appId', nextAppId) : current))
            setDraft(current => (current ? setByPath(current, 'feishu.appId', nextAppId) : current))
          }}
          onStatus={setFeishuReady}
        />
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
            <h2>5. 群与绑定</h2>
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
        restarting={restarting}
        onReset={resetAll}
        onSave={() => void save()}
        onSaveAndRestart={() => void saveAndRestart()}
      />

      {providerPickerOpen && (
        <LocalProviderImportDialog
          hasUnsavedChanges={changed.length > 0}
          onClose={() => setProviderPickerOpen(false)}
          onImported={applyLocalProvider}
        />
      )}
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
  if (field.kind === 'password') {
    return (
      <input
        className="text-input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={toInputValue(value, 'text')}
        onChange={event => onChange(event.target.value)}
        placeholder={field.placeholder}
      />
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

interface ProjectInspectionView {
  path: string
  name: string
  isGit: boolean
  branch: string
  detached: boolean
  remoteUrl: string
  error?: string
  repo?: string
  reused?: boolean
  orca?: { registered: boolean; repo: string; displayName: string; error?: string }
}

interface ProjectDialogState {
  mode: 'local' | 'git'
  url: string
  path: string
  busy: boolean
  info: ProjectInspectionView | null
  name: string
  defaultBranch: string
  error: string | null
  notice: string | null
  /** Orca 登记失败时先提示，再点一次「仍然添加」才落配置。 */
  force: boolean
}

function dialogError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function ProjectsEditor({ runtimeId, projects, error, onChange }: {
  runtimeId: string
  projects: ProjectDraft[]
  error?: string
  onChange: (value: ProjectDraft[]) => void
}): JSX.Element {
  const isOrca = runtimeId === ORCA_RUNTIME_ID
  const [dialog, setDialog] = useState<ProjectDialogState | null>(null)
  const update = (index: number, patch: Partial<ProjectDraft>): void => {
    onChange(projects.map((project, i) => (i === index ? { ...project, ...patch } : project)))
  }

  const baseDialog = (mode: 'local' | 'git', busy = false): ProjectDialogState => ({
    mode,
    url: '',
    path: '',
    busy,
    info: null,
    name: '',
    defaultBranch: '',
    error: null,
    notice: null,
    force: false,
  })

  const inspectPath = async (target: string): Promise<void> => {
    const path = target.trim()
    if (!path) {
      setDialog(current => (current ? { ...current, error: '请先选择或填写本地目录' } : current))
      return
    }
    setDialog(current => (current ? { ...current, busy: true, error: null, notice: null, info: null } : current))
    try {
      const info = await sendJson<ProjectInspectionView>('/api/projects/inspect', 'POST', { path })
      setDialog(current => (current
        ? {
          ...current,
          busy: false,
          info,
          path: info.path,
          name: info.name,
          defaultBranch: info.branch,
          error: info.isGit ? null : (info.error ?? '该目录不是 Git 仓库'),
          force: false,
        }
        : current))
    } catch (failure) {
      setDialog(current => (current ? { ...current, busy: false, info: null, error: dialogError(failure) } : current))
    }
  }

  /** 「添加本地项目」：先弹系统目录选择框，选中后自动识别 Git 与分支。 */
  const startLocal = async (): Promise<void> => {
    const initial = baseDialog('local', true)
    setDialog(initial)
    try {
      const picked = await sendJson<{ canceled: boolean; path: string }>('/api/projects/pick-directory', 'POST', {})
      if (picked.canceled || !picked.path) {
        setDialog(null)
        return
      }
      setDialog({ ...initial, path: picked.path, busy: false })
      await inspectPath(picked.path)
    } catch (failure) {
      setDialog({
        ...initial,
        busy: false,
        error: `无法打开目录选择框：${dialogError(failure)}。可以直接填写绝对路径后点「识别」。`,
      })
    }
  }

  const pickIntoDialog = async (): Promise<void> => {
    setDialog(current => (current ? { ...current, busy: true, error: null, notice: null } : current))
    try {
      const picked = await sendJson<{ canceled: boolean; path: string }>('/api/projects/pick-directory', 'POST', {})
      if (picked.canceled || !picked.path) {
        setDialog(current => (current ? { ...current, busy: false } : current))
        return
      }
      await inspectPath(picked.path)
    } catch (failure) {
      setDialog(current => (current
        ? { ...current, busy: false, error: `无法打开目录选择框：${dialogError(failure)}。可以直接填写绝对路径。` }
        : current))
    }
  }

  const cloneGit = async (): Promise<void> => {
    if (!dialog) return
    const url = dialog.url.trim()
    if (!url) {
      setDialog({ ...dialog, error: '请填写 Git 地址' })
      return
    }
    setDialog({ ...dialog, busy: true, error: null, notice: null, info: null, force: false })
    try {
      const info = await sendJson<ProjectInspectionView>('/api/projects/clone', 'POST', { url, runtimeId })
      const orcaFailed = info.orca && !info.orca.registered
      setDialog(current => (current
        ? {
          ...current,
          busy: false,
          info,
          path: info.path,
          name: info.name,
          defaultBranch: info.branch,
          error: info.isGit ? null : (info.error ?? '该目录不是 Git 仓库'),
          notice: orcaFailed ? `已 clone 到 ${info.path}，但登记到 Orca 失败：${info.orca?.error ?? '未知原因'}` : null,
        }
        : current))
    } catch (failure) {
      setDialog(current => (current ? { ...current, busy: false, error: dialogError(failure) } : current))
    }
  }

  const addFromDialog = async (): Promise<void> => {
    if (!dialog || !dialog.info) return
    const name = dialog.name.trim()
    if (!name) {
      setDialog({ ...dialog, error: '请填写项目名' })
      return
    }
    if (!dialog.info.isGit) {
      setDialog({ ...dialog, error: '该目录不是 Git 仓库，无法创建 worktree' })
      return
    }
    if (projects.some(project => project.name === name)) {
      setDialog({ ...dialog, error: `项目名已存在：${name}` })
      return
    }

    let repo = dialog.info.repo ?? dialog.info.path
    if (dialog.mode === 'local') {
      setDialog({ ...dialog, busy: true, error: null })
      try {
        const prepared = await sendJson<ProjectInspectionView>('/api/projects/register', 'POST', { path: dialog.info.path, runtimeId })
        repo = prepared.repo ?? prepared.path
        if (prepared.orca && !prepared.orca.registered && !dialog.force) {
          setDialog(current => (current
            ? {
              ...current,
              busy: false,
              force: true,
              notice: `登记到 Orca 失败：${prepared.orca?.error ?? '未知原因'}。仍可先加入项目清单，开工前需要在 Orca 里补登记。`,
            }
            : current))
          return
        }
      } catch (failure) {
        setDialog(current => (current ? { ...current, busy: false, error: dialogError(failure) } : current))
        return
      }
    }

    onChange([...projects, { name, repo, defaultBranch: dialog.defaultBranch.trim() }])
    setDialog(null)
  }

  const canAdd = Boolean(dialog?.info?.isGit && dialog.name.trim())

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
      <div className="project-add-actions">
        <button className="btn add" onClick={() => void startLocal()}>
          <Icon name="folder" size={13} />添加本地项目
        </button>
        <button className="btn add" onClick={() => setDialog(baseDialog('git'))}>
          <Icon name="git" size={13} />添加 Git 项目
        </button>
      </div>

      {dialog && (
        <div className="modal-layer">
          <button className="modal-backdrop" aria-label="关闭" onClick={() => { if (!dialog.busy) setDialog(null) }} />
          <div className="modal" role="dialog" aria-modal="true" aria-label={dialog.mode === 'local' ? '添加本地项目' : '添加 Git 项目'}>
            <header className="modal-head">
              <div>
                <h3>{dialog.mode === 'local' ? '添加本地项目' : '添加 Git 项目'}</h3>
                <p>
                  {dialog.mode === 'local'
                    ? '选择本机已有目录，自动识别是否为 Git 仓库以及当前分支。'
                    : `填写 ssh 或 http(s) 地址，自动 clone 到 RA_HOME/repos 下${isOrca ? '，并用 orca repo add 登记' : ''}。`}
                </p>
              </div>
              <button className="icon-btn" title="关闭" onClick={() => setDialog(null)} disabled={dialog.busy}>
                <Icon name="close" size={14} />
              </button>
            </header>
            <div className="modal-body">
              {dialog.mode === 'local' ? (
                <label className="modal-field">
                  <span>本地目录</span>
                  <div className="modal-inline">
                    <input
                      value={dialog.path}
                      placeholder="/Users/me/project"
                      onChange={event => setDialog(current => (current
                        ? { ...current, path: event.target.value, info: null, error: null, notice: null, force: false }
                        : current))}
                    />
                    <button className="btn tiny" onClick={() => void pickIntoDialog()} disabled={dialog.busy}>
                      <Icon name="folder" size={12} />选择目录…
                    </button>
                    <button
                      className="btn tiny"
                      onClick={() => void inspectPath(dialog.path)}
                      disabled={dialog.busy || !dialog.path.trim()}
                    >
                      识别
                    </button>
                  </div>
                </label>
              ) : (
                <label className="modal-field">
                  <span>Git 地址</span>
                  <input
                    value={dialog.url}
                    placeholder="git@gitlab.example.com:group/repo.git 或 https://gitlab.example.com/group/repo.git"
                    onChange={event => setDialog(current => (current
                      ? { ...current, url: event.target.value, info: null, error: null, notice: null, force: false }
                      : current))}
                  />
                </label>
              )}

              {dialog.busy && <p className="modal-hint"><Icon name="refresh" size={13} className="spin" />正在处理…</p>}

              {dialog.info && (
                <div className={`project-detect ${dialog.info.isGit ? 'ok' : 'bad'}`}>
                  <div><span>目录</span><code>{dialog.info.path}</code></div>
                  <div><span>Git</span><strong>{dialog.info.isGit ? '是' : '否'}</strong></div>
                  {dialog.info.isGit && (
                    <div><span>当前分支</span><strong>{dialog.info.detached ? '游离 HEAD' : dialog.info.branch || '未知'}</strong></div>
                  )}
                  {dialog.info.remoteUrl && <div><span>origin</span><code>{dialog.info.remoteUrl}</code></div>}
                  {dialog.info.reused && <div><span>目录</span><strong>已存在同远程仓库，直接复用</strong></div>}
                  {dialog.info.orca && (
                    <div>
                      <span>Orca</span>
                      <strong>{dialog.info.orca.registered ? `已登记为 ${dialog.info.orca.displayName}` : '登记失败'}</strong>
                    </div>
                  )}
                </div>
              )}

              {dialog.info?.isGit && (
                <div className="modal-grid">
                  <label className="modal-field">
                    <span>项目名</span>
                    <input
                      value={dialog.name}
                      placeholder="router-agent"
                      onChange={event => setDialog(current => (current ? { ...current, name: event.target.value, error: null } : current))}
                    />
                  </label>
                  <label className="modal-field">
                    <span>默认起始分支</span>
                    <input
                      value={dialog.defaultBranch}
                      placeholder="main"
                      onChange={event => setDialog(current => (current ? { ...current, defaultBranch: event.target.value } : current))}
                    />
                  </label>
                </div>
              )}

              {dialog.error && <p className="modal-error">{dialog.error}</p>}
              {dialog.notice && <p className="modal-notice">{dialog.notice}</p>}
            </div>
            <footer className="modal-foot">
              <button className="btn tiny" onClick={() => setDialog(null)} disabled={dialog.busy}>取消</button>
              {dialog.mode === 'git' && !dialog.info && (
                <button className="btn primary" onClick={() => void cloneGit()} disabled={dialog.busy || !dialog.url.trim()}>
                  {dialog.busy ? '克隆中…' : '克隆并识别'}
                </button>
              )}
              {canAdd && (
                <button className="btn primary" onClick={() => void addFromDialog()} disabled={dialog.busy}>
                  {dialog.busy ? '处理中…' : dialog.force ? '仍然添加' : '添加项目'}
                </button>
              )}
            </footer>
          </div>
        </div>
      )}
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
          <span>本群名单（推荐邮箱）</span>
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
            placeholder="可空，沿用全局；推荐填邮箱"
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

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

function LogsView(): JSX.Element {
  const [lines, setLines] = useState<LogLine[]>([])
  const [meta, setMeta] = useState<{ path: string; exists: boolean; size: number } | null>(null)
  const [live, setLive] = useState(true)
  const [level, setLevel] = useState<string>('all')
  const [keyword, setKeyword] = useState('')
  const [syncedAt, setSyncedAt] = useState<Date | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [following, setFollowing] = useState(true)

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  // 游标用 ref 保存：轮询回调里要读最新值，放进 state 会让定时器拿到旧闭包。
  const cursorRef = useRef<number | null>(null)
  const seqRef = useRef(0)
  const inflightRef = useRef(false)

  const append = useCallback((batch: LogBatch): void => {
    // 没有新行时不动 state，避免每 2 秒把整张列表重渲染一遍。
    if (batch.entries.length === 0 && !batch.reset) return
    const incoming = batch.entries.map(entry => ({ ...entry, seq: ++seqRef.current }))
    setLines(prev => {
      const next = batch.reset ? incoming : [...prev, ...incoming]
      return next.length > LOG_BUFFER_MAX ? next.slice(next.length - LOG_BUFFER_MAX) : next
    })
  }, [])

  const pull = useCallback(async (): Promise<void> => {
    // 上一次还没回来就跳过，避免网络慢时请求叠在一起把行重复追加。
    if (inflightRef.current) return
    inflightRef.current = true
    try {
      // 第一次（或服务重启后）不带游标，先回看尾部；之后只拉增量。
      for (let round = 0; round < 8; round += 1) {
        const query = cursorRef.current === null ? '?limit=400' : `?cursor=${cursorRef.current}`
        const batch = await getJson<LogBatch>(`/api/logs${query}`)
        cursorRef.current = batch.cursor
        setMeta(prev => prev && prev.path === batch.path && prev.exists === batch.exists && prev.size === batch.size
          ? prev
          : { path: batch.path, exists: batch.exists, size: batch.size })
        append(batch)
        // 积压超过单次读取上限时继续拉，避免新日志被压在后面。
        if (!batch.more) break
      }
      setSyncedAt(new Date())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      inflightRef.current = false
    }
  }, [append])

  useEffect(() => {
    void pull()
  }, [pull])

  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => {
      // 页面在后台时不轮询，回到前台下一轮会一次补齐。
      if (!document.hidden) void pull()
    }, LOG_POLL_MS)
    return () => clearInterval(timer)
  }, [live, pull])

  // 停留在底部时跟着新日志滚动；用户往上翻就不再打扰，直到点「最新」。
  useEffect(() => {
    if (!following) return
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines, following])

  const onScroll = useCallback((): void => {
    const el = scrollerRef.current
    if (!el) return
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 48)
  }, [])

  const jumpToBottom = useCallback((): void => {
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
    setFollowing(true)
  }, [])

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: lines.length }
    for (const line of lines) map[line.level] = (map[line.level] ?? 0) + 1
    return map
  }, [lines])

  const visible = useMemo(() => {
    const query = keyword.trim().toLowerCase()
    return lines.filter(line => {
      if (level !== 'all' && line.level !== level) return false
      if (!query) return true
      const haystack = `${line.message} ${JSON.stringify(line.data ?? {})}`
      return haystack.toLowerCase().includes(query)
    })
  }, [lines, level, keyword])

  // 行元素按过滤结果缓存：轮询没有新内容时不再重建整张列表。
  const rows = useMemo(() => visible.map(line => (
    <div key={line.seq} className={`log-row level-${line.level}`}>
      <span className="log-time" title={line.at || undefined}>{logClock(line.at)}</span>
      <span className="log-level">{LOG_LEVEL_LABEL[line.level] ?? line.level.toUpperCase()}</span>
      <span className="log-message">
        {line.message}
        {line.data && (
          <span className="log-data">
            {' '}
            {Object.entries(line.data).map(([key, value]) => (
              <span key={key} className="log-pair">
                <span className="log-key">{key}</span>={formatLogValue(value)}
              </span>
            ))}
          </span>
        )}
      </span>
    </div>
  )), [visible])

  const copyVisible = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(visible.map(formatLogLine).join('\n'))
      setNotice(`已复制 ${visible.length} 条`)
      setTimeout(() => setNotice(null), 2_500)
    } catch {
      setNotice('复制失败，请手动选择文本')
      setTimeout(() => setNotice(null), 4_000)
    }
  }

  const clearFilters = useCallback((): void => {
    setLevel('all')
    setKeyword('')
  }, [])

  const levels = LOG_LEVELS.filter(item => item !== 'raw' || (counts.raw ?? 0) > 0)
  const loading = meta === null
  const subtitle = meta ? (
    <>
      <span className="log-path">{meta.path || '未配置日志目录'}</span>
      <span className="log-submeta">
        {meta.exists ? ` · ${formatBytes(meta.size)}` : ' · 文件尚未生成'}
        {syncedAt ? ` · 更新于 ${syncedAt.toLocaleTimeString('zh-CN')}` : ''}
      </span>
    </>
  ) : '正在读取日志文件…'

  return (
    <>
      <PageHead
        title="日志"
        subtitle={subtitle}
        actions={
          <>
            <label className="switch">
              <input type="checkbox" checked={live} onChange={event => setLive(event.target.checked)} />
              <span className="switch-track"><span className="switch-knob" /></span>
              实时刷新
            </label>
            <button className="btn" onClick={() => void copyVisible()} disabled={visible.length === 0}>
              <Icon name="copy" size={14} />
              复制
            </button>
            <button className="btn" onClick={() => void pull()}>
              <Icon name="refresh" size={14} />
              刷新
            </button>
          </>
        }
      />

      <section className="log-console" aria-busy={loading || undefined}>
        <div className="log-toolbar">
          <div className="log-filters" role="group" aria-label="按级别过滤">
            {levels.map(item => (
              <button
                key={item}
                type="button"
                className={`log-chip ${level === item ? 'active' : ''}`}
                aria-pressed={level === item}
                onClick={() => setLevel(item)}
              >
                <span className="log-chip-dot" style={{ background: LOG_LEVEL_COLOR[item] }} />
                <span>{LOG_LEVEL_LABEL[item]}</span>
                <span className="log-chip-count">{counts[item] ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="search-box log-search">
            <Icon name="search" size={15} />
            <input
              value={keyword}
              onChange={event => setKeyword(event.target.value)}
              placeholder="过滤消息或字段…"
              aria-label="过滤日志"
            />
          </div>
          {notice && <span className="log-notice" role="status">{notice}</span>}
          <button className="btn ghost tiny" onClick={() => setLines([])} disabled={lines.length === 0}>清空视图</button>
        </div>

        {error && (
          <div className="log-alert" role="alert">
            <Icon name="alert" size={14} />
            <div>
              <strong>读取日志失败</strong>
              <span>{error}{syncedAt ? ` · 上次成功 ${syncedAt.toLocaleTimeString('zh-CN')}` : ''}</span>
            </div>
            <button className="btn ghost tiny" onClick={() => void pull()}>重试</button>
          </div>
        )}

        <div
          className="log-view"
          ref={scrollerRef}
          onScroll={onScroll}
          role="log"
          aria-label="运行日志"
          // 每 2 秒都有新行，交给读屏实时播报会变成噪音，按需浏览即可。
          aria-live="off"
          tabIndex={0}
        >
          {loading ? (
            <div className="log-empty">
              <Icon name="file-text" size={22} />
              <p>正在读取日志…</p>
              <small>连接本机日志文件，读取完成后会从最新内容开始显示。</small>
            </div>
          ) : !meta?.exists ? (
            <div className="log-empty">
              <Icon name="file-text" size={22} />
              <p>还没有日志文件</p>
              <small>{meta?.path ? `服务写入第一条日志后会出现在 ${meta.path}` : '服务启动后这里会显示 RA 的运行日志。'}</small>
            </div>
          ) : visible.length === 0 ? (
            <div className="log-empty">
              <Icon name="file-text" size={22} />
              <p>{lines.length === 0 ? '暂无日志' : '没有匹配的日志'}</p>
              <small>{lines.length === 0 ? '服务产生新日志后会自动出现在这里。' : '换个级别或关键字试试。'}</small>
              {(level !== 'all' || keyword.trim()) && (
                <button className="btn ghost tiny" onClick={clearFilters}>清除筛选</button>
              )}
            </div>
          ) : (
            rows
          )}
        </div>
        {!following && (
          <button className="log-jump" onClick={jumpToBottom}>
            <Icon name="chevron" size={12} className="log-jump-icon" />
            最新
          </button>
        )}
      </section>
    </>
  )
}

function logClock(at: string): string {
  if (!at) return '—'
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}

function formatLogValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function formatLogLine(line: LogEntry): string {
  const data = line.data
    ? ` ${Object.entries(line.data).map(([key, value]) => `${key}=${formatLogValue(value)}`).join(' ')}`
    : ''
  return `${line.at || '-'} ${line.level.toUpperCase()} ${line.message}${data}`
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)