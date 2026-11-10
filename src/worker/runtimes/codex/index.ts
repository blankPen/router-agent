import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { preview } from '../../../core/events.js'
import { errorMessage, noopLogger, type Logger } from '../../../infra/logger.js'
import { realRunner, type CommandRunner } from '../../../infra/process.js'
import { GitWorktreeProvider } from '../../workspaces/git-worktree.js'
import { workBranch, worktreeName } from '../../naming.js'
import { latestActivityAt } from '../../status.js'
import { shellAllowed } from '../acp/permissions.js'
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
import { CodexAppClient, CodexProtocolError } from './client.js'
import {
  detectCodexBinary,
  type CodexAppOptions,
  type CodexBinaryDetection,
} from './detect.js'

const CLIENT_NAME = 'router-agent'
const CLIENT_VERSION = '0.3.0'
const CHANNEL = 'codex-app'

type CodexWorkspaceProvider = WorkspaceProvider & {
  deleteBranch?(branch: string, repo: string): Promise<void>
}

export interface CodexAppRuntimeOptions {
  id?: string
  command?: string
  model?: string
  modelProvider?: string
  /** 默认 full：danger-full-access + approvalPolicy never。 */
  permissions?: 'workspace' | 'full'
  /** 默认 never；改成 on-request/untrusted 时才逐条审批。 */
  approvalPolicy?: 'never' | 'on-request' | 'untrusted'
  network?: boolean
  args?: string[]
  /** 测试注入：spawn 时在 `app-server` 之前附加的参数（例如 fake server 脚本路径）。 */
  prependArgs?: string[]
  /** ~/.router-agent/workers */
  workersDir: string
  /** ~/.router-agent */
  home: string
  git: CommandRunner
  env?: NodeJS.ProcessEnv
  logger?: Logger
  worktreesRoot?: string
  initializeTimeoutMs?: number
  /** 测试注入：替换 GitWorktreeProvider。 */
  workspaceProvider?: CodexWorkspaceProvider
  /** 测试注入：替换二进制探测。 */
  detectBinary?: (opts: {
    home: string
    env: NodeJS.ProcessEnv
    command?: string
    commandOptions?: CodexAppOptions
  }) => Promise<CodexBinaryDetection>
}

interface CodexMeta {
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
  status?: string
  startedAt?: string
  lastError?: string
  lastHandedOffInputId?: string
  lastHandedOffAttempt?: number
  tools?: ToolPolicy
  sandboxMode?: string
  approvalPolicy?: string
  binaryPath?: string
  binarySource?: string
  binaryVersion?: string
}

interface CodexSession {
  ticketId: string
  threadId: string
  workdir: string
  branch: string
  tools: ToolPolicy
  client: CodexAppClient
  sandboxMode: string
  approvalPolicy: string
  inFlight: boolean
  activeTurnId?: string
  waitingApproval: boolean
  lastEventAt?: string
  lastError?: string
  lastTurnStatus?: string
  lastPromptStartedAt?: string
  assistantText: string
  /** 已通过 delta 记录过的 agentMessage item，避免 completed 时重复写活动。 */
  streamedItems: Set<string>
}

const READ_ONLY_TOOLS: ToolPolicy = { fileAccess: 'read-only', shell: 'deny', allowNetwork: false }

/**
 * Codex App Server 运行时。
 *
 * 直连 `codex app-server`（JSON-RPC over stdio），用 thread/turn 原语承载工单：
 * - thread/start + turn/start 首轮；
 * - thread/resume 重启后恢复；
 * - turn/steer 执行中追加输入，turn/interrupt 停止；
 * - 原生 command/file/permission 审批请求按 worker.tools 决策。
 *
 * 二进制发现顺序：显式配置 > 环境变量 > Codex App bundle > PATH。
 * 默认 sandbox=danger-full-access、approvalPolicy=never，不产生审批请求。
 */
export class CodexAppRuntime implements WorkerRuntime {
  readonly id: string
  readonly capabilities: RuntimeCapabilities = {
    agent: { liveStatus: true, processExit: true, output: false, activity: true, structuredInput: true, nudge: false },
    workspace: { cleanup: true, prLink: false, discovery: false },
  }

  private readonly opts: CodexAppOptions
  private readonly workersDir: string
  private readonly home: string
  private readonly env: NodeJS.ProcessEnv
  private readonly logger: Logger
  private readonly initializeTimeoutMs: number
  private readonly args: string[]
  private readonly prependArgs: string[]
  private readonly gitProvider: GitWorktreeProvider
  private readonly workspaces: CodexWorkspaceProvider
  private readonly sessions = new Map<string, CodexSession>()
  private readonly byThreadId = new Map<string, CodexSession>()
  private readonly detectBinary: NonNullable<CodexAppRuntimeOptions['detectBinary']>

