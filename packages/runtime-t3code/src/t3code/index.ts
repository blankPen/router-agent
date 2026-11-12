/**
 * T3 Code 运行时：用 T3 的线程承载工单。
 *
 * - 首轮：`t3 thread start <worktree> <契约正文> --json`，**立即返回**，
 *   Agent 在 T3 服务端继续跑（所以这里不阻塞 Router）；
 * - 状态：`t3 thread show <threadId> --json` 读线程状态与最近消息；
 * - 追问：`t3 thread send <threadId> <正文> --json`，线程忙时排队，不打断当前轮；
 * - 停止：T3 CLI 没有中止线程的命令，只能标记本地状态（正在跑的那轮会跑完）。
 *
 * worktree 归 ra 管（T3 只是「在某个目录里跑 Agent」），所以 T3 侧只需要把
 * worktree 目录登记成一个项目，线程的工作目录就是它。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { errorMessage, noopLogger, type Logger } from '@router-agent/infra/logger.js'
import type { CommandRunner } from '@router-agent/infra/process.js'
import { GitWorktreeProvider, workBranch, worktreeName } from '@router-agent/runtime'
import {
  WorkerRuntimeError,
  type ActivityQuery,
  type AgentOutput,
  type AgentStatus,
  type DeliverOptions,
  type DeliveryReceipt,
  type DiagnosticCheck,
  type InboundMessage,
  type RuntimeCapabilities,
  type SessionSnapshot,
  type StartResult,
  type WorkerContext,
  type WorkerRef,
  type WorkerRuntime,
  type WorkspaceInfo,
  type WorkspaceRef,
} from '@router-agent/runtime'
import {
  failureText,
  isServerDown,
  isThreadGone,
  parseThreadSend,
  parseThreadShow,
  parseThreadStart,
  projectAdd,
  projectRemove,
  threadSend,
  threadShow,
  threadStart,
  version,
  type T3Flags,
  type T3ThreadShowResult,
} from './commands.js'
import { ensureT3Server, probeT3Server, type T3ServerSpawner } from './server.js'

export interface T3CodeRuntimeOptions {
  /** 已绑定 t3 的 runner。 */
  t3: CommandRunner
  git: CommandRunner
  /** ~/.router-agent/workers */
  workersDir: string
  /** ~/.router-agent */
  home: string
  /** t3 可执行文件；默认 t3。 */
  command?: string
  /** T3 provider 实例 id，例如 codex / claude。 */
  provider?: string
  /** 模型；与 provider 一起传给 `t3 thread start`。 */
  model?: string
  /** T3 数据目录（等价 T3CODE_HOME）；为空用 T3 默认目录。 */
  baseDir?: string
  /** 自动拉起服务端时的端口；不传用 T3 默认端口。 */
  port?: number
  /** 自动拉起服务端时最多等多久（毫秒）；默认 20 秒。 */
  serverTimeoutMs?: number
  /** 是否在服务端缺席时自动拉起；默认 true。 */
  autoStartServer?: boolean
  /** 允许创建 worktree 的根目录；默认 <home>/worktrees。 */
  worktreesRoot?: string
  env?: NodeJS.ProcessEnv
  logger?: Logger
  /** 测试注入点：替换服务端拉起动作。 */
  spawnServer?: T3ServerSpawner
}

interface T3Meta {
  schemaVersion?: number
  ticketId: string
  assignmentId?: string
  runtime: string
  /** T3 线程 id；运行时用它做 handle。 */
  handle: string
  workdir: string
  repo: string
  branch: string
  workBranch: string
  status?: string
  startedAt?: string
  lastHandedOffInputId?: string
  lastHandedOffAttempt?: number
  projectId?: string
  provider?: string
  model?: string
}

/** T3 线程状态 → 中立的 AgentPhase。 */
export function phaseOfThread(status: string, pendingRequestCount: number): AgentStatus['phase'] {
  switch (status) {
    case 'preparing':
    case 'queued':
    case 'starting':
    case 'running':
      return 'running'
    case 'waiting':
      // 等人工回答：Agent 还活着，但挡住了。
      return pendingRequestCount > 0 ? 'blocked' : 'running'
    case 'completed':
    case 'idle':
    case 'interrupted':
    case 'cancelled':
    case 'failed':
    case 'rolled_back':
      return 'exited'
    default:
      return 'unknown'
  }
}

