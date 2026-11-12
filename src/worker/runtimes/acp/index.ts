import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { realRunner, type CommandRunner } from '../../../infra/process.js'
import { GitWorktreeProvider } from '../../workspaces/git-worktree.js'
import { workBranch, worktreeName } from '../../naming.js'
import {
  WorkerRuntimeError,
  type ActivityQuery,
  type AgentStatus,
  type DeliverOptions,
  type DeliveryReceipt,
  type DiagnosticCheck,
  type InboundMessage,
  type RuntimeCapabilities,
  type SessionEvent,
  type SessionSnapshot,
  type StartResult,
  type ToolPolicy,
  type WorkerContext,
  type WorkerRef,
  type WorkerRuntime,
  type WorkspaceInfo,
  type WorkspaceProvider,
  type WorkspaceRef,
} from '../../port.js'
import { latestActivityAt } from '../../status.js'
import { AcpConnection, AcpProtocolError } from './protocol.js'
import { decidePermission, type AcpPermissionOption, type AcpToolCallInfo } from './permissions.js'

const CLIENT_NAME = 'router-agent'
const CLIENT_VERSION = '0.1.0'
const CHANNEL = 'acp'

type AcpWorkspaceProvider = WorkspaceProvider & {
  deleteBranch?(branch: string, repo: string): Promise<void>
}

export interface AcpRuntimeOptions {
  /** 运行时 id；默认 'acp'。动态 ACP Agent 用 acp-<agent>。 */
  id?: string
  /** ACP Agent 可执行文件，例如 opencode / claude-agent-acp / codex-acp。 */
  command?: string
  /** 传给 Agent 的参数，例如 ['acp']。 */
  args?: string[]
  /** 命令不可用时的原因，start() 会原样带进 runtime:unavailable。 */
  unavailableReason?: string
  /** 安装提示，例如 ra runtime install codex。 */
  installHint?: string
  /** 版本探测参数；默认 ['--version']。codex-acp 用 ['version']。 */
  probeArgs?: string[]
  /** ~/.router-agent/workers */
  workersDir: string
  /** ~/.router-agent */
  home: string
  /** 绑定到 git 的 runner，用于 worktree 的回收/查询。 */
  git: CommandRunner
  /** 额外环境变量；会叠加到 process.env 之上。 */
  env?: NodeJS.ProcessEnv
  /** 允许创建 worktree 的根目录；默认 <home>/worktrees。 */
  worktreesRoot?: string
  /** initialize / session/new / session/load 的超时，默认 30s。 */
  initializeTimeoutMs?: number
  /** 测试注入：替换 GitWorktreeProvider。 */
  workspaceProvider?: AcpWorkspaceProvider
}

interface AcpInitializeResult {
  protocolVersion?: number
  agentCapabilities?: { loadSession?: boolean }
  agentInfo?: { name?: string; version?: string }
  authMethods?: Array<{ id?: string; name?: string; description?: string }>
}

interface AcpMeta {
  schemaVersion: number
  ticketId: string
  assignmentId?: string
  runtime: string
  handle: string
  workdir: string
  repo: string
  branch: string
  workBranch: string
  sessionId?: string
  pid?: number
  loadSession?: boolean
  status?: string
  startedAt?: string
  lastError?: string
  lastHandedOffInputId?: string
  lastHandedOffAttempt?: number
  tools?: ToolPolicy
}

interface AcpSession {
  ticketId: string
  sessionId: string
  workdir: string
  branch: string
  tools: ToolPolicy
  loadSession: boolean
  connection: AcpConnection
  inFlight: boolean
  promptStartedAt?: string
  lastEventAt?: string
  lastStopReason?: string
  lastError?: string
  /** session/load 的历史重放不写入活动，避免重复。 */
  suppressUpdates: boolean
}

const READ_ONLY_TOOLS: ToolPolicy = { fileAccess: 'read-only', shell: 'deny', allowNetwork: false }