  constructor(opts: CodexAppRuntimeOptions) {
    this.id = opts.id ?? 'codex-app'
    const permission = opts.permissions ?? 'full'
    const approval = opts.approvalPolicy ?? 'never'
    this.opts = {
      ...(opts.command ? { command: opts.command } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.modelProvider ? { modelProvider: opts.modelProvider } : {}),
      permissions: permission,
      approvalPolicy: approval,
      network: opts.network ?? true,
      args: opts.args ?? [],
      env: opts.env ?? {},
    }
    this.workersDir = opts.workersDir
    this.home = opts.home
    // Codex 桌面端固定读写 ~/.codex；这里用同一个 HOME，避免服务从别的 CODEX_HOME 启动时
    // thread 落在别处，桌面端侧边栏看不到。显式 env 优先于这个默认值。
    this.env = { CODEX_HOME: join(homedir(), '.codex'), ...this.opts.env }
    this.logger = opts.logger ?? noopLogger
    this.initializeTimeoutMs = opts.initializeTimeoutMs ?? 30_000
    this.args = this.opts.args
    this.prependArgs = opts.prependArgs ?? []
    this.gitProvider = new GitWorktreeProvider({
      git: opts.git,
      worktreesRoot: opts.worktreesRoot ?? join(opts.home, 'worktrees'),
    })
    this.workspaces = opts.workspaceProvider ?? this.gitProvider
    this.detectBinary = opts.detectBinary ?? (async input => detectCodexBinary({
      home: input.home,
      env: input.env,
      ...(input.command ? { command: input.command } : {}),
      ...(input.commandOptions ? { options: input.commandOptions } : {}),
    }))
  }

  async start(ctx: WorkerContext): Promise<StartResult> {
    const ticket = ctx.ticket
    const repo = ticket.repo
    const baseBranch = ticket.branch
    if (!repo) throw new WorkerRuntimeError('workspace:missing-repo', '工单没有指定仓库，拒绝创建 worktree')
    if (!baseBranch) throw new WorkerRuntimeError('workspace:missing-branch', '工单没有指定起始分支，拒绝创建 worktree')

    const detection = await this.resolveBinary()
    if (!detection.command || !detection.compatible) {
      throw new WorkerRuntimeError(
        'runtime:unavailable',
        detection.reason ?? 'Codex App Server 不可用',
        {
          retryable: false,
          detail: {
            runtimeId: this.id,
            source: detection.source,
            command: detection.command,
            hint: detection.installHint,
            installUrl: detection.installUrl,
          },
        },
      )
    }

    const tools = ctx.tools ?? READ_ONLY_TOOLS
    const sandboxMode = this.sandboxModeOf(tools)
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

    const meta: CodexMeta = {
      schemaVersion: 1,
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
      tools,
      sandboxMode,
      approvalPolicy: this.opts.approvalPolicy,
      binaryPath: detection.command,
      binarySource: detection.source,
      ...(detection.version ? { binaryVersion: detection.version } : {}),
    }
    this.writeMeta(ticket.id, meta)

    this.logger.info('codex:binary-resolved', {
      ticketId: ticket.id,
      source: detection.source,
      path: detection.command,
      version: detection.version,
    })
    if (sandboxMode === 'danger-full-access') {
      this.logger.warn('codex:full-access', {
        ticketId: ticket.id,
        approvalPolicy: this.opts.approvalPolicy,
        sandboxMode,
      })
    }

    let client: CodexAppClient | undefined
    try {
      client = this.spawnClient(ticket.id, workspace.workdir, detection, sandboxMode)
      await this.initialize(client)
      const thread = await this.startThread(client, ticket.id, ticket.title, workspace.workdir, contract, sandboxMode)
      const session = this.registerSession({
        ticketId: ticket.id,
        threadId: thread,
        workdir: workspace.workdir,
        branch: workspace.branch,
        tools,
        client,
        sandboxMode,
        approvalPolicy: this.opts.approvalPolicy,
      })
      meta.handle = thread
      meta.sessionId = thread
      if (client.pid !== undefined) meta.pid = client.pid
      meta.status = 'running'
      this.writeMeta(ticket.id, meta)

      await this.startTurn(session, `${contract}\n\n完成后用 ra report 上报。`, [])
      return {
        handle: thread,
        workdir: workspace.workdir,
        branch: workspace.branch,
        sessionId: thread,
        workspaceRef: workspace.workspaceRef,
      }
    } catch (error) {
      await client?.close().catch(() => {})
      await this.rollback(workspace.workdir, workspace.branch, repo)
      throw this.launchError(error, workspace.workdir, workspace.branch)
    }
  }