export class T3CodeRuntime implements WorkerRuntime {
  readonly id = 't3code'
  readonly capabilities: RuntimeCapabilities = {
    agent: { liveStatus: true, processExit: false, output: true, activity: true, structuredInput: true, nudge: false },
    workspace: { cleanup: true, prLink: false, discovery: false },
  }
  private t3: CommandRunner
  private gitProvider: GitWorktreeProvider
  private workersDir: string
  private home: string
  private bin: string
  private provider?: string
  private model?: string
  private baseDir?: string
  private port?: number
  private serverTimeoutMs?: number
  private autoStartServer: boolean
  private env: NodeJS.ProcessEnv
  private logger: Logger
  private spawnServer?: T3ServerSpawner

  constructor(opts: T3CodeRuntimeOptions) {
    this.t3 = opts.t3
    this.gitProvider = new GitWorktreeProvider({
      git: opts.git,
      worktreesRoot: opts.worktreesRoot ?? join(opts.home, 'worktrees'),
    })
    this.workersDir = opts.workersDir
    this.home = opts.home
    this.bin = opts.command ?? 't3'
    this.provider = opts.provider
    this.model = opts.model
    this.baseDir = opts.baseDir
    this.port = opts.port
    this.serverTimeoutMs = opts.serverTimeoutMs
    this.autoStartServer = opts.autoStartServer !== false
    this.env = buildEnv(opts.env)
    this.logger = opts.logger ?? noopLogger
    this.spawnServer = opts.spawnServer
  }

  async start(ctx: WorkerContext): Promise<StartResult> {
    const ticket = ctx.ticket
    const repo = ticket.repo
    const baseBranch = ticket.branch
    if (!repo) throw new WorkerRuntimeError('workspace:missing-repo', '工单没有指定仓库，拒绝创建 worktree')
    if (!baseBranch) throw new WorkerRuntimeError('workspace:missing-branch', '工单没有指定起始分支，拒绝创建 worktree')
    const name = worktreeName(ticket)
    const branch = workBranch(ticket)
    const workdir = ctx.workdir || join(this.home, 'worktrees', name)

    const workspace = await this.gitProvider.create({
      ticketId: ticket.id,
      repo,
      baseBranch,
      workBranch: branch,
      name,
      workdir,
    })
    const meta: T3Meta = {
      schemaVersion: 1,
      ticketId: ticket.id,
      assignmentId: ctx.assignment.id,
      runtime: this.id,
      handle: '',
      workdir: workspace.workdir,
      repo,
      branch: baseBranch,
      workBranch: workspace.branch,
      status: 'starting',
      startedAt: new Date().toISOString(),
      ...(this.provider ? { provider: this.provider } : {}),
      ...(this.model ? { model: this.model } : {}),
    }
    this.writeMeta(ticket.id, meta)

    try {
      await this.ensureServer()
      // T3 只认「已登记的项目」；把 worktree 目录登记进去，线程的工作目录就是它。
      await this.ensureProject(workspace.workdir, name)
      const message = this.startMessage(ctx, workspace.workdir)
      const res = await this.runT3(threadStart({
        project: workspace.workdir,
        message,
        title: ticket.title,
        ...(this.provider ? { provider: this.provider } : {}),
        ...(this.model ? { model: this.model } : {}),
        ...this.flags(),
      }), workspace.workdir)
      if (res.code !== 0) {
        throw new WorkerRuntimeError('agent:launch-failed', `t3 thread start 失败: ${failureText(res.stdout, res.stderr)}`, {
          cause: failureText(res.stdout, res.stderr),
          detail: { workdir: workspace.workdir },
        })
      }
      const started = parseThreadStart(res.stdout)
      if (!started) {
        throw new WorkerRuntimeError('agent:launch-failed', `t3 thread start 没有返回线程 id: ${res.stdout.slice(0, 200)}`)
      }
      meta.handle = started.threadId
      meta.projectId = started.projectId
      meta.status = 'running'
      this.writeMeta(ticket.id, meta)
      this.logger.info('t3code:thread-started', {
        ticketId: ticket.id,
        threadId: started.threadId,
        workdir: workspace.workdir,
        branch: workspace.branch,
      })
      return {
        handle: started.threadId,
        workdir: workspace.workdir,
        branch: workspace.branch,
        sessionId: started.threadId,
        workspaceRef: workspace.workspaceRef,
      }
    } catch (error) {
      // launch 半成功：回滚本次新建的 worktree/branch，避免重试撞名。
      await this.bestEffortRollback(workspace.workdir, workspace.branch, repo)
      await this.removeProject(workspace.workdir)
      if (error instanceof WorkerRuntimeError) {
        throw new WorkerRuntimeError(error.code, error.reason, {
          retryable: error.retryable,
          cause: error.cause,
          detail: { ...error.detail, workdir: workspace.workdir, branch: workspace.branch },
        })
      }
      throw new WorkerRuntimeError('agent:launch-failed', errorMessage(error), {
        cause: errorMessage(error),
        detail: { workdir: workspace.workdir, branch: workspace.branch },
      })
    }
  }