/**
 * ACP（Agent Client Protocol）运行时。
 *
 * 客户端侧实现：spawn 一个 ACP Agent 子进程，通过 stdio JSON-RPC 驱动
 * initialize → session/new → session/prompt，并处理 session/update 与权限请求。
 * 工作区仍由 GitWorktreeProvider 负责，与 Claude/Orca 运行时保持一致。
 */
export class AcpRuntime implements WorkerRuntime {
  readonly id: string
  readonly capabilities: RuntimeCapabilities = {
    agent: { liveStatus: true, processExit: true, output: false, activity: true, structuredInput: true, nudge: false },
    workspace: { cleanup: true, prLink: false, discovery: false },
  }

  private readonly command: string | undefined
  private readonly args: string[]
  private readonly env: NodeJS.ProcessEnv
  private readonly workersDir: string
  private readonly home: string
  private readonly initializeTimeoutMs: number
  private readonly unavailableReason?: string
  private readonly installHint?: string
  private readonly probeArgs: string[]
  private readonly gitProvider: GitWorktreeProvider
  private readonly workspaces: AcpWorkspaceProvider
  private readonly sessions = new Map<string, AcpSession>()
  private readonly bySessionId = new Map<string, AcpSession>()

  constructor(opts: AcpRuntimeOptions) {
    this.id = opts.id ?? 'acp'
    this.command = opts.command?.trim() || undefined
    this.args = opts.args ?? []
    this.env = opts.env ?? {}
    this.workersDir = opts.workersDir
    this.home = opts.home
    this.initializeTimeoutMs = opts.initializeTimeoutMs ?? 30_000
    this.unavailableReason = opts.unavailableReason
    this.installHint = opts.installHint
    this.probeArgs = opts.probeArgs ?? ['--version']
    this.gitProvider = new GitWorktreeProvider({
      git: opts.git,
      worktreesRoot: opts.worktreesRoot ?? join(opts.home, 'worktrees'),
    })
    this.workspaces = opts.workspaceProvider ?? this.gitProvider
  }

  async start(ctx: WorkerContext): Promise<StartResult> {
    if (!this.command) {
      throw new WorkerRuntimeError(
        'runtime:unavailable',
        this.unavailableReason ?? `ACP Agent ${this.id} 不可用`,
        {
          retryable: false,
          detail: {
            runtimeId: this.id,
            ...(this.unavailableReason ? { reason: this.unavailableReason } : {}),
            ...(this.installHint ? { hint: this.installHint } : {}),
          },
        },
      )
    }
    const ticket = ctx.ticket
    const repo = ticket.repo
    const baseBranch = ticket.branch
    if (!repo) throw new WorkerRuntimeError('workspace:missing-repo', '工单没有指定仓库，拒绝创建 worktree')
    if (!baseBranch) throw new WorkerRuntimeError('workspace:missing-branch', '工单没有指定起始分支，拒绝创建 worktree')

    const branch = workBranch(ticket)
    const name = worktreeName(ticket)
    const workdir = ctx.workdir || join(this.home, 'worktrees', name)
    const dir = join(this.workersDir, ticket.id)
    mkdirSync(dir, { recursive: true })
    const briefPath = join(dir, 'brief.md')

    const workspace = await this.workspaces.create({
      ticketId: ticket.id,
      repo,
      baseBranch,
      workBranch: branch,
      name,
      workdir,
    })
    const contract = (ctx.brief?.contract ?? `执行工单 ${ticket.id}：${ticket.title}`)
      .replace('(由运行时决定)', workspace.workdir)
    writeFileSync(briefPath, contract, 'utf8')

    const meta: AcpMeta = {
      schemaVersion: 3,
      ticketId: ticket.id,
      ...(ctx.assignment.id ? { assignmentId: ctx.assignment.id } : {}),
      runtime: this.id,
      handle: '',
      workdir: workspace.workdir,
      repo,
      branch: baseBranch,
      workBranch: workspace.branch,
      status: 'starting',
      startedAt: new Date().toISOString(),
      tools: ctx.tools ?? READ_ONLY_TOOLS,
    }
    this.writeMeta(ticket.id, meta)

    let connection: AcpConnection | undefined
    try {
      connection = this.spawnConnection(workspace.workdir)
      const init = await this.initialize(connection)
      const sessionId = await this.newSession(connection, workspace.workdir)
      const session = this.registerSession({
        ticketId: ticket.id,
        sessionId,
        workdir: workspace.workdir,
        branch: workspace.branch,
        tools: ctx.tools ?? READ_ONLY_TOOLS,
        loadSession: init.agentCapabilities?.loadSession === true,
        connection,
      })

      meta.handle = sessionId
      meta.sessionId = sessionId
      meta.loadSession = session.loadSession
      if (connection.pid !== undefined) meta.pid = connection.pid
      meta.status = 'running'
      this.writeMeta(ticket.id, meta)

      this.prompt(session, `${contract}\n\n完成后用 ra report 上报。`)
      return {
        handle: sessionId,
        workdir: workspace.workdir,
        branch: workspace.branch,
        sessionId,
        workspaceRef: workspace.workspaceRef,
      }
    } catch (error) {
      await connection?.close().catch(() => {})
      await this.rollback(workspace.workdir, workspace.branch, repo)
      throw this.launchError(error, workspace.workdir, workspace.branch)
    }
  }

