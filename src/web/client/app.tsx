import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ALL_FILTER,
  EMPTY_FILTER,
  facetCounts,
  filterLogLines,
  isFilterActive,
  type LogFilter,
} from './log-filters.js'
import { FilterMenu } from './log-filter-menu.js'
import {
  LLM_FIELDS,
  allRuntimeOptionFields,
  blockEffect,
  blockPaths,
  fieldError,
  fieldValue,
  getByPath,
  groupEffect,
  groupsFor,
  humanizeTime,
  applyRuntimePluginDraft,
  runtimeOptionDefaults,
  setByPath,
  type ConfigBlock,
  type ConfigGroup,
  type FieldDef,
  type RuntimeChoiceView,
} from './fields.js'
import { FieldRow } from './field-row.js'
import { runtimeOptionPaths } from '#runtime/runtimes/options.js'
import {
  channelSetupBlocks,
  channelSetupExtraFields,
  channelSetupFields,
  channelSetupPaths,
  mergeChannels,
  type ChannelDescriptor,
  type ChannelPanelProps,
} from './channels.js'
import { ChannelPicker } from './channel-picker.js'
import {
  chatsIssue,
  projectIssue,
  projectPatchPath,
  projectsOf,
  type ChatDraft,
  type ProjectDraft,
} from './config-shared.js'
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
  type PluginView,
} from './api.js'
import { Icon, LogoMark } from './icons.js'
import { defaultSelectedPaths, mergeImportedProjects, type ScanCandidate } from './project-scan.js'
import type { IdentityStatusView } from './identity-status.js'
import { RuntimeCards, type RuntimeNotice } from './runtime-cards.js'
import { FeishuBotPanel } from './feishu-panel.js'
import { LogAssistantFab } from './log-assistant.js'
import { SpecsEditor } from './specs-editor.js'
import {
  mergeRuntimeChoices,
  runtimeDisplayName,
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
import { ACP_RUNTIME_ID, ORCA_RUNTIME_ID, normalizeRuntimeId } from '#runtime/runtimes/catalog.js'
import type {
  WorkspaceCleanupResultView,
  WorkspaceOverviewView,
  WorkspaceRuntimeGroupView,
  WorkspaceSkipView,
} from '#runtime/workspaces/overview.js'

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
  /** 事件域（事件名第一段），日志页按它过滤。 */
  domain?: string
  /** 事件动作（事件名冒号后的部分）。 */
  event?: string
  /** 类别：message（用户消息）/ event（内部状态）/ action（对外动作）。 */
  category?: string
  /** 链路 ID：把同一条链路的日志串起来。 */
  trace?: string
  /** 群 / 会话。 */
  chat?: string
  /** 群名。 */
  chatName?: string
  /** 发起人。 */
  actor?: string
  /** 发起人名字。 */
  actorName?: string
  /** 发起人类型：user / bot / system。 */
  actorType?: string
  /** 运行时：orca / codex-app 等。 */
  runtime?: string
  /** 工单 ID。 */
  ticket?: string
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
  expired: '会话丢失',
}

const PR_STATE_LABEL: Record<string, string> = {
  none: '无 PR',
  open: '开放中',
  merged: '已合并',
  closed: '已关闭',
}

/** 日志类别：面板上用中文说人话，机器值仍写在展开详情里。 */
const CATEGORY_LABEL: Record<string, string> = { message: '消息', event: '事件', action: '动作' }
/** 发起人类型：用户、机器人还是 Router 自己。 */
const ACTOR_LABEL: Record<string, string> = { user: '用户', bot: '机器人', system: '系统' }

const LOG_LEVELS = ['all', 'info', 'warn', 'error', 'raw'] as const
const LOG_LEVEL_LABEL: Record<string, string> = { all: '全部', info: 'INFO', warn: 'WARN', error: 'ERROR', raw: 'TEXT' }
const LOG_LEVEL_COLOR: Record<string, string> = {
  // 颜色只落在状态上：正常态保持中性，WARN / ERROR 才带语义色。
  all: 'var(--muted)',
  info: 'var(--faint)',
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
  // 排查助手给的配置引导：切到配置页后滚到对应小节。
  const [configTarget, setConfigTarget] = useState<string | null>(null)
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

  // `configTarget` 只负责把「要滚到哪个小节」交给配置页；滚动与高亮由配置页自己处理。

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
            focusSection={configTarget}
            onFocusHandled={() => setConfigTarget(null)}
          />
        )}
        {tab === 'sources' && <SourcesView />}
      </div>

      {/* 智能排查助手：常驻右下角，任何页面都能开。 */}
      <LogAssistantFab onOpenConfig={section => {
        setConfigTarget(section ?? null)
        switchTab('config')
      }} />
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
            <p className="modal-hint">没有发现遗留工作区。已关闭工单的 worktree 会保留一段时间后由定时任务回收，也可以在这里手动清理。</p>
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

/** 筛选框匹配：空查询时全部命中。 */
function matchesText(query: string, ...parts: (string | undefined)[]): boolean {
  if (!query) return true
  return parts.some(part => String(part ?? '').toLowerCase().includes(query))
}

/** 插件入口改动：runtime.plugins.<id> / channels.<id>，保存时按点路径提交。 */
function changedPluginPaths(draft: ConfigDoc, original: ConfigDoc): string[] {
  const paths: string[] = []
  const runtimeEntries = { ...(draft.runtime?.plugins ?? {}), ...(original.runtime?.plugins ?? {}) }
  for (const id of Object.keys(runtimeEntries)) {
    const path = `runtime.plugins.${id}`
    if (JSON.stringify(getByPath(draft, path)) !== JSON.stringify(getByPath(original, path))) paths.push(path)
  }
  const channelEntries = { ...(draft.channels ?? {}), ...(original.channels ?? {}) }
  for (const id of Object.keys(channelEntries)) {
    const path = `channels.${id}`
    if (JSON.stringify(getByPath(draft, path)) !== JSON.stringify(getByPath(original, path))) paths.push(path)
  }
  return paths
}

/**
 * 配置页。
 *
 * 层次：分组 → 配置块（可折叠）→ 字段。
 * 渠道分组的内容来自渠道注册表（channels.ts），页面本身不认识任何具体渠道：
 * 新增渠道只要再加一份描述与表单。
 */