  async deliver(ref: WorkerRef, inputs: InboundMessage[], opts: DeliverOptions = {}): Promise<DeliveryReceipt> {
    const inputIds = inputs.map(input => input.id)
    if (inputs.length === 0) return { status: 'accepted', inputIds }
    const meta = this.readMeta(ref.ticketId)
    const threadId = meta?.handle || ref.handle
    if (!threadId) {
      return { status: 'rejected', inputIds, reason: 't3code:thread-id-missing', retryable: true, retryAfterMs: 30_000 }
    }
    // 同一批输入重投时按 input id 幂等：T3 会把每条消息当成新一轮。
    // Router 显式重投（redeliver）时必须放行，不能在这里吞掉。
    const lastId = inputs.at(-1)?.id
    if (opts.redeliver !== true && meta && meta.lastHandedOffInputId === lastId && meta.lastHandedOffAttempt === (opts.attempt ?? 1)) {
      return { status: 'accepted', inputIds }
    }
    const message = this.followUpMessage(inputs)
    const res = await this.runT3(threadSend({
      thread: threadId,
      message,
      ...this.flags(),
    }), meta?.workdir ?? ref.workdir)
    if (res.code !== 0) {
      const text = failureText(res.stdout, res.stderr)
      if (isServerDown(text)) {
        // 服务端没起：这一轮先排队，等下一轮再投。
        this.logger.warn('t3code:server-down', { ticketId: ref.ticketId, threadId, reason: text })
        return { status: 'queued', inputIds, reason: 't3code:server-down' }
      }
      if (isThreadGone(text)) {
        return { status: 'rejected', inputIds, reason: 't3code:thread-gone', retryable: false }
      }
      this.logger.warn('t3code:send-failed', { ticketId: ref.ticketId, threadId, reason: text })
      return { status: 'queued', inputIds, reason: `t3code:send-failed:${text.slice(0, 80)}` }
    }
    const sent = parseThreadSend(res.stdout)
    if (!sent) {
      return { status: 'queued', inputIds, reason: 't3code:send-unparsed' }
    }
    if (meta) {
      meta.lastHandedOffInputId = lastId
      meta.lastHandedOffAttempt = opts.attempt ?? 1
      meta.status = 'running'
      this.writeMeta(ref.ticketId, meta)
    }
    this.logger.info('t3code:input-delivered', {
      ticketId: ref.ticketId,
      threadId,
      delivery: sent.delivery ?? 'unknown',
    })
    return { status: 'accepted', inputIds }
  }

  async stop(ref: WorkerRef, reason: string): Promise<void> {
    const meta = this.readMeta(ref.ticketId)
    // T3 CLI 没有中止线程的命令；正在跑的那一轮会跑完，这里只登记本地状态。
    this.logger.warn('t3code:stop-no-cancel', {
      ticketId: ref.ticketId,
      threadId: meta?.handle ?? ref.handle,
      reason: reason.slice(0, 120),
    })
    if (meta) {
      meta.status = 'stopped'
      this.writeMeta(ref.ticketId, meta)
    }
  }

  async status(ref: WorkerRef): Promise<AgentStatus | null> {
    const meta = this.readMeta(ref.ticketId)
    const threadId = meta?.handle || ref.handle
    if (!threadId) return null
    const shown = await this.readThread(threadId, meta?.workdir ?? ref.workdir)
    if (shown === null) return null
    if (shown === 'gone') {
      return { alive: false, phase: 'lost', acceptingInput: false, detail: { source: this.id, threadId } }
    }
    const thread = shown.thread
    const phase = phaseOfThread(thread.status, thread.pendingRequestCount)
    return {
      alive: phase !== 'exited',
      phase,
      // 线程跑完也能继续收追问，所以退出的线程仍然接受输入；跑动中的线程算忙。
      acceptingInput: phase === 'blocked' || phase === 'exited',
      ...(thread.updatedAt ? { lastActivityAt: thread.updatedAt } : {}),
      detail: {
        source: this.id,
        threadId,
        status: thread.status,
        pendingRequestCount: thread.pendingRequestCount,
        provider: thread.providerInstanceId,
        model: thread.model,
      },
    }
  }