  async deliver(ref: WorkerRef, inputs: InboundMessage[], opts: DeliverOptions = {}): Promise<DeliveryReceipt> {
    const inputIds = inputs.map(input => input.id)
    if (inputs.length === 0) return { status: 'accepted', inputIds }

    let meta = this.readMeta(ref.ticketId)
    let session = this.sessions.get(ref.ticketId)
    if (session && !session.connection.alive) {
      this.dropSession(session)
      session = undefined
    }
    if (!session) {
      const revived = await this.revive(meta).catch(() => null)
      if (!revived) {
        return { status: 'rejected', inputIds, reason: 'acp:agent-gone', retryable: true, retryAfterMs: 30_000 }
      }
      session = revived
      meta = this.readMeta(ref.ticketId) ?? meta
    }
    if (session.inFlight) {
      return { status: 'queued', inputIds, reason: 'acp:busy' }
    }
    if (opts.redeliver !== true
      && meta?.lastHandedOffInputId === inputs.at(-1)?.id
      && meta?.lastHandedOffAttempt === (opts.attempt ?? 1)) {
      return { status: 'accepted', inputIds }
    }

    const text = inputs.map(input => `【Router 输入 ${input.id}】\n${input.text}`).join('\n\n')
    try {
      this.prompt(session, `${text}\n\n继续执行工单，完成后用 ra report 上报。`)
    } catch (error) {
      return {
        status: 'rejected',
        inputIds,
        reason: error instanceof WorkerRuntimeError ? error.reason : 'acp:deliver-failed',
        retryable: true,
        retryAfterMs: 30_000,
      }
    }
    if (meta) {
      meta.lastHandedOffInputId = inputs.at(-1)?.id
      meta.lastHandedOffAttempt = opts.attempt ?? 1
      meta.status = 'running'
      this.writeMeta(ref.ticketId, meta)
    }
    return { status: 'accepted', inputIds }
  }

  async stop(ref: WorkerRef, _reason: string): Promise<void> {
    const session = this.sessions.get(ref.ticketId)
    if (session) {
      try {
        session.connection.notify('session/cancel', { sessionId: session.sessionId })
      } catch {
        // 进程已退出时 cancel 无意义，继续清理。
      }
      this.dropSession(session)
      await session.connection.close().catch(() => {})
    }
    const meta = this.readMeta(ref.ticketId)
    if (meta) {
      meta.status = 'stopped'
      this.writeMeta(ref.ticketId, meta)
    }
  }