function ConfigView({ restarting, onRestart, onDirtyChange, focusSection, onFocusHandled }: {
  restarting: boolean
  onRestart: () => void
  onDirtyChange?: (dirty: boolean) => void
  /** 排查助手的配置引导目标：滚到该小节并高亮左栏。 */
  focusSection?: string | null
  onFocusHandled?: () => void
}): JSX.Element {
  const [original, setOriginal] = useState<ConfigDoc | null>(null)
  const [draft, setDraft] = useState<ConfigDoc | null>(null)
  const [defaults, setDefaults] = useState<ConfigDoc>({})
  const [configPath, setConfigPath] = useState('')
  const [runtimeChoices, setRuntimeChoices] = useState<RuntimeChoiceView[]>([])
  const [plugins, setPlugins] = useState<PluginView[]>([])
  const [detecting, setDetecting] = useState(false)
  const [identity, setIdentity] = useState<IdentityStatusView | undefined>(undefined)
  const [hotPaths, setHotPaths] = useState<string[]>([])
  const [registered, setRegistered] = useState<{ id: string; kind: string }[]>([])
  const [channelId, setChannelId] = useState('')
  const [active, setActive] = useState<string>('channels')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
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
        setPlugins(data.plugins ?? [])
        setDetecting(Boolean(data.detecting))
        setIdentity(data.identity)
        setHotPaths(Array.isArray(data.hotPaths) ? data.hotPaths : [])
        setLoadError(null)
      })
      .catch(error => setLoadError(error instanceof Error ? error.message : String(error)))
    // 已注册的消息渠道由内核给出；拿不到（旧版服务）就退回前端的描述表。
    void getJson<{ channels?: { id: string; kind: string }[] }>('/api/channels')
      .then(data => setRegistered(data.channels ?? []))
      .catch(() => undefined)
  }, [])

  // 探测轮询由 RuntimeCards 负责；这里只保留静态目录兜底 + 服务端快照合并。
  const runtimeCatalog = useMemo(() => mergeRuntimeChoices(runtimeChoices, plugins), [runtimeChoices, plugins])

  // 当前选中的运行时：deprecated 的 ACP 运行时仍要留在下拉里，老配置才对得上。
  const selectedRuntimeId = normalizeRuntimeId(
    draft && typeof draft.runtime?.default === 'string' ? draft.runtime.default : ORCA_RUNTIME_ID,
  )

  const groups = useMemo(() => groupsFor(runtimeChoices, selectedRuntimeId, runtimeCatalog), [runtimeChoices, selectedRuntimeId, runtimeCatalog])
  const channels = useMemo(() => mergeChannels(registered), [registered])
  const activeChannel = channels.find(channel => channel.id === channelId) ?? channels[0]

  const optionSpecs = useMemo(
    () => plugins.flatMap(plugin => (plugin.kind === 'runtime' && plugin.options ? [plugin.options] : [])),
    [plugins],
  )
  const optionFields = useMemo(() => allRuntimeOptionFields(optionSpecs), [optionSpecs])
  const optionDefaults = useMemo(() => runtimeOptionDefaults(optionFields), [optionFields])

  const groupBlocks = useMemo(() => groups.flatMap(group => group.blocks), [groups])
  const channelBlocks = useMemo(() => channels.flatMap(channel => channel.blocks), [channels])
  const allBlocks = useMemo(() => [...groupBlocks, ...channelBlocks], [groupBlocks, channelBlocks])
  const trackedPaths = useMemo(() => allBlocks.flatMap(block => blockPaths(block)), [allBlocks])

  const changed = useMemo(() => {
    if (!draft || !original) return []
    // 运行时专属选项是动态字段，路径来自各运行时的声明，不在静态块字段里。
    const paths = [...trackedPaths, ...runtimeOptionPaths(), ...optionFields.map(field => field.path)]
      .filter(path => JSON.stringify(fieldValue(draft, path)) !== JSON.stringify(fieldValue(original, path)))
    paths.push(...changedPluginPaths(draft, original))
    for (const runtime of runtimeCatalog) {
      if (JSON.stringify(projectsOf(draft, runtime.id)) !== JSON.stringify(projectsOf(original, runtime.id))) {
        paths.push(projectPatchPath(runtime.id))
      }
    }
    return paths
  }, [draft, original, runtimeCatalog, trackedPaths, optionFields])

  useEffect(() => {
    onDirtyChange?.(changed.length > 0)
  }, [changed.length, onDirtyChange])

  // 排查助手给的配置引导：滚到对应小节并把左栏高亮切过去。
  // 配置数据是异步拉的，刚切过来时小节可能还没渲染，重试一小段时间。
  useEffect(() => {
    if (!focusSection) return
    let cancelled = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const tryScroll = (): void => {
      if (cancelled) return
      const target = document.getElementById(`sec-${focusSection}`)
      if (target) {
        setActive(focusSection)
        target.scrollIntoView({ block: 'start' })
        onFocusHandled?.()
        return
      }
      attempts += 1
      if (attempts >= 20) {
        onFocusHandled?.()
        return
      }
      timer = setTimeout(tryScroll, 100)
    }
    timer = setTimeout(tryScroll, 0)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [focusSection, onFocusHandled])

  const errors = useMemo(() => {
    if (!draft) return new Map<string, string>()
    const map = new Map<string, string>()
    for (const field of allBlocks.flatMap(block => block.fields)) {
      const message = fieldError(field, fieldValue(draft, field.path, optionDefaults))
      if (message) map.set(field.path, message)
    }
    // 运行时专属选项是动态字段，默认值来自各运行时的声明。
    for (const field of optionFields) {
      const message = fieldError(field, fieldValue(draft, field.path, optionDefaults))
      if (message) map.set(field.path, message)
    }
    // 渠道自己的校验（群列表之类），由渠道描述提供。
    for (const channel of channels) {
      for (const [path, message] of Object.entries(channel.validate?.(draft) ?? {})) {
        if (message) map.set(path, message)
      }
    }
    for (const runtime of runtimeCatalog) {
      const issue = projectIssue(projectsOf(draft, runtime.id))
      if (issue) map.set(projectPatchPath(runtime.id), `${runtimeDisplayName(runtime)}：${issue}`)
    }
    return map
  }, [draft, allBlocks, channels, runtimeCatalog, optionFields, optionDefaults])

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
      if (result.plugins) setPlugins(result.plugins)
      if (typeof result.detecting === 'boolean') setDetecting(result.detecting)
      // 保存后服务端会重解析名单，这里同步最新状态（解析失败也不影响保存结果）。
      if (result.identity) setIdentity(result.identity)
      setPendingRestart(result.restartRequired)
      const message = secretDropNotice(patch, result) ?? (result.identityEffective === false
        ? {
            // 名单重解析失败时保存仍然成功（配置已落盘），但新名单还没生效，必须说清楚。
            kind: 'warn' as const,
            text: '已保存，但允许名单重新解析失败，新名单暂未生效（会按上一次的名单继续运行）；稍后可再保存一次或在日志里查看 identity:refresh-failed 的原因。',
          }
        : {
            kind: result.restartRequired ? 'warn' as const : 'ok' as const,
            text: result.restartRequired
              ? `已保存 ${result.changed.length} 项，其中部分配置需要重启服务才生效；点右上角「重启服务」即可（页面不会刷新）。`
              : `已保存 ${result.changed.length} 项，已立即生效。`,
          })
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

  const query = filter.trim().toLowerCase()

  const visibleGroups = useMemo(() => groups.filter(group => {
    if (matchesText(query, group.title, group.description)) return true
    const list = group.kind === 'channels' ? channelBlocks : group.blocks
    return list.some(block =>
      matchesText(query, block.title, block.description) ||
      block.fields.some(field => matchesText(query, field.label, field.path, field.hint)))
  }), [groups, channelBlocks, query])

  // 滚动到哪个分组，左侧导航就高亮哪个：避免长页面上「点了才知道自己在哪」。
  useEffect(() => {
    const nodes = visibleGroups
      .map(group => document.getElementById(`sec-${group.id}`))
      .filter((node): node is HTMLElement => Boolean(node))
    if (nodes.length === 0) return
    const observer = new IntersectionObserver(entries => {
      const visible = entries
        .filter(entry => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
      const first = visible[0]?.target.id.replace(/^sec-/, '')
      if (first) setActive(first)
    }, { rootMargin: '-80px 0px -55% 0px', threshold: 0 })
    nodes.forEach(node => observer.observe(node))
    return () => observer.disconnect()
  }, [visibleGroups])

  if (loadError) return <div className="banner danger"><Icon name="alert" />读取配置失败：{loadError}</div>
  if (!draft || !original) return <div className="empty-state tall"><p>正在读取配置…</p></div>

  const runtimeId = selectedRuntimeId
  const selectedRuntime = runtimeCatalog.find(runtime => runtime.id === runtimeId)
  const runtimeLabel = selectedRuntime ? runtimeDisplayName(selectedRuntime) : runtimeId
  const activeProjectsPath = projectPatchPath(runtimeId)
  const activeProjects = projectsOf(draft, runtimeId)

  const matches = (...parts: (string | undefined)[]): boolean => matchesText(query, ...parts)

  /** 块的「已修改」：字段路径 + 块自己声明的路径（如群列表）。 */
  const blockDirty = (block: ConfigBlock): boolean => {
    if (block.render === 'projects') return changed.includes(projectPatchPath(runtimeId))
    return blockPaths(block).some(path => changed.includes(path))
  }

  const blocksOfGroup = (group: ConfigGroup): ConfigBlock[] =>
    group.kind === 'channels' ? channelBlocks : group.blocks

  /** 筛选时，块标题或块内任一字段命中才保留；没命中的块整块隐藏。 */
  const blockVisible = (block: ConfigBlock): boolean => {
    if (!query) return true
    return matches(block.title, block.description)
      || block.fields.some(field => matches(field.label, field.path, field.hint))
  }

  const panelProps: ChannelPanelProps = {
    draft,
    defaults,
    setField,
    errors,
    identity,
    staleIdentity: activeChannel?.identityPaths?.some(path => changed.includes(path)) ?? false,
    projects: activeProjects,
    runtimeLabel,
    onConfigSaved: config => {
      const nextAppId = String(config.feishu?.appId ?? '')
      setOriginal(current => (current ? setByPath(current, 'feishu.appId', nextAppId) : current))
      setDraft(current => (current ? setByPath(current, 'feishu.appId', nextAppId) : current))
    },
  }

  const renderBlock = (block: ConfigBlock, channel?: ChannelDescriptor): JSX.Element => {
    const effect = blockEffect(block, hotPaths)
    // 筛选时命中的折叠块自动展开，否则用户只看到标题、看不到内容。
    const blockHit = matches(block.title, block.description)
    const open = collapsed[block.id] ?? (!block.folded || (Boolean(query) && blockHit))
    const body = (): JSX.Element => {
      if (block.render === 'custom') {
        const custom = channel?.custom?.[block.id]
        return custom ? custom({ ...panelProps, block }) : <p className="editor-empty">该渠道暂无可配置的项。</p>
      }
      if (block.render === 'runtime') {
        return (
          <RuntimeCards
            choices={runtimeChoices}
            plugins={plugins}
            detecting={detecting}
            selected={runtimeId}
            showHead={false}
            draft={draft}
            defaults={defaults}
            onOptionChange={(path, value) => setField(path, value)}
            onSelect={id => setField('runtime.default', id)}
            onChoices={setRuntimeChoices}
            onDetecting={setDetecting}
            onNotice={setNotice}
            onPendingRestart={() => setPendingRestart(true)}
            onAddRuntime={(id, entry) => setDraft(current => (current ? applyRuntimePluginDraft(current, id, entry) : current))}
          />
        )
      }
      if (block.render === 'projects') {
        return (
          <>
            <p className="editor-hint">
              当前编辑：<strong>{runtimeLabel}</strong> 的项目清单。项目按运行时隔离，切换上方「Worker 运行时」即可编辑另一套。
            </p>
            <ProjectsEditor
              runtimeId={runtimeId}
              projects={activeProjects}
              error={errors.get(projectPatchPath(runtimeId))}
              onChange={value => setField(projectPatchPath(runtimeId), value)}
            />
          </>
        )
      }
      if (block.render === 'specs') return <SpecsEditor />
      // 块标题命中时整块保留，否则只留下命中的字段。
      const fields = blockHit ? block.fields : block.fields.filter(field => matches(field.label, field.path, field.hint))
      if (fields.length === 0) return <p className="editor-empty">没有匹配的配置项。</p>
      return (
        <div className="settings-rows">
          {fields.map(field => (
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
      )
    }
    return (
      <ConfigBlockView
        block={block}
        effect={effect}
        dirty={blockDirty(block)}
        open={open}
        onToggle={() => setCollapsed(current => ({ ...current, [block.id]: !open }))}
      >
        {open ? body() : null}
      </ConfigBlockView>
    )
  }

  const connectedChannels = channels.filter(channel => channel.status(draft, identity).tone === 'ok').length

  return (
    <>
      <PageHead
        title="配置"
        subtitle="按「LLM Provider → 决策层 → 运行时 → 渠道 → 项目 → 消息准入 → 其他设置」分层配置。策略项立即生效，其余配置在重启服务后生效。"
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
            {visibleGroups.map(group => {
              const invalid = blocksOfGroup(group).some(block =>
                block.fields.some(field => errors.has(field.path)) ||
                blockPaths(block).some(path => errors.has(path)))
              const dirty = blocksOfGroup(group).some(blockDirty)
              return (
                <button
                  key={group.id}
                  className={`config-nav-item ${active === group.id ? 'active' : ''}`}
                  onClick={() => {
                    setActive(group.id)
                    document.getElementById(`sec-${group.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
                  }}
                >
                  <span>{group.title}</span>
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
          {visibleGroups.length === 0 && <div className="empty-state"><p>没有匹配的配置项</p></div>}
          {visibleGroups.map(group => {
            const dirty = blocksOfGroup(group).some(blockDirty)
            return (
              <section key={group.id} id={`sec-${group.id}`} className="settings-card config-group">
                <header className="settings-head">
                  <div>
                    <h2>{group.title}</h2>
                    <p>{group.description}</p>
                  </div>
                  <div className="settings-badges">
                    {group.kind === 'channels'
                      ? <span className="badge cold">{connectedChannels} / {channels.length} 个渠道已接入</span>
                      : <span className={`badge ${groupEffect(group, hotPaths).tone}`}>{groupEffect(group, hotPaths).label}</span>}
                    {dirty && <span className="badge dirty">已修改</span>}
                  </div>
                </header>

                {group.kind === 'channels' && (
                  <div className="channel-area">
                    <ChannelPicker
                      channels={channels}
                      activeId={activeChannel?.id}
                      onSelect={setChannelId}
                      draft={draft}
                      identity={identity}
                    />
                    {channels.length === 0
                      ? <p className="editor-empty">当前没有可用的消息渠道。</p>
                      : activeChannel && activeChannel.blocks.length > 0
                        ? <div className="channel-detail">
                            {activeChannel.blocks.filter(blockVisible).map(block => renderBlock(block, activeChannel))}
                          </div>
                        : <p className="editor-empty">该渠道已在内核注册，但面板还没有对应的配置表单。</p>}
                  </div>
                )}

                {group.kind !== 'channels' && (
                  <div className="config-blocks">
                    {group.blocks.filter(blockVisible).map(block => renderBlock(block))}
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

/** 配置块：标题 + 生效方式 + 内容；低频块默认折叠。 */
function ConfigBlockView({ block, effect, dirty, open, onToggle, children }: {
  block: ConfigBlock
  effect: { label: string; tone: string }
  dirty: boolean
  open: boolean
  onToggle: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <section className={`config-block ${open ? 'open' : 'folded'} ${dirty ? 'dirty' : ''}`}>
      <header className="config-block-head">
        <button type="button" className="config-block-toggle" onClick={onToggle} aria-expanded={open}>
          <Icon name="chevron" size={12} className="fold-chevron" />
          <span className="config-block-title">{block.title}</span>
        </button>
        <div className="settings-badges">
          <span className={`badge ${effect.tone}`}>{effect.label}</span>
          {dirty && <span className="badge dirty">已修改</span>}
        </div>
      </header>
      {open && (
        <div className="config-block-body">
          {block.description && <p className="config-block-desc">{block.description}</p>}
          {children}
        </div>
      )}
    </section>
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

/**
 * 把服务端返回配置里的指定路径合并进本地草稿。
 *
 * 渠道面板保存凭据后会回传一份完整配置；只回填渠道自己的路径，
 * 免得把用户其它还没保存的修改冲掉。
 */
function mergeConfigPaths(target: ConfigDoc, source: ConfigDoc, paths: string[]): ConfigDoc {
  let next = target
  for (const path of paths) {
    const value = getByPath(source, path)
    if (value !== undefined) next = setByPath(next, path, value)
  }
  return next
}

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
  const [plugins, setPlugins] = useState<PluginView[]>([])
  const [detecting, setDetecting] = useState(false)
  const [channelReady, setChannelReady] = useState(false)
  const [registered, setRegistered] = useState<{ id: string; kind: string }[]>([])
  const [channelId, setChannelId] = useState('')
  const [identity, setIdentity] = useState<IdentityStatusView | undefined>(undefined)
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
        setPlugins(data.plugins ?? [])
        setDetecting(Boolean(data.detecting))
        setIdentity(data.identity)
        setLoadError(null)
      })
      .catch(error => setLoadError(error instanceof Error ? error.message : String(error)))
    // 已注册的消息渠道由内核给出；拿不到（旧版服务）就退回前端的描述表。
    void getJson<{ channels?: { id: string; kind: string }[] }>('/api/channels')
      .then(data => setRegistered(data.channels ?? []))
      .catch(() => undefined)
  }, [])

  const runtimeCatalog = useMemo(() => mergeRuntimeChoices(runtimeChoices, plugins), [runtimeChoices, plugins])
  const runtimeId = normalizeRuntimeId(
    draft && typeof draft.runtime?.default === 'string' ? draft.runtime.default : ORCA_RUNTIME_ID,
  )
  const activeProjectsPath = projectPatchPath(runtimeId)
  const activeProjects = draft ? projectsOf(draft, runtimeId) : []
  const selectedRuntime = runtimeCatalog.find(runtime => runtime.id === runtimeId)
  const runtimeLabel = selectedRuntime ? runtimeDisplayName(selectedRuntime) : runtimeId
  // 运行时自己声明的选项（例如 Orca 用哪个 Agent）在卡片的「设置」弹窗里编辑；
  // 这里只保留字段声明用于保存前校验，不写死任何运行时。
  const optionSpecs = useMemo(
    () => plugins.flatMap(plugin => (plugin.kind === 'runtime' && plugin.options ? [plugin.options] : [])),
    [plugins],
  )
  const optionFields = useMemo(() => allRuntimeOptionFields(optionSpecs), [optionSpecs])
  const optionDefaults = useMemo(() => runtimeOptionDefaults(optionFields), [optionFields])

  // 渠道与它的接入项都来自渠道注册表；初始化页不再写死飞书。
  const channels = useMemo(() => mergeChannels(registered), [registered])
  const activeChannel = channels.find(channel => channel.id === channelId) ?? channels[0]
  const setupBlocks = useMemo(() => (activeChannel ? channelSetupBlocks(activeChannel) : []), [activeChannel])
  const setupFields = useMemo(() => (activeChannel ? channelSetupFields(activeChannel) : []), [activeChannel])
  const setupExtraFields = useMemo(() => (activeChannel ? channelSetupExtraFields(activeChannel) : []), [activeChannel])
  const setupPaths = useMemo(() => (activeChannel ? channelSetupPaths(activeChannel) : []), [activeChannel])

  const changed = useMemo(() => {
    if (!draft || !original) return []
    const paths = ['llm.baseUrl', 'llm.model', 'llm.apiKey', 'llm.api', 'llm.authHeader', 'runtime.default', ...setupPaths,
      ...runtimeOptionPaths(), ...optionFields.map(field => field.path)]
    paths.push(...changedPluginPaths(draft, original))
    for (const runtime of runtimeCatalog) paths.push(projectPatchPath(runtime.id))
    return paths.filter(path => JSON.stringify(fieldValue(draft, path)) !== JSON.stringify(fieldValue(original, path)))
  }, [draft, original, runtimeCatalog, setupPaths, optionFields])

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
    for (const field of setupFields) {
      const message = fieldError(field, getByPath(draft, field.path))
      if (message) map.set(field.path, message)
    }
    // 渠道自己的校验（群列表之类），由渠道描述提供；只校验本次确实要提交的路径。
    for (const [path, message] of Object.entries(activeChannel?.validate?.(draft) ?? {})) {
      if (message && changedSet.has(path)) map.set(path, message)
    }
    for (const field of optionFields) {
      // 没配置过的运行时选项取声明默认值，否则会被误判成「请选择一个有效值」。
      const message = fieldError(field, fieldValue(draft, field.path, optionDefaults))
      if (message) map.set(field.path, message)
    }
    for (const runtime of runtimeCatalog) {
      const path = projectPatchPath(runtime.id)
      // 只校验当前运行时的清单 + 本次确实要提交的其它清单，避免历史脏数据挡住保存。
      if (runtime.id !== runtimeId && !changedSet.has(path)) continue
      const issue = projectIssue(projectsOf(draft, runtime.id))
      if (issue) map.set(path, `${runtimeDisplayName(runtime)}：${issue}`)
    }
    // 自定义 acp 没有 command 时重启会直接启动失败，保存前就挡住。
    const selected = runtimeCatalog.find(runtime => runtime.id === runtimeId)
    if (runtimeId === ACP_RUNTIME_ID && selected?.status === 'not-installed') {
      map.set('runtime.default', '自定义 acp 未配置 runtime.options.acp.command，重启后服务会启动失败')
    }
    return map
  }, [draft, changed, runtimeCatalog, runtimeId, setupFields, activeChannel, optionFields, optionDefaults])

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
      if (result.plugins) setPlugins(result.plugins)
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
    if (result.plugins) setPlugins(result.plugins)
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
  const projectReady = activeProjects.length > 0 && !projectIssue(activeProjects)
  const chatReady = chats.length > 0 && !chatsIssue(chats)
  const llmConfig = (draft.llm ?? {}) as { baseUrl?: string; model?: string; apiKey?: string; apiKeySet?: boolean }
  // LLM Provider 必填：baseUrl + model + apiKey 缺一不可（本次新填、尚未保存的密钥也算）。
  const keyConfigured = Boolean(llmConfig.apiKeySet || String(llmConfig.apiKey ?? '').trim())
  const llmReady = Boolean(
    String(llmConfig.baseUrl ?? '').trim() && String(llmConfig.model ?? '').trim() && keyConfigured,
  )
  const channelName = activeChannel?.label ?? '渠道'
  const steps = [
    { label: 'LLM 已配置', hint: llmReady ? '已就绪' : '填写 Base URL / 模型 / API Key', done: llmReady },
    { label: '运行时可用', hint: runtimeReady ? '已就绪' : runtimeChoice ? runtimeStatusLabel(runtimeChoice.status) : '未选择', done: runtimeReady },
    { label: '已配置项目', hint: projectReady ? `${activeProjects.length} 个项目` : '至少一个', done: projectReady },
    { label: `${channelName}已接入`, hint: channelReady ? '已就绪' : `写入${channelName}接入信息`, done: channelReady },
    { label: '监控群已添加', hint: chatReady ? `${chats.length} 个群` : '至少一个', done: chatReady },
  ]
  const completed = steps.filter(step => step.done).length

  // 渠道面板的统一入参：初始化页与配置页给渠道的东西一样，只是渲染的块不同。
  const channelPanelProps: ChannelPanelProps = {
    draft,
    defaults,
    setField,
    errors,
    identity,
    staleIdentity: false,
    projects: activeProjects,
    runtimeLabel,
    onConfigSaved: config => {
      // 只回填渠道自己的路径，别把用户其它未保存的修改冲掉。
      setOriginal(current => (current ? mergeConfigPaths(current, config, setupPaths) : current))
      setDraft(current => (current ? mergeConfigPaths(current, config, setupPaths) : current))
    },
    onStatus: setChannelReady,
  }

  const renderSetupBlock = (block: ConfigBlock): JSX.Element => {
    const custom = activeChannel?.custom?.[block.id]
    const body = block.render === 'custom' && custom
      ? custom({ ...channelPanelProps, block })
      : (
        <div className="settings-rows">
          {block.fields.map(field => (
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
      )
    return (
      <div className="config-block" key={block.id}>
        <div className="config-block-head">
          <div>
            <span className="config-block-title">{block.title}</span>
            {block.description && <p className="config-block-desc">{block.description}</p>}
          </div>
        </div>
        <div className="config-block-body">{body}</div>
      </div>
    )
  }

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
          plugins={plugins}
          detecting={detecting}
          selected={runtimeId}
          onSelect={id => setField('runtime.default', id)}
          onChoices={setRuntimeChoices}
          onDetecting={setDetecting}
          onNotice={setNotice}
          onPendingRestart={() => setPendingRestart(true)}
          onAddRuntime={(id, entry) => setDraft(current => (current ? applyRuntimePluginDraft(current, id, entry) : current))}
          draft={draft}
          defaults={defaults}
          onOptionChange={(path, value) => setField(path, value)}
        />
      </section>

      <section className="settings-card" id="setup-projects">
        <header className="settings-head">
          <div>
            <h2>3. 项目配置</h2>
            <p>当前运行时：<strong>{runtimeLabel}</strong>。至少配置一个项目，群绑定才能选；可以扫本机会话日志批量导入，也可以选本机已有目录或填 Git 地址自动 clone。</p>
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

      <section className="settings-card" id="setup-channel">
        <header className="settings-head">
          <div>
            <h2>4. 渠道配置</h2>
            <p>消息从哪个渠道进来。先选渠道，再填它的接入信息并完成授权，Router 就能从那儿收消息。</p>
          </div>
          <div className="settings-badges">
            {channelReady ? <span className="badge hot">已就绪</span> : <span className="badge cold">未完成</span>}
          </div>
        </header>
        <div className="channel-area">
          <ChannelPicker
            channels={channels}
            activeId={activeChannel?.id}
            onSelect={setChannelId}
            draft={draft}
            identity={identity}
            label="选择渠道"
          />
          {activeChannel
            ? (
              <div className="channel-detail">
                {setupBlocks.map(block => renderSetupBlock(block))}
                {setupExtraFields.length > 0 && (
                  <div className="config-block">
                    <div className="config-block-body">
                      <div className="settings-rows">
                        {setupExtraFields.map(field => (
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
                    </div>
                  </div>
                )}
              </div>
            )
            : <p className="editor-empty">当前没有可用的消息渠道。</p>}
        </div>
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

/** 「扫描本地项目」的弹窗状态。 */
interface ProjectScanState {
  busy: boolean
  candidates: ScanCandidate[]
  selected: string[]
  importing: boolean
  error: string | null
  notice: string | null
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

/** 候选项目的最近活跃时间：显示到分钟。 */
function formatActivity(iso: string): string {
  const stamp = Date.parse(iso)
  if (Number.isNaN(stamp)) return iso
  const date = new Date(stamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
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
  const [scan, setScan] = useState<ProjectScanState | null>(null)
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

  /** 「扫描本地项目」：读 Claude Code / Codex / OpenCode 的会话日志，列出候选目录。 */
  const startScan = async (): Promise<void> => {
    setScan({ busy: true, candidates: [], selected: [], importing: false, error: null, notice: null })
    try {
      const result = await sendJson<{ projects: ScanCandidate[] }>('/api/projects/scan', 'POST', {})
      const candidates = result.projects ?? []
      setScan({
        busy: false,
        candidates,
        selected: defaultSelectedPaths(candidates),
        importing: false,
        error: null,
        notice: null,
      })
    } catch (failure) {
      setScan({ busy: false, candidates: [], selected: [], importing: false, error: dialogError(failure), notice: null })
    }
  }

  /** 导入勾选的项目：逐个登记（Orca 运行时同时登记到 Orca），再并进项目清单。 */
  const importSelected = async (): Promise<void> => {
    if (!scan) return
    const picked = scan.candidates.filter(candidate => scan.selected.includes(candidate.path))
    setScan({ ...scan, importing: true, error: null, notice: null })
    const drafts: ProjectDraft[] = []
    const failures: string[] = []
    for (const candidate of picked) {
      try {
        const prepared = await sendJson<ProjectInspectionView>('/api/projects/register', 'POST', { path: candidate.path, runtimeId })
        drafts.push({
          name: prepared.name || candidate.name,
          repo: prepared.repo ?? prepared.path,
          defaultBranch: prepared.detached ? '' : prepared.branch,
        })
        if (prepared.orca && !prepared.orca.registered) {
          failures.push(`${candidate.name}：登记到 Orca 失败（${prepared.orca.error ?? '未知原因'}）`)
        }
      } catch (failure) {
        failures.push(`${candidate.name}：${dialogError(failure)}`)
      }
    }
    if (drafts.length > 0) onChange(mergeImportedProjects(projects, drafts))
    setScan(current => (current
      ? {
        ...current,
        importing: false,
        selected: [],
        error: failures.length > 0 ? failures.join('；') : null,
        notice: drafts.length > 0 ? `已导入 ${drafts.length} 个项目，记得保存配置` : null,
      }
      : current))
  }

  const canAdd = Boolean(dialog?.info?.isGit && dialog.name.trim())

  return (
    <div className="editor">
      {projects.length === 0 && <p className="editor-empty">该运行时还没有项目。没有项目时开单会先追问仓库。</p>}
      {projects.length > 0 && (
        <div className="editor-head">
          <span>项目名</span>
          <span>本地仓库路径</span>
          <span>默认分支</span>
          <span />
        </div>
      )}
      {projects.map((project, index) => (
        <div key={index} className="editor-row project-row">
          <input value={project.name} placeholder="router-agent" onChange={event => update(index, { name: event.target.value })} />
          <input
            value={project.repo}
            placeholder="/Users/me/router-agent"
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
        <button className="btn add" onClick={() => void startScan()}>
          <Icon name="search" size={13} />扫描本地项目
        </button>
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

      {scan && (
        <div className="modal-layer">
          <button className="modal-backdrop" aria-label="关闭" onClick={() => { if (!scan.importing) setScan(null) }} />
          <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label="扫描本地项目">
            <header className="modal-head">
              <div>
                <h3>扫描本地项目</h3>
                <p>从 Claude Code / Codex / OpenCode 的历史会话日志里读出用过的目录，勾选后导入当前运行时。</p>
              </div>
              <button className="icon-btn" title="关闭" onClick={() => setScan(null)} disabled={scan.importing}>
                <Icon name="close" size={14} />
              </button>
            </header>
            <div className="modal-body">
              {scan.busy && <p className="modal-hint"><Icon name="refresh" size={13} className="spin" />正在扫描会话日志…</p>}
              {scan.error && <p className="modal-error">{scan.error}</p>}
              {scan.notice && <p className="modal-notice">{scan.notice}</p>}
              {!scan.busy && scan.candidates.length === 0 && (
                <p className="editor-empty">没有扫到候选项目。确认 Claude Code / Codex / OpenCode 在本机留有会话记录后再试。</p>
              )}
              {scan.candidates.length > 0 && (
                <div className="scan-list">
                  {scan.candidates.map(candidate => (
                    <label key={candidate.path} className="scan-item">
                      <input
                        type="checkbox"
                        checked={scan.selected.includes(candidate.path)}
                        disabled={scan.importing}
                        onChange={event => setScan(current => (current
                          ? {
                            ...current,
                            selected: event.target.checked
                              ? [...current.selected, candidate.path]
                              : current.selected.filter(item => item !== candidate.path),
                          }
                          : current))}
                      />
                      <span className="scan-item-main">
                        <strong>{candidate.name}</strong>
                        <code>{candidate.path}</code>
                      </span>
                      <span className="scan-item-meta">
                        <span>{candidate.sources.join(' / ')}</span>
                        <span>{formatActivity(candidate.lastActiveAt)}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <footer className="modal-foot">
              <button className="btn tiny" onClick={() => setScan(null)} disabled={scan.importing}>取消</button>
              <button
                className="btn primary"
                onClick={() => void importSelected()}
                disabled={scan.busy || scan.importing || scan.selected.length === 0}
              >
                {scan.importing ? '导入中…' : `导入勾选的 ${scan.selected.length} 个项目`}
              </button>
            </footer>
          </div>
        </div>
      )}
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
  const [filter, setFilter] = useState<LogFilter>(EMPTY_FILTER)
  const [syncedAt, setSyncedAt] = useState<Date | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [following, setFollowing] = useState(true)
  /** 展开完整字段的行；按 seq 记，行滚出缓冲区后自然失效。 */
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())

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

  // 各维度候选按「其它维度」的条件统计：选中 tk-84 后，级别上的「全部」就是这条链路的条数。
  const levelOptions = useMemo(() => facetCounts(lines, filter, 'level'), [lines, filter])
  // 类别的候选值是机器值（message / event / action），下拉里显示中文。
  const categoryOptions = useMemo(() => facetCounts(lines, filter, 'category').map(option => ({
    ...option,
    label: CATEGORY_LABEL[option.value] ?? option.value,
  })), [lines, filter])
  const domainOptions = useMemo(() => facetCounts(lines, filter, 'domain'), [lines, filter])
  const eventOptions = useMemo(() => facetCounts(lines, filter, 'event'), [lines, filter])
  const chatOptions = useMemo(() => facetCounts(lines, filter, 'chat'), [lines, filter])
  const actorOptions = useMemo(() => facetCounts(lines, filter, 'actor'), [lines, filter])
  const runtimeOptions = useMemo(() => facetCounts(lines, filter, 'runtime'), [lines, filter])
  const ticketOptions = useMemo(() => facetCounts(lines, filter, 'ticket'), [lines, filter])
  const traceOptions = useMemo(() => facetCounts(lines, filter, 'trace'), [lines, filter])

  // 候选里已经没有的选中值要退回「全部」，否则会出现「筛不出东西也不报错」的死状态。
  const domainValue = pickValue(domainOptions, filter.domain)
  const eventValue = pickValue(eventOptions, filter.event)
  const chatValue = pickValue(chatOptions, filter.chat)
  const actorValue = pickValue(actorOptions, filter.actor)
  const runtimeValue = pickValue(runtimeOptions, filter.runtime)
  const ticketValue = pickValue(ticketOptions, filter.ticket)
  const traceValue = pickValue(traceOptions, filter.trace)
  const categoryValue = pickValue(categoryOptions, filter.category)

  const visible = useMemo(
    () => filterLogLines(lines, {
      ...filter,
      category: categoryValue,
      domain: domainValue,
      event: eventValue,
      chat: chatValue,
      actor: actorValue,
      runtime: runtimeValue,
      ticket: ticketValue,
      trace: traceValue,
    }),
    [lines, filter, categoryValue, domainValue, eventValue, chatValue, actorValue, runtimeValue, ticketValue, traceValue],
  )

  const setDimension = useCallback((key: keyof LogFilter, value: string): void => {
    setFilter(prev => ({ ...prev, [key]: value }))
  }, [])

  const toggleRow = useCallback((seq: number): void => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(seq)) next.delete(seq)
      else next.add(seq)
      return next
    })
  }, [])

  // 行元素按过滤结果缓存：轮询没有新内容时不再重建整张列表。
  const rows = useMemo(() => visible.map(line => (
    <LogRowView key={line.seq} line={line} expanded={expanded.has(line.seq)} onToggle={() => toggleRow(line.seq)} />
  )), [visible, expanded, toggleRow])

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
    setFilter(EMPTY_FILTER)
  }, [])

  const levelCounts = useMemo(() => {
    const map: Record<string, number> = {}
    for (const option of levelOptions) map[option.value] = option.count
    // 「全部」是不限级别时的条数：其它维度都算上。
    map.all = levelOptions.reduce((sum, option) => sum + option.count, 0)
    return map
  }, [levelOptions])
  const levels = LOG_LEVELS.filter(item => item !== 'raw' || (levelCounts.raw ?? 0) > 0)
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
        {/* 第一行：级别（scope）在左，搜索与工具在右。 */}
        <div className="log-toolbar">
          <div className="segmented log-levels" role="group" aria-label="按级别过滤">
            {levels.map(item => (
              <button
                key={item}
                type="button"
                className={filter.level === item ? 'active' : ''}
                aria-pressed={filter.level === item}
                onClick={() => setDimension('level', item)}
              >
                {item !== 'all' && <span className="log-chip-dot" style={{ background: LOG_LEVEL_COLOR[item] }} />}
                <span>{LOG_LEVEL_LABEL[item]}</span>
                <span className="log-chip-count">{levelCounts[item] ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="search-box log-search">
            <Icon name="search" size={15} />
            <input
              value={filter.keyword}
              onChange={event => setDimension('keyword', event.target.value)}
              placeholder="搜索事件、字段或群名…"
              aria-label="过滤日志"
            />
          </div>
          {notice && <span className="log-notice" role="status">{notice}</span>}
          <button className="btn ghost tiny log-toolbar-end" onClick={() => setLines([])} disabled={lines.length === 0}>清空视图</button>
        </div>

        {/* 第二行：多维过滤。每一维都能单独收窄，维度之间取交集。 */}
        <div className="log-toolbar log-toolbar-dims">
          <div className="log-dims" role="group" aria-label="按维度过滤">
            <FilterMenu label="类别" value={categoryValue} options={categoryOptions} onChange={value => setDimension('category', value)} />
            <FilterMenu label="域" value={domainValue} options={domainOptions} onChange={value => setDimension('domain', value)} />
            <FilterMenu label="动作" value={eventValue} options={eventOptions} onChange={value => setDimension('event', value)} />
            <FilterMenu label="群" value={chatValue} options={chatOptions} onChange={value => setDimension('chat', value)} />
            <FilterMenu label="发起人" value={actorValue} options={actorOptions} onChange={value => setDimension('actor', value)} />
            <FilterMenu label="运行时" value={runtimeValue} options={runtimeOptions} onChange={value => setDimension('runtime', value)} />
            <FilterMenu label="工单" value={ticketValue} options={ticketOptions} onChange={value => setDimension('ticket', value)} />
            <FilterMenu label="追踪" value={traceValue} options={traceOptions} onChange={value => setDimension('trace', value)} />
            {isFilterActive(filter) && (
              <button className="btn ghost tiny" onClick={clearFilters}>清除筛选</button>
            )}
          </div>
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
              <small>{lines.length === 0 ? '服务产生新日志后会自动出现在这里。' : '换个级别、维度或关键字试试。'}</small>
              {isFilterActive(filter) && (
                <button className="btn ghost tiny" onClick={clearFilters}>清除筛选</button>
              )}
            </div>
          ) : (
            <table className="log-table">
              <colgroup>
                <col className="log-col-time" />
                <col className="log-col-level" />
                <col className="log-col-category" />
                <col className="log-col-event" />
                <col className="log-col-chat" />
                <col className="log-col-actor" />
                <col className="log-col-runtime" />
                <col className="log-col-ticket" />
                <col className="log-col-detail" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">时间</th>
                  <th scope="col">级别</th>
                  <th scope="col">类别</th>
                  <th scope="col">事件</th>
                  <th scope="col">群</th>
                  <th scope="col">发起人</th>
                  <th scope="col">运行时</th>
                  <th scope="col">工单</th>
                  <th scope="col">详情</th>
                </tr>
              </thead>
              <tbody>{rows}</tbody>
            </table>
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

/**
 * 一行日志：左边是能定位的维度，右边是这条事件的业务字段。
 *
 * 点事件名展开完整字段——表格里放不下全部字段，展开后能看到原始值。
 */
function LogRowView({ line, expanded, onToggle }: { line: LogLine; expanded: boolean; onToggle: () => void }): JSX.Element {
  const details = line.data ? Object.entries(line.data) : []
  return (
    <>
      <tr className={`log-row level-${line.level}`}>
        <td className="log-cell-time">{logClock(line.at)}</td>
        <td className="log-cell-level">
          <span className="log-chip-dot" style={{ background: LOG_LEVEL_COLOR[line.level] ?? LOG_LEVEL_COLOR.all }} />
          {LOG_LEVEL_LABEL[line.level] ?? line.level.toUpperCase()}
        </td>
        <td className="log-cell-category">{CATEGORY_LABEL[line.category ?? ''] ?? '—'}</td>
        <td className="log-cell-event">
          <button type="button" className="log-event-button" onClick={onToggle} aria-expanded={expanded}>
            <Icon name="chevron" size={11} className={`log-event-chevron${expanded ? ' open' : ''}`} />
            {line.message}
          </button>
        </td>
        <td className="log-cell-chat" title={line.chatName || line.chat || undefined}>{line.chatName || line.chat || '—'}</td>
        <td className="log-cell-actor">
          {line.actorName || line.actor
            ? <><span className="log-actor-name">{line.actorName || line.actor}</span>{ACTOR_LABEL[line.actorType ?? ''] && <span className="log-actor-type">{ACTOR_LABEL[line.actorType ?? '']}</span>}</>
            : '—'}
        </td>
        <td className="log-cell-runtime">{line.runtime || '—'}</td>
        <td className="log-cell-ticket">{line.ticket || '—'}</td>
        <td className="log-cell-detail">
          {details.length === 0
            ? '—'
            : details.map(([key, value]) => (
              <span key={key} className="log-pair">
                <span className="log-key">{key}</span>={formatLogValue(value)}
              </span>
            ))}
        </td>
      </tr>
      {expanded && (
        <tr className="log-detail-row">
          <td colSpan={9}>
            <div className="log-detail-grid">
              <LogDetailField label="时间" value={line.at || '—'} />
              <LogDetailField label="级别" value={line.level} />
              <LogDetailField label="类别" value={`${CATEGORY_LABEL[line.category ?? ''] ?? '—'}（${line.category ?? '—'}）`} />
              <LogDetailField label="事件" value={line.message} />
              <LogDetailField label="域 / 动作" value={`${line.domain || '—'} / ${line.event || '—'}`} />
              <LogDetailField label="群" value={line.chatName ? `${line.chatName}（${line.chat ?? ''}）` : line.chat || '—'} />
              <LogDetailField label="发起人" value={line.actorName ? `${line.actorName}（${line.actor ?? ''}）` : line.actor || '—'} />
              <LogDetailField label="发起人类型" value={ACTOR_LABEL[line.actorType ?? ''] ?? '—'} />
              <LogDetailField label="运行时" value={line.runtime || '—'} />
              <LogDetailField label="工单" value={line.ticket || '—'} />
              <LogDetailField label="链路 ID" value={line.trace || '—'} />
              {details.map(([key, value]) => (
                <LogDetailField key={key} label={key} value={formatLogValue(value)} />
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/** 展开行里的一个字段：标签在左、值在右，长值独占一行。 */
function LogDetailField({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="log-detail-field">
      <span className="log-detail-label">{label}</span>
      <span className="log-detail-value">{value}</span>
    </div>
  )
}

/** 选中值不在候选里时退回「全部」，避免筛不出东西也不报错。 */
function pickValue(options: { value: string }[], current: string): string {
  return options.some(option => option.value === current) ? current : ALL_FILTER
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