  async output(ref: WorkerRef, opts: { limit?: number } = {}): Promise<AgentOutput | null> {
    const meta = this.readMeta(ref.ticketId)
    const threadId = meta?.handle || ref.handle
    if (!threadId) return null
    const shown = await this.readThread(threadId, meta?.workdir ?? ref.workdir)
    if (!shown || shown === 'gone') return null
    const limit = opts.limit ?? 60
    const lines = shown.messages.map(message => `[${message.role}] ${message.text}`)
    const phase = phaseOfThread(shown.thread.status, shown.thread.pendingRequestCount)
    return {
      status: phase === 'running' || phase === 'blocked' ? 'running' : phase === 'exited' ? 'exited' : 'unknown',
      lines: lines.slice(-limit),
      source: 't3-thread',
    }
  }

  async activity(query: ActivityQuery): Promise<SessionSnapshot | null> {
    const meta = this.readMeta(query.ref.ticketId)
    const threadId = query.ref.sessionId ?? meta?.handle ?? query.ref.handle
    if (!threadId) return null
    const shown = await this.readThread(threadId, meta?.workdir ?? query.ref.workdir)
    if (!shown || shown === 'gone') return null
    const at = shown.thread.updatedAt || new Date().toISOString()
    return {
      at,
      sessionId: threadId,
      events: shown.messages.map(message => ({
        at,
        kind: 'text' as const,
        text: message.text,
      })),
    }
  }

  async inspectWorkspace(ref: WorkspaceRef): Promise<WorkspaceInfo | null> {
    return this.gitProvider.inspect(ref.workdir)
  }

  async removeWorkspace(ref: WorkspaceRef): Promise<void> {
    // 先把 T3 侧的项目删掉（连带线程），再回收 worktree；项目已经不在时按幂等处理。
    await this.removeProject(ref.workdir)
    await this.gitProvider.remove(ref.workdir, { repo: ref.repo })
  }

  /** 本地路径仓库的 PR 跟踪需要 owner/repo；从 origin 推导。 */
  async repoSlug(ref: WorkerRef): Promise<string | null> {
    if (!ref.workdir) return null
    return this.gitProvider.remoteRepo(ref.workdir)
  }

  async doctor(): Promise<DiagnosticCheck[]> {
    const checks: DiagnosticCheck[] = []
    const cli = await this.runT3(version(this.flags()))
    checks.push({
      name: 'T3 Code CLI',
      status: cli.code === 0 ? 'ok' : 'fail',
      detail: cli.code === 0 ? cli.stdout.trim() : failureText(cli.stdout, cli.stderr),
      ...(cli.code === 0 ? {} : { hint: '安装 T3 Code（npm i -g t3），并确认 t3 --version 可用' }),
    })
    const server = await probeT3Server(this.t3, this.flags())
    checks.push({
      name: 'T3 Code 服务端',
      status: server.running ? 'ok' : 'fail',
      detail: server.running ? '服务端在跑' : (server.reason ?? '未找到运行中的 T3 Code 服务端'),
      ...(server.running ? {} : { hint: '启动 T3 Code（t3 serve），或让 ra 在派工时自动拉起' }),
    })
    const git = await this.gitProvider.version()
    checks.push({
      name: 'git worktree',
      status: git === null ? 'fail' : 'ok',
      detail: git ?? 'git --version 不可用',
      ...(git === null ? { hint: '安装 git，并确认 git worktree 可用' } : {}),
    })
    return checks
  }

  /** 首轮消息：把中立契约正文直接发进线程，Agent 在 worktree 里读不到别的目录。 */
  private startMessage(ctx: WorkerContext, workdir: string): string {
    const contract = (ctx.brief?.contract ?? '').replace('(由运行时决定)', workdir)
    return [
      contract.trim(),
      '',
      `工作目录：${workdir}`,
      '这是 Router 派发的工单：请按上面的契约完成，并通过 `ra report` 上报结果。',
    ].join('\n')
  }