  /** 重启对账用：把磁盘上仍可 load 的会话直接接回来，失败返回 false 交给上层兜底。 */
  async reattach(ref: WorkerRef): Promise<boolean> {
    const session = this.sessions.get(ref.ticketId)
    if (session?.connection.alive) return true
    if (session) this.dropSession(session)
    return (await this.revive(this.readMeta(ref.ticketId))) !== null
  }

  async status(ref: WorkerRef): Promise<AgentStatus | null> {
    const session = this.sessions.get(ref.ticketId)
    const meta = this.readMeta(ref.ticketId)
    if (!session) {
      if (!meta) return null
      // 重启后内存会话已丢，用活动日志的落盘时间估算最后活动，别拿启动时间冒充。
      const lastActivityAt = this.lastEventAtFromFile(ref.ticketId) ?? meta.startedAt
      return {
        alive: false,
        phase: 'exited',
        acceptingInput: meta.loadSession === true && Boolean(meta.sessionId),
        ...(lastActivityAt ? { lastActivityAt } : {}),
        ...(meta.lastError ? { detail: { source: this.id, error: meta.lastError } } : { detail: { source: this.id, status: meta.status } }),
      }
    }
    const lastActivityAt = latestActivityAt(session.lastEventAt, session.promptStartedAt) ?? meta?.startedAt
    if (!session.connection.alive) {
      return {
        alive: false,
        phase: 'exited',
        acceptingInput: session.loadSession,
        ...(lastActivityAt ? { lastActivityAt } : {}),
        ...(session.connection.exit.code !== null ? { exitCode: session.connection.exit.code } : {}),
        detail: { source: this.id, status: 'exited' },
      }
    }
    if (session.inFlight) {
      return {
        alive: true,
        phase: 'running',
        acceptingInput: false,
        ...(lastActivityAt ? { lastActivityAt } : {}),
        detail: { source: this.id, status: 'working' },
      }
    }
    return {
      alive: true,
      phase: 'running',
      acceptingInput: true,
      ...(lastActivityAt ? { lastActivityAt } : {}),
      detail: {
        source: this.id,
        status: session.lastError ? 'error' : 'idle',
        ...(session.lastError ? { error: session.lastError } : {}),
        ...(session.lastStopReason ? { stopReason: session.lastStopReason } : {}),
      },
    }
  }

  async activity(query: ActivityQuery): Promise<SessionSnapshot | null> {
    const meta = this.readMeta(query.ref.ticketId)
    const session = this.sessions.get(query.ref.ticketId)
    if (!meta && !session) return null
    const events = this.readEvents(query.ref.ticketId)
    const max = query.opts?.maxEvents ?? 40
    const tail = events.slice(-max)
    const sessionId = query.ref.sessionId ?? session?.sessionId ?? meta?.sessionId
    const at = tail.at(-1)?.at ?? session?.lastEventAt ?? meta?.startedAt ?? new Date().toISOString()
    return { at, events: tail, ...(sessionId ? { sessionId } : {}) }
  }

  async inspectWorkspace(ref: WorkspaceRef): Promise<WorkspaceInfo | null> {
    return this.workspaces.inspect(ref.workdir)
  }

  async removeWorkspace(ref: WorkspaceRef): Promise<void> {
    const meta = this.readMeta(ref.ticketId)
    await this.workspaces.remove(ref.workdir, { repo: ref.repo ?? meta?.repo })
  }

  async repoSlug(ref: WorkerRef): Promise<string | null> {
    if (!ref.workdir) return null
    return this.gitProvider.remoteRepo(ref.workdir)
  }