  async deliver(ref: WorkerRef, inputs: InboundMessage[], opts: DeliverOptions = {}): Promise<DeliveryReceipt> {
    const inputIds = inputs.map(input => input.id)
    if (inputs.length === 0) return { status: 'accepted', inputIds }

    let meta = this.readMeta(ref.ticketId)
    let session = this.sessions.get(ref.ticketId)
    if (session && !session.client.alive) {
      this.dropSession(session)
      session = undefined
    }
    if (!session) {
      const revived = await this.revive(meta)
      if (!revived) {
        return { status: 'rejected', inputIds, reason: 'codex-app:agent-gone', retryable: true, retryAfterMs: 30_000 }
      }
      session = revived
      meta = this.readMeta(ref.ticketId) ?? meta
    }

    const dedupe = opts.redeliver !== true
      && meta?.lastHandedOffInputId === inputs.at(-1)?.id
      && meta?.lastHandedOffAttempt === (opts.attempt ?? 1)
    if (dedupe) return { status: 'accepted', inputIds }

    const text = `${inputs.map(input => `【Router 输入 ${input.id}】\n${input.text}`).join('\n\n')}\n\n继续执行工单，完成后用 ra report 上报。`
    if (session.inFlight) {
      if (session.activeTurnId) {
        try {
          await session.client.request('turn/steer', {
            threadId: session.threadId,
            expectedTurnId: session.activeTurnId,
            input: [{ type: 'text', text }],
          }, this.initializeTimeoutMs)
          this.rememberDelivered(ref.ticketId, meta, inputs.at(-1)?.id, opts.attempt ?? 1)
          this.logger.info('codex:turn-steered', {
            ticketId: ref.ticketId,
            threadId: session.threadId,
            turnId: session.activeTurnId,
            inputId: inputs.at(-1)?.id,
          })
          return { status: 'accepted', inputIds }
        } catch (error) {
          this.logger.warn('codex:steer-failed', {
            ticketId: ref.ticketId,
            threadId: session.threadId,
            reason: errorMessage(error),
          })
          return { status: 'queued', inputIds, reason: 'codex-app:busy' }
        }
      }
      return { status: 'queued', inputIds, reason: 'codex-app:busy' }
    }

    try {
      await this.startTurn(session, text, inputs)
      this.rememberDelivered(ref.ticketId, meta, inputs.at(-1)?.id, opts.attempt ?? 1)
      return { status: 'accepted', inputIds }
    } catch (error) {
      return {
        status: 'rejected',
        inputIds,
        reason: error instanceof WorkerRuntimeError ? error.reason : 'codex-app:deliver-failed',
        retryable: true,
        retryAfterMs: 30_000,
      }
    }
  }

  async stop(ref: WorkerRef, _reason: string): Promise<void> {
    const session = this.sessions.get(ref.ticketId)
    if (session) {
      if (session.activeTurnId) {
        await session.client.request('turn/interrupt', {
          threadId: session.threadId,
          turnId: session.activeTurnId,
        }, 5_000).catch(() => {})
      }
      this.dropSession(session)
      await session.client.close().catch(() => {})
    }
    const meta = this.readMeta(ref.ticketId)
    if (meta) {
      meta.status = 'stopped'
      this.writeMeta(ref.ticketId, meta)
    }
  }

  /** 重启对账用：用 thread/resume 接回已有 Codex thread。 */
  async reattach(ref: WorkerRef): Promise<boolean> {
    const session = this.sessions.get(ref.ticketId)
    if (session?.client.alive) return true
    if (session) this.dropSession(session)
    return (await this.revive(this.readMeta(ref.ticketId))) !== null
  }