  /** 追问消息：带上 Router 的输入 id，方便 Agent 在回复里引用。 */
  private followUpMessage(inputs: InboundMessage[]): string {
    const body = inputs
      .map(input => `【Router 输入 ${input.id}】\n${input.text}`)
      .join('\n\n')
    return `${body}\n\n请继续处理工单，并通过 \`ra report\` 上报结果。`
  }

  private flags(): T3Flags {
    return this.baseDir ? { baseDir: this.baseDir } : {}
  }

  private runT3(argv: string[], cwd?: string) {
    return this.t3.run(argv, { ...(cwd ? { cwd } : {}), env: this.env })
  }

  /** 确保 T3 服务端在跑；缺席时按需拉起。 */
  private async ensureServer(): Promise<void> {
    const state = this.autoStartServer
      ? await ensureT3Server({
        runner: this.t3,
        bin: this.bin,
        ...(this.port ? { port: this.port } : {}),
        ...(this.serverTimeoutMs ? { timeoutMs: this.serverTimeoutMs } : {}),
        flags: this.flags(),
        ...(this.spawnServer ? { spawnFn: this.spawnServer } : {}),
      })
      : await probeT3Server(this.t3, this.flags())
    if (state.running) return
    this.logger.error('t3code:server-unavailable', { reason: state.reason ?? 'unknown' })
    throw new WorkerRuntimeError('runtime:unavailable', `T3 Code 服务端不可用: ${state.reason ?? '未知原因'}`, {
      cause: state.reason,
      retryable: true,
    })
  }

  /** 把 worktree 目录登记成 T3 项目；已经登记过就跳过。 */
  private async ensureProject(workdir: string, title: string): Promise<void> {
    const res = await this.runT3(projectAdd({ path: workdir, title, ...this.flags() }), workdir)
    if (res.code === 0) return
    const text = failureText(res.stdout, res.stderr)
    if (/already exists/i.test(text)) return
    throw new WorkerRuntimeError('agent:launch-failed', `t3 project add 失败: ${text}`, {
      cause: text,
      detail: { workdir },
    })
  }

  /** 清理 T3 侧的项目；失败只记日志，不挡 worktree 回收。 */
  private async removeProject(workdir: string): Promise<void> {
    try {
      const res = await this.runT3(projectRemove({ project: workdir, force: true, ...this.flags() }), workdir)
      if (res.code !== 0) {
        const text = failureText(res.stdout, res.stderr)
        if (!/no project|not found|already/i.test(text)) {
          this.logger.warn('t3code:project-remove-failed', { workdir, reason: text })
        }
      }
    } catch (error) {
      this.logger.warn('t3code:project-remove-failed', { workdir, reason: errorMessage(error) })
    }
  }

  /** 读线程；返回 null 表示读不到（服务端没起），'gone' 表示线程没了。 */
  private async readThread(threadId: string, cwd?: string): Promise<T3ThreadShowResult | 'gone' | null> {
    const res = await this.runT3(threadShow({ thread: threadId, messages: 20, ...this.flags() }), cwd)
    if (res.code === 0) {
      const shown = parseThreadShow(res.stdout)
      return shown ?? null
    }
    const text = failureText(res.stdout, res.stderr)
    if (isThreadGone(text)) return 'gone'
    if (isServerDown(text)) {
      this.logger.warn('t3code:server-down', { threadId, reason: text })
      return null
    }
    this.logger.warn('t3code:show-failed', { threadId, reason: text })
    return null
  }

  private async bestEffortRollback(workdir: string, branch: string, repo: string): Promise<void> {
    await this.gitProvider.remove(workdir, { repo, force: true }).catch(() => {})
    await this.gitProvider.deleteBranch(branch, repo).catch(() => {})
  }

  private metaPath(ticketId: string): string {
    return join(this.workersDir, ticketId, 'meta.json')
  }

  private readMeta(ticketId: string): T3Meta | null {
    try {
      return JSON.parse(readFileSync(this.metaPath(ticketId), 'utf8')) as T3Meta
    } catch {
      return null
    }
  }

  private writeMeta(ticketId: string, meta: T3Meta): void {
    const path = this.metaPath(ticketId)
    mkdirSync(join(this.workersDir, ticketId), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  }
}

function buildEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'RA_HOME', 'RA_PORT', 'T3CODE_HOME']
  const env: NodeJS.ProcessEnv = {}
  for (const key of keep) {
    const value = overrides?.[key] ?? process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}