  async doctor(): Promise<DiagnosticCheck[]> {
    const checks: DiagnosticCheck[] = []
    if (!this.command) {
      checks.push({
        name: `ACP Agent (${this.id})`,
        status: 'fail',
        detail: this.unavailableReason ?? '未找到可执行文件',
        hint: this.installHint ?? `安装该 Agent 后重启服务，或在 runtime.options.${this.id}.command 指定可执行文件`,
      })
    } else {
      const version = await realRunner(this.command).run(this.probeArgs, {
        cwd: this.home,
        env: { ...process.env, ...this.env },
        timeoutMs: 5_000,
      })
      checks.push({
        name: `ACP Agent (${this.id})`,
        status: version.code === 0 ? 'ok' : 'fail',
        detail: version.code === 0
          ? version.stdout.trim().split('\n')[0] ?? this.command
          : `${version.stderr || version.stdout}`.trim().slice(0, 160),
        ...(version.code === 0 ? {} : { hint: this.installHint ?? `确认 ${this.command} 可执行；命令与参数由 runtime.options.${this.id}.command/args 配置` }),
      })
    }
    const git = await this.gitProvider.version()
    checks.push({
      name: 'git worktree',
      status: git === null ? 'fail' : 'ok',
      detail: git ?? 'git --version 不可用',
      ...(git === null ? { hint: '安装 git，并确认 git worktree 可用' } : {}),
    })
    return checks
  }

  private spawnConnection(cwd: string): AcpConnection {
    if (!this.command) {
      throw new WorkerRuntimeError('runtime:unavailable', this.unavailableReason ?? `ACP Agent ${this.id} 不可用`)
    }
    return new AcpConnection({
      command: this.command,
      args: this.args,
      cwd,
      env: { ...process.env, ...this.env },
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
      onExit: (code, signal, stderr) => this.onExit(cwd, code, signal, stderr),
    })
  }