  async status(ref: WorkerRef): Promise<AgentStatus | null> {
    const session = this.sessions.get(ref.ticketId)
    const meta = this.readMeta(ref.ticketId)
    if (!session) {
      if (!meta) return null
      const lastActivityAt = this.lastEventAtFromFile(ref.ticketId) ?? meta.startedAt
      return {
        alive: false,
        phase: 'exited',
        acceptingInput: Boolean(meta.sessionId),
        ...(lastActivityAt ? { lastActivityAt } : {}),
        detail: {
          source: this.id,
          status: meta.status ?? 'exited',
          ...(meta.sessionId ? { threadId: meta.sessionId } : {}),
          ...(meta.sandboxMode ? { sandboxMode: meta.sandboxMode } : {}),
        },
      }
    }

    const lastActivityAt = latestActivityAt(session.lastEventAt, session.lastPromptStartedAt) ?? meta?.startedAt
    if (!session.client.alive) {
      return {
        alive: false,
        phase: 'exited',
        acceptingInput: true,
        ...(lastActivityAt ? { lastActivityAt } : {}),
        ...(session.client.exit.code !== null ? { exitCode: session.client.exit.code } : {}),
        ...(session.client.exit.signal ? { exitSignal: session.client.exit.signal } : {}),
        detail: { source: this.id, status: 'exited', threadId: session.threadId },
      }
    }
    if (session.waitingApproval) {
      return {
        alive: true,
        phase: 'blocked',
        acceptingInput: false,
        ...(lastActivityAt ? { lastActivityAt } : {}),
        detail: { source: this.id, status: 'waiting-approval', threadId: session.threadId },
      }
    }
    if (session.inFlight) {
      return {
        alive: true,
        phase: 'running',
        acceptingInput: false,
        ...(lastActivityAt ? { lastActivityAt } : {}),
        detail: {
          source: this.id,
          status: 'working',
          threadId: session.threadId,
          ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
        },
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
        threadId: session.threadId,
        ...(session.lastError ? { error: session.lastError } : {}),
        ...(session.lastTurnStatus ? { lastTurnStatus: session.lastTurnStatus } : {}),
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
    const sessionId = query.ref.sessionId ?? session?.threadId ?? meta?.sessionId
    const at = tail.at(-1)?.at ?? session?.lastEventAt ?? meta?.startedAt ?? new Date().toISOString()
    return { at, events: tail, ...(sessionId ? { sessionId } : {}) }
  }

  async inspectWorkspace(ref: WorkspaceRef): Promise<WorkspaceInfo | null> {
    return this.workspaces.inspect(ref.workdir)
  }

  async removeWorkspace(ref: WorkspaceRef): Promise<void> {
    await this.workspaces.remove(ref.workdir)
  }

  async repoSlug(ref: WorkerRef): Promise<string | null> {
    if (!ref.workdir) return null
    return this.gitProvider.remoteRepo(ref.workdir)
  }

  async doctor(): Promise<DiagnosticCheck[]> {
    const checks: DiagnosticCheck[] = []
    const detection = await this.resolveBinary()
    if (!detection.command || !detection.compatible) {
      checks.push({
        name: 'Codex App / CLI',
        status: 'fail',
        detail: detection.reason ?? '未找到可用的 Codex',
        hint: `${detection.installHint}${detection.installUrl ? `（${detection.installUrl}）` : ''}`,
      })
    } else {
      checks.push({
        name: 'Codex App / CLI',
        status: 'ok',
        detail: `${detection.command}${detection.version ? ` · ${detection.version}` : ''}（${detection.source}）`,
      })
      const login = await this.probeLogin(detection.command)
      checks.push({
        name: 'Codex 登录',
        status: login ? 'ok' : 'warn',
        detail: login ? 'codex login status 通过' : '未检测到登录态',
        ...(login ? {} : { hint: '先运行 codex login（或 codex-acp login）完成登录' }),
      })
      const appServer = await this.probeAppServer(detection.command)
      checks.push({
        name: 'Codex app-server',
        status: appServer ? 'ok' : 'fail',
        detail: appServer ? 'app-server --help 可用' : 'app-server 子命令不可用',
        ...(appServer ? {} : { hint: '升级 Codex / Codex App 到包含 app-server 的版本' }),
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

  private async resolveBinary(): Promise<CodexBinaryDetection> {
    return this.detectBinary({
      home: this.home,
      env: { ...process.env, ...this.env },
      ...(this.opts.command ? { command: this.opts.command } : {}),
      commandOptions: this.opts,
    })
  }

  private spawnClient(ticketId: string, workdir: string, detection: CodexBinaryDetection, sandboxMode: string): CodexAppClient {
    if (!detection.command) {
      throw new WorkerRuntimeError('runtime:unavailable', detection.reason ?? 'Codex 不可用', {
        detail: { runtimeId: this.id, hint: detection.installHint },
      })
    }
    const args = [...this.prependArgs, ...this.serverArgs(ticketId, workdir, sandboxMode)]
    this.logger.info('codex:codex-home', {
      ticketId,
      codexHome: this.env.CODEX_HOME ?? '',
    })
    return new CodexAppClient({
      command: detection.command,
      args,
      cwd: workdir,
      env: { ...process.env, ...this.env },
      onNotification: (method, params) => this.onNotification(ticketId, method, params),
      onRequest: (method, params) => this.onRequest(ticketId, method, params),
      onExit: (code, signal, stderr) => this.onExit(ticketId, code, signal, stderr),
    })
  }

  /** `codex -c ... app-server --stdio`；`-c` 覆盖只作用于本次工单进程。 */
  private serverArgs(ticketId: string, workdir: string, sandboxMode: string): string[] {
    const args = [...this.args]
    const set = (key: string, value: string): void => {
      args.push('-c', `${key}=${value}`)
    }
    set('sandbox_mode', tomlString(sandboxMode))
    set('approval_policy', tomlString(this.opts.approvalPolicy))
    if (sandboxMode === 'workspace-write') {
      set('sandbox_workspace_write.network_access', this.opts.network ? 'true' : 'false')
      const roots = [workdir, join(this.workersDir, ticketId)]
      set('sandbox_workspace_write.writable_roots', `[${roots.map(tomlString).join(', ')}]`)
    }
    if (this.opts.model) set('model', tomlString(this.opts.model))
    if (this.opts.modelProvider) set('model_provider', tomlString(this.opts.modelProvider))
    args.push('app-server', '--stdio')
    return args
  }

  private async initialize(client: CodexAppClient): Promise<{ userAgent?: string }> {
    const result = await client.request<{ userAgent?: string }>('initialize', {
      clientInfo: { name: CLIENT_NAME, title: 'Router Agent', version: CLIENT_VERSION },
      capabilities: { experimentalApi: true },
    }, this.initializeTimeoutMs)
    client.notify('initialized')
    return result
  }

  private async startThread(
    client: CodexAppClient,
    ticketId: string,
    title: string,
    workdir: string,
    contract: string,
    sandboxMode: string,
  ): Promise<string> {
    const response = await client.request<{ thread?: { id?: string } }>('thread/start', {
      cwd: workdir,
      sandbox: sandboxMode,
      approvalPolicy: this.opts.approvalPolicy,
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(this.opts.modelProvider ? { modelProvider: this.opts.modelProvider } : {}),
      developerInstructions: [
        '你是 router-agent 派出的 Worker。',
        '所有状态通过 `ra report` 上报；不要直接给飞书发消息，不要自己联系发起人。',
        '工单正文见本轮用户输入；完成后必须用 ra report 上报。',
      ].join('\n'),
    }, this.initializeTimeoutMs)
    const threadId = response?.thread?.id
    if (!threadId) {
      throw new WorkerRuntimeError('agent:launch-failed', 'Codex thread/start 没有返回 thread id', {
        detail: { ticketId, workdir },
      })
    }
    this.logger.info('codex:thread-started', {
      ticketId,
      threadId,
      cwd: workdir,
      sandboxMode,
      approvalPolicy: this.opts.approvalPolicy,
      contract: preview(contract, 80),
    })
    // 让 Codex 桌面端的 thread 列表显示工单号/标题，而不是默认摘要。
    await client.request('thread/name/set', {
      threadId,
      name: `${ticketId} ${title}`.trim(),
    }, this.initializeTimeoutMs).catch(error => {
      this.logger.warn('codex:thread-name-failed', { ticketId, threadId, reason: errorMessage(error) })
    })
    return threadId
  }

  private async startTurn(session: CodexSession, text: string, inputs: InboundMessage[]): Promise<string | undefined> {
    if (session.inFlight) {
      throw new WorkerRuntimeError('agent:not-accepting-input', 'Codex 会话仍在执行上一轮')
    }
    session.inFlight = true
    session.lastPromptStartedAt = new Date().toISOString()
    session.lastError = undefined
    session.assistantText = ''
    session.streamedItems.clear()
    try {
      const response = await session.client.request<{ turn?: { id?: string } }>('turn/start', {
        threadId: session.threadId,
        input: [{ type: 'text', text }],
      }, this.initializeTimeoutMs)
      const turnId = response?.turn?.id
      // turn 可能在响应前就已结束（极快 turn）；只在仍处于 inFlight 时记录活动 turn。
      if (session.inFlight) session.activeTurnId = turnId
      this.logger.info('codex:turn-started', {
        ticketId: session.ticketId,
        threadId: session.threadId,
        ...(turnId ? { turnId } : {}),
        inputIds: inputs.map(input => input.id),
        preview: preview(text, 100),
      })
      return turnId
    } catch (error) {
      session.inFlight = false
      session.activeTurnId = undefined
      session.lastError = errorMessage(error)
      this.logger.error('codex:turn-start-failed', {
        ticketId: session.ticketId,
        threadId: session.threadId,
        reason: session.lastError,
      })
      throw error
    }
  }

  private registerSession(input: Omit<CodexSession, 'inFlight' | 'waitingApproval' | 'assistantText' | 'streamedItems'>): CodexSession {
    const session: CodexSession = {
      ...input,
      inFlight: false,
      waitingApproval: false,
      assistantText: '',
      streamedItems: new Set(),
    }
    this.sessions.set(session.ticketId, session)
    this.byThreadId.set(session.threadId, session)
    return session
  }

  private dropSession(session: CodexSession): void {
    this.sessions.delete(session.ticketId)
    this.byThreadId.delete(session.threadId)
  }

  private onNotification(ticketId: string, method: string, params: unknown): void {
    const session = this.sessions.get(ticketId)
    if (!session) return
    const at = new Date().toISOString()
    session.lastEventAt = at
    const record = params && typeof params === 'object' ? params as Record<string, unknown> : {}

    switch (method) {
      case 'thread/status/changed': {
        const status = record.status && typeof record.status === 'object' ? record.status as Record<string, unknown> : {}
        const flags = Array.isArray(status.activeFlags) ? status.activeFlags : []
        session.waitingApproval = flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')
        if (status.type === 'idle') {
          session.inFlight = false
          session.activeTurnId = undefined
        }
        if (status.type === 'systemError') session.lastError = 'Codex thread 进入 systemError'
        return
      }
      case 'turn/started': {
        const turn = record.turn && typeof record.turn === 'object' ? record.turn as Record<string, unknown> : {}
        session.inFlight = true
        if (typeof turn.id === 'string') session.activeTurnId = turn.id
        return
      }
      case 'turn/completed': {
        const turn = record.turn && typeof record.turn === 'object' ? record.turn as Record<string, unknown> : {}
        session.inFlight = false
        session.activeTurnId = undefined
        session.waitingApproval = false
        session.lastTurnStatus = typeof turn.status === 'string' ? turn.status : 'unknown'
        if (session.lastTurnStatus === 'failed') {
          const error = turn.error && typeof turn.error === 'object' ? turn.error as Record<string, unknown> : {}
          session.lastError = typeof error.message === 'string' ? error.message : 'Codex turn failed'
          this.logger.error('codex:turn-failed', {
            ticketId: session.ticketId,
            threadId: session.threadId,
            turnId: typeof turn.id === 'string' ? turn.id : undefined,
            reason: session.lastError,
          })
        } else {
          session.lastError = undefined
          this.logger.info('codex:turn-completed', {
            ticketId: session.ticketId,
            threadId: session.threadId,
            turnId: typeof turn.id === 'string' ? turn.id : undefined,
            status: session.lastTurnStatus,
            durationMs: typeof turn.durationMs === 'number' ? turn.durationMs : undefined,
          })
        }
        this.writeMetaStatus(session.ticketId, {
          status: session.lastTurnStatus === 'failed' ? 'error' : 'running',
          lastError: session.lastError,
        })
        return
      }
      case 'item/completed': {
        const item = record.item && typeof record.item === 'object' ? record.item as Record<string, unknown> : {}
        this.recordItem(session, item, at)
        return
      }
      case 'item/agentMessage/delta': {
        const delta = typeof record.delta === 'string' ? record.delta : ''
        if (!delta) return
        session.assistantText = `${session.assistantText}${delta}`.slice(-4_000)
        if (typeof record.itemId === 'string') session.streamedItems.add(record.itemId)
        this.recordEvent(session, { at, kind: 'text', text: delta.slice(-2_000) })
        return
      }
      case 'error': {
        const error = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : {}
        const message = typeof error.message === 'string' ? error.message : 'Codex 返回错误'
        session.lastError = message
        this.logger.warn('codex:error', { ticketId: session.ticketId, threadId: session.threadId, reason: message })
        return
      }
      case 'serverRequest/resolved':
        session.waitingApproval = false
        return
      default:
        return
    }
  }

  private recordItem(session: CodexSession, item: Record<string, unknown>, at: string): void {
    const type = typeof item.type === 'string' ? item.type : ''
    if (type === 'agentMessage') {
      const itemId = typeof item.id === 'string' ? item.id : ''
      // 已经流过 delta 的消息不重复写整段；关闭 streaming 时用 completed 的完整文本兜底。
      if (itemId && session.streamedItems.has(itemId)) {
        session.streamedItems.delete(itemId)
        return
      }
      const text = typeof item.text === 'string' ? item.text : session.assistantText
      if (text) this.recordEvent(session, { at, kind: 'text', text: text.slice(-8_000) })
      return
    }
    const tool = toolItemOf(item)
    if (tool) this.recordEvent(session, { at, kind: 'tool', text: tool.text, tool: { name: tool.name, ...(tool.target ? { target: tool.target } : {}) } })
  }

  private async onRequest(ticketId: string, method: string, params: unknown): Promise<unknown> {
    const session = this.sessions.get(ticketId)
    if (!session) throw new CodexProtocolError(-32602, '未知的 Codex thread')
    const record = params && typeof params === 'object' ? params as Record<string, unknown> : {}

    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'execCommandApproval': {
        const command = typeof record.command === 'string' ? record.command : null
        const decision = this.decideCommand(session, command)
        session.waitingApproval = false
        this.logger.info('codex:approval', {
          ticketId,
          threadId: session.threadId,
          kind: 'command',
          decision,
          command: preview(command ?? '', 120),
        })
        return { decision }
      }
      case 'item/fileChange/requestApproval':
      case 'applyPatchApproval': {
        const decision = session.tools.fileAccess === 'read-write' ? 'accept' : 'decline'
        session.waitingApproval = false
        this.logger.info('codex:approval', {
          ticketId,
          threadId: session.threadId,
          kind: 'fileChange',
          decision,
        })
        return { decision }
      }
      case 'item/permissions/requestApproval': {
        session.waitingApproval = false
        this.logger.info('codex:approval', {
          ticketId,
          threadId: session.threadId,
          kind: 'permissions',
          decision: 'decline',
        })
        return { permissions: {} }
      }
      case 'item/tool/requestUserInput':
        session.waitingApproval = false
        return { answers: {} }
      case 'mcpServer/elicitation/request':
        session.waitingApproval = false
        return { action: 'decline' }
      case 'account/chatgptAuthTokens/refresh':
        throw new CodexProtocolError(-32601, 'router-agent 不支持托管 ChatGPT token 刷新')
      default:
        throw new CodexProtocolError(-32601, `router-agent 不支持 Codex server request: ${method}`)
    }
  }

  private decideCommand(session: CodexSession, command: string | null): 'accept' | 'decline' | 'cancel' {
    if (session.approvalPolicy === 'never') return 'accept'
    return shellAllowed(session.tools, command) ? 'accept' : 'decline'
  }

  private onExit(ticketId: string, code: number | null, signal: NodeJS.Signals | null, stderr: string): void {
    const session = this.sessions.get(ticketId)
    if (!session) return
    session.inFlight = false
    session.activeTurnId = undefined
    session.lastError = `Codex app-server 退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）${stderr ? `: ${stderr.slice(-300)}` : ''}`
    this.logger.warn('codex:process-exit', {
      ticketId,
      threadId: session.threadId,
      code,
      signal,
      reason: preview(stderr, 200),
    })
    this.writeMetaStatus(ticketId, { status: 'exited', lastError: session.lastError })
  }

  private async revive(meta: CodexMeta | null): Promise<CodexSession | null> {
    if (!meta?.sessionId || !meta.workdir) return null
    const detection = await this.resolveBinary().catch(() => null)
    if (!detection?.command || !detection.compatible) return null
    const sandboxMode = meta.sandboxMode ?? (this.opts.permissions === 'full' ? 'danger-full-access' : 'workspace-write')
    const client = this.spawnClient(meta.ticketId, meta.workdir, detection, sandboxMode)
    try {
      await this.initialize(client)
      await client.request('thread/resume', {
        threadId: meta.sessionId,
        cwd: meta.workdir,
        excludeTurns: true,
        sandbox: sandboxMode,
        approvalPolicy: this.opts.approvalPolicy,
        ...(this.opts.model ? { model: this.opts.model } : {}),
        ...(this.opts.modelProvider ? { modelProvider: this.opts.modelProvider } : {}),
      }, this.initializeTimeoutMs)
      const session = this.registerSession({
        ticketId: meta.ticketId,
        threadId: meta.sessionId,
        workdir: meta.workdir,
        branch: meta.workBranch,
        tools: meta.tools ?? READ_ONLY_TOOLS,
        client,
        sandboxMode,
        approvalPolicy: this.opts.approvalPolicy,
      })
      session.lastEventAt = new Date().toISOString()
      meta.status = 'running'
      if (client.pid !== undefined) meta.pid = client.pid
      this.writeMeta(meta.ticketId, meta)
      this.logger.info('codex:resumed', { ticketId: meta.ticketId, threadId: meta.sessionId })
      return session
    } catch (error) {
      await client.close().catch(() => {})
      this.logger.warn('codex:resume-failed', {
        ticketId: meta.ticketId,
        threadId: meta.sessionId,
        reason: errorMessage(error),
      })
      return null
    }
  }

  private sandboxModeOf(tools: ToolPolicy): 'read-only' | 'workspace-write' | 'danger-full-access' {
    if (tools.fileAccess === 'read-only') return 'read-only'
    return this.opts.permissions === 'full' ? 'danger-full-access' : 'workspace-write'
  }

  private recordEvent(session: CodexSession, event: SessionEvent): void {
    session.lastEventAt = event.at
    try {
      const dir = join(this.workersDir, session.ticketId)
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, `${CHANNEL}-events.jsonl`), `${JSON.stringify(event)}\n`, 'utf8')
    } catch {
      // 活动落盘失败不影响主流程。
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
          if (parsed && typeof parsed.at === 'string' && (parsed.kind === 'text' || parsed.kind === 'tool')) events.push(parsed)
        } catch {
          // 跳过损坏行。
        }
      }
      return events
    } catch {
      return []
    }
  }

  private lastEventAtFromFile(ticketId: string): string | undefined {
    try {
      return statSync(join(this.workersDir, ticketId, `${CHANNEL}-events.jsonl`)).mtime.toISOString()
    } catch {
      return undefined
    }
  }

  private async rollback(workdir: string, branch: string, repo: string): Promise<void> {
    await this.workspaces.remove(workdir).catch(() => {})
    if (this.workspaces.deleteBranch) await this.workspaces.deleteBranch(branch, repo).catch(() => {})
  }

  private async probeLogin(command: string): Promise<boolean> {
    try {
      const res = await realRunner(command).run(['login', 'status'], {
        cwd: this.home,
        env: { ...process.env, ...this.env },
        timeoutMs: 5_000,
      })
      return res.code === 0
    } catch {
      return false
    }
  }

  private async probeAppServer(command: string): Promise<boolean> {
    try {
      const res = await realRunner(command).run(['app-server', '--help'], {
        cwd: this.home,
        env: { ...process.env, ...this.env },
        timeoutMs: 5_000,
      })
      return res.code === 0
    } catch {
      return false
    }
  }

  private rememberDelivered(ticketId: string, meta: CodexMeta | null, inputId: string | undefined, attempt: number): void {
    if (!meta) return
    meta.lastHandedOffInputId = inputId
    meta.lastHandedOffAttempt = attempt
    meta.status = 'running'
    this.writeMeta(ticketId, meta)
  }

  private launchError(error: unknown, workdir: string, branch: string): WorkerRuntimeError {
    if (error instanceof WorkerRuntimeError) {
      return new WorkerRuntimeError(error.code, error.reason, {
        retryable: error.retryable,
        cause: error.cause,
        detail: { ...error.detail, workdir, branch, command: this.opts.command },
      })
    }
    const message = errorMessage(error)
    this.logger.error('codex:launch-failed', { workdir, branch, reason: message })
    return new WorkerRuntimeError('agent:launch-failed', `Codex App Server 启动失败: ${message}`, {
      cause: error instanceof Error ? error.stack : undefined,
      detail: { workdir, branch, command: this.opts.command },
    })
  }

  private metaPath(ticketId: string): string {
    return join(this.workersDir, ticketId, 'meta.json')
  }

  private readMeta(ticketId: string): CodexMeta | null {
    try {
      return JSON.parse(readFileSync(this.metaPath(ticketId), 'utf8')) as CodexMeta
    } catch {
      return null
    }
  }

  private writeMeta(ticketId: string, meta: CodexMeta): void {
    const path = this.metaPath(ticketId)
    mkdirSync(join(this.workersDir, ticketId), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  }

  private writeMetaStatus(ticketId: string, patch: Partial<CodexMeta>): void {
    const meta = this.readMeta(ticketId)
    if (!meta) return
    this.writeMeta(ticketId, { ...meta, ...patch })
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function toolItemOf(item: Record<string, unknown>): { name: string; text: string; target?: string } | null {
  const type = typeof item.type === 'string' ? item.type : ''
  switch (type) {
    case 'commandExecution': {
      const command = typeof item.command === 'string' ? item.command : ''
      return { name: 'commandExecution', text: command || 'commandExecution', ...(command ? { target: command } : {}) }
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      const paths = changes
        .map(change => change && typeof change === 'object' ? (change as Record<string, unknown>).path : undefined)
        .filter((path): path is string => typeof path === 'string')
      return { name: 'fileChange', text: paths.join(', ') || 'fileChange', ...(paths[0] ? { target: paths[0] } : {}) }
    }
    case 'mcpToolCall': {
      const server = typeof item.server === 'string' ? item.server : ''
      const tool = typeof item.tool === 'string' ? item.tool : ''
      const text = [server, tool].filter(Boolean).join('.') || 'mcpToolCall'
      return { name: text, text }
    }
    case 'dynamicToolCall': {
      const tool = typeof item.tool === 'string' ? item.tool : 'dynamicToolCall'
      return { name: tool, text: tool }
    }
    case 'webSearch': {
      const query = typeof item.query === 'string' ? item.query : ''
      return { name: 'webSearch', text: query || 'webSearch', ...(query ? { target: query } : {}) }
    }
    default:
      return null
  }
}