  private async initialize(connection: AcpConnection): Promise<AcpInitializeResult> {
    const init = await connection.request<AcpInitializeResult>('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: CLIENT_NAME, title: 'Router Agent', version: CLIENT_VERSION },
    }, this.initializeTimeoutMs)
    if (Number(init?.protocolVersion) !== 1) {
      throw new WorkerRuntimeError('agent:launch-failed', `ACP Agent 协议版本不兼容: ${init?.protocolVersion ?? 'unknown'}`, {
        detail: { protocolVersion: init?.protocolVersion },
      })
    }
    return init
  }

  private async newSession(connection: AcpConnection, workdir: string): Promise<string> {
    try {
      const result = await connection.request<{ sessionId?: string }>('session/new', {
        cwd: workdir,
        mcpServers: [],
      }, this.initializeTimeoutMs)
      if (!result?.sessionId) {
        throw new WorkerRuntimeError('agent:launch-failed', 'ACP session/new 没有返回 sessionId')
      }
      return result.sessionId
    } catch (error) {
      if (error instanceof AcpProtocolError && error.code === -32000) {
        throw new WorkerRuntimeError('agent:launch-failed', `ACP Agent 未完成认证: ${error.message}`, {
          detail: { code: error.code, data: error.data },
        })
      }
      throw error
    }
  }

  private registerSession(input: Omit<AcpSession, 'inFlight' | 'suppressUpdates'>): AcpSession {
    const session: AcpSession = { ...input, inFlight: false, suppressUpdates: false }
    this.sessions.set(session.ticketId, session)
    this.bySessionId.set(session.sessionId, session)
    return session
  }

  private prompt(session: AcpSession, text: string): void {
    if (session.inFlight) {
      throw new WorkerRuntimeError('agent:not-accepting-input', 'ACP 会话仍在执行上一轮')
    }
    session.inFlight = true
    session.promptStartedAt = new Date().toISOString()
    session.lastError = undefined
    session.connection
      .request<{ stopReason?: string }>('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text }],
      }, 0)
      .then(result => {
        if (this.bySessionId.get(session.sessionId) !== session) return
        session.inFlight = false
        session.promptStartedAt = undefined
        session.lastStopReason = result?.stopReason
        session.lastEventAt = new Date().toISOString()
      })
      .catch(error => {
        if (this.bySessionId.get(session.sessionId) !== session) return
        session.inFlight = false
        session.promptStartedAt = undefined
        session.lastError = error instanceof Error ? error.message : String(error)
        this.writeMetaStatus(session.ticketId, { status: 'error', lastError: session.lastError })
      })
  }

  private async revive(meta: AcpMeta | null): Promise<AcpSession | null> {
    if (!meta?.sessionId || meta.loadSession !== true) return null
    const connection = this.spawnConnection(meta.workdir)
    let session: AcpSession | undefined
    try {
      const init = await this.initialize(connection)
      if (init.agentCapabilities?.loadSession !== true) {
        throw new WorkerRuntimeError('agent:launch-failed', 'ACP Agent 未声明 loadSession，无法恢复会话')
      }
      session = this.registerSession({
        ticketId: meta.ticketId,
        sessionId: meta.sessionId,
        workdir: meta.workdir,
        branch: meta.workBranch,
        tools: meta.tools ?? READ_ONLY_TOOLS,
        loadSession: true,
        connection,
      })
      session.suppressUpdates = true
      try {
        await connection.request('session/load', {
          sessionId: meta.sessionId,
          cwd: meta.workdir,
          mcpServers: [],
        }, this.initializeTimeoutMs)
      } finally {
        session.suppressUpdates = false
      }
      meta.status = 'running'
      if (connection.pid !== undefined) meta.pid = connection.pid
      this.writeMeta(meta.ticketId, meta)
      // 重连本身算一次活动，避免用重启前的 startedAt 立即判 idle。
      session.lastEventAt = new Date().toISOString()
      return session
    } catch (error) {
      if (session) this.dropSession(session)
      await connection.close().catch(() => {})
      return null
    }
  }

  private dropSession(session: AcpSession): void {
    this.sessions.delete(session.ticketId)
    this.bySessionId.delete(session.sessionId)
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return
    const payload = params as { sessionId?: string; update?: Record<string, unknown> } | undefined
    const session = payload?.sessionId ? this.bySessionId.get(payload.sessionId) : undefined
    if (!session || session.suppressUpdates) return
    const update = payload?.update
    if (!update) return
    const kind = String(update.sessionUpdate ?? '')
    const at = new Date().toISOString()
    if (kind === 'agent_message_chunk') {
      const text = contentText(update.content)
      if (text) this.recordEvent(session, { at, kind: 'text', text })
      return
    }
    if (kind === 'tool_call') {
      const title = typeof update.title === 'string' ? update.title : undefined
      const toolKind = typeof update.kind === 'string' ? update.kind : 'tool'
      const target = toolTarget(update)
      this.recordEvent(session, {
        at,
        kind: 'tool',
        text: title ?? toolKind,
        tool: { name: title ?? toolKind, ...(target ? { target } : {}) },
      })
    }
    // tool_call_update / plan / usage 等只更新状态，不重复写入活动。
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'session/request_permission') {
      const payload = params as {
        sessionId?: string
        toolCall?: AcpToolCallInfo
        options?: AcpPermissionOption[]
      } | undefined
      const session = payload?.sessionId ? this.bySessionId.get(payload.sessionId) : undefined
      const tools = session?.tools ?? READ_ONLY_TOOLS
      const options = Array.isArray(payload?.options) ? payload.options : []
      const choice = payload?.toolCall ? decidePermission(tools, payload.toolCall, options) : null
      if (!choice) return { outcome: { outcome: 'cancelled' } }
      return { outcome: { outcome: 'selected', optionId: choice.optionId } }
    }
    throw new AcpProtocolError(-32601, `ACP 客户端不支持该方法: ${method}`)
  }

  private onExit(cwd: string, code: number | null, signal: NodeJS.Signals | null, stderr: string): void {
    for (const session of this.sessions.values()) {
      if (session.workdir !== cwd || session.connection.alive) continue
      session.inFlight = false
      session.promptStartedAt = undefined
      session.lastError = `ACP agent 退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）${stderr ? `: ${stderr.slice(-300)}` : ''}`
      this.writeMetaStatus(session.ticketId, { status: 'exited', lastError: session.lastError })
    }
  }

  private recordEvent(session: AcpSession, event: SessionEvent): void {
    session.lastEventAt = event.at
    try {
      const dir = join(this.workersDir, session.ticketId)
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, `${CHANNEL}-events.jsonl`), `${JSON.stringify(event)}\n`, 'utf8')
    } catch {
      // 活动落盘失败不应影响主流程；内存里仍可从文件缺失时降级。
    }
  }

  private readEvents(ticketId: string): SessionEvent[] {
    try {
      const text = readFileSync(join(this.workersDir, ticketId, `${CHANNEL}-events.jsonl`), 'utf8')
      const events: SessionEvent[] = []
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as SessionEvent
          if (parsed && typeof parsed.at === 'string' && (parsed.kind === 'text' || parsed.kind === 'tool')) {
            events.push(parsed)
          }
        } catch {
          // 跳过损坏行。
        }
      }
      return events
    } catch {
      return []
    }
  }

  /** 活动日志的最后落盘时间；文件不存在时返回 undefined。 */
  private lastEventAtFromFile(ticketId: string): string | undefined {
    try {
      return statSync(join(this.workersDir, ticketId, `${CHANNEL}-events.jsonl`)).mtime.toISOString()
    } catch {
      return undefined
    }
  }

  private async rollback(workdir: string, branch: string, repo: string): Promise<void> {
    await this.workspaces.remove(workdir, { repo }).catch(() => {})
    if (this.workspaces.deleteBranch) {
      await this.workspaces.deleteBranch(branch, repo).catch(() => {})
    }
  }

  private launchError(error: unknown, workdir: string, branch: string): WorkerRuntimeError {
    if (error instanceof WorkerRuntimeError) {
      return new WorkerRuntimeError(error.code, error.reason, {
        retryable: error.retryable,
        cause: error.cause,
        detail: { ...error.detail, workdir, branch, command: this.command },
      })
    }
    const message = error instanceof Error ? error.message : String(error)
    return new WorkerRuntimeError('agent:launch-failed', `ACP Agent 启动失败: ${message}`, {
      cause: error instanceof Error ? error.stack : undefined,
      detail: { workdir, branch, command: this.command },
    })
  }

  private metaPath(ticketId: string): string {
    return join(this.workersDir, ticketId, 'meta.json')
  }

  private readMeta(ticketId: string): AcpMeta | null {
    try {
      return JSON.parse(readFileSync(this.metaPath(ticketId), 'utf8')) as AcpMeta
    } catch {
      return null
    }
  }

  private writeMeta(ticketId: string, meta: AcpMeta): void {
    const path = this.metaPath(ticketId)
    mkdirSync(join(this.workersDir, ticketId), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  }

  private writeMetaStatus(ticketId: string, patch: Partial<AcpMeta>): void {
    const meta = this.readMeta(ticketId)
    if (!meta) return
    this.writeMeta(ticketId, { ...meta, ...patch })
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(contentText).join('')
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') return record.text
  }
  return ''
}

function toolTarget(update: Record<string, unknown>): string | undefined {
  const locations = update.locations
  if (Array.isArray(locations)) {
    for (const item of locations) {
      if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).path === 'string') {
        return (item as Record<string, unknown>).path as string
      }
    }
  }
  const raw = update.rawInput
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>
    if (typeof record.command === 'string') return record.command
    if (typeof record.file_path === 'string') return record.file_path
    if (typeof record.path === 'string') return record.path
  }
  return undefined
}
