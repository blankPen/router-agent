/**
 * Herdr 运行时：用 Herdr 的终端 workspace 承载工单。
 *
 * 职责切得很窄 —— **检出归 ra 自己管**（GitWorktreeProvider），Herdr 只负责
 * 「在终端里把 Agent 跑起来」这件基础事：
 * - `workspace create` 在检出目录上开一个终端 workspace；
 * - `agent start` 在 workspace 的 pane 里拉起 Agent；
 * - `agent prompt` 投递工单契约与追问；
 * - `agent get` / `agent read` 读状态与输出；
 * - `pane close` / `workspace close` 关掉窗口。
 *
 * 为什么不走 Herdr 自带的 `herdr worktree create`：
 * 那条命令会把仓库登记进 Herdr 的全局仓库表；仓库目录一旦被删，之后**所有**
 * `herdr worktree *` 命令都会报
 * `worktree_list_failed: cannot change to '<path>'` —— 一颗老鼠屎坏一锅汤。
 * 检出与回收交给 git worktree，Herdr 侧就不会再被登记状态拖住。
 *
 * 另外两点与 Orca 不同：
 * 1. Herdr 的 Agent 状态是**从屏幕识别的**（idle / working / done / blocked / unknown），
 *    不是结构化会话记录；结构化活动仍从 Agent 自己的会话记录里读（见 activity()）。
 * 2. Herdr 需要一个**在跑的服务端**；没有服务端时所有命令都返回 `server_not_running`。
 *    服务端由 ensureHerdrServer() 在探测 / 派工时自动拉起。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type {
  ActivityQuery,
  AgentOutput,
  AgentStatus,
  DeliveryReceipt,
  DeliverOptions,
  DiagnosticCheck,
  InboundMessage,
  RuntimeCapabilities,
  SessionSnapshot,
  StartResult,
  WorkerContext,
  WorkerRef,
  WorkerRuntime,
  WorkspaceInfo,
  WorkspaceRef,
} from '@router-agent/runtime'
import { WorkerRuntimeError } from '@router-agent/runtime'
import { buildWorkerPrompt } from '@router-agent/runtime'
import { workBranch, worktreeName } from '@router-agent/runtime'
import { resolveSession } from '@router-agent/runtime'
import { GitWorktreeProvider } from '@router-agent/runtime'
import { runtimeOptionDefault } from '@router-agent/runtime'
import { HERDR_RUNTIME_ID } from '@router-agent/runtime'
import { noopLogger, type Logger } from '@router-agent/infra/logger.js'
import { herdrAgentKindOf, type HerdrAgentKind } from './agents.js'
import { ensureHerdrServer, type HerdrServerSpawner } from './server.js'
import {
  agentGet,
  agentPrompt,
  agentRead,
  agentSendKeys,
  agentStart,
  paneClose,
  paneRead,
  version,
  workspaceClose,
  workspaceCreate,
  type CommandResult,
  type CommandRunner,
} from './commands.js'

export interface HerdrRuntimeOptions {
  herdr: CommandRunner
  /** git runner；用来创建 / 回收检出。 */
  git: CommandRunner
  /** ~/.router-agent/workers */
  workersDir: string
  /** 状态目录；传入后 Worker 规范优先读 `<home>/specs/worker/` 下的覆盖文件。 */
  home?: string
  /** 派工时启动哪个 Agent（Herdr 的 kind）；缺省用选项声明里的默认值。 */
  agent?: string
  /** 传给 Agent 的模型；缺省用 Agent 自己的配置。 */
  model?: string
  /** Claude Code 会话记录目录；默认 ~/.claude/projects，测试可注入临时目录。 */
  claudeProjectsDir?: string
  /** 允许创建检出的根目录；默认 <home>/worktrees。 */
  worktreesRoot?: string
  /** 拉起 Herdr 服务端用的动作；测试可注入空实现。 */
  spawnServer?: HerdrServerSpawner
  /** 结构化日志；缺省 noopLogger。 */
  logger?: Logger
}

interface HerdrMeta {
  schemaVersion?: number
  ticketId: string
  assignmentId: string
  runtime: string
  /** pane id（形如 w2:p1）：Herdr 里 Agent 的稳定目标，也是 stop 的句柄。 */
  handle: string
  /** Agent 在 Herdr 里的名字；只用于人类在侧栏辨认。 */
  agentName?: string
  paneId?: string
  workspaceId?: string
  workdir: string
  repo: string
  branch: string
  workBranch: string
  agent?: string
  status?: string
  startedAt?: string
}

/** Herdr 的错误体：`{"id":…,"error":{"code":…,"message":…}}`。 */
export interface HerdrCliError {
  code: string
  message: string
}

/** Herdr 的 Agent 名字长度上限；Herdr 要求匹配 `[a-z][a-z0-9_-]{0,31}`。 */
const AGENT_NAME_MAX = 32
/** 名字里项目名与分支名各自保留的长度。 */
const REPO_PART_MAX = 12
const BRANCH_PART_MAX = 10

/**
 * Claude Code 首次在新目录启动会弹「是否信任此文件夹」；跳过权限确认不会一并跳过它。
 * 命中就把弹窗当成「可以自动确认」处理。
 */
const TRUST_PROMPT_PATTERN = /trust this folder|quick safety check|是否信任|信任此文件夹/i

export class HerdrRuntime implements WorkerRuntime {
  readonly id = HERDR_RUNTIME_ID
  readonly capabilities: RuntimeCapabilities = {
    // Agent 活在 Herdr 的 pane 里，Router 重启不影响它 —— 与 orca / claude-code 一致。
    agent: { liveStatus: true, processExit: false, output: true, activity: true, structuredInput: true, nudge: false },
    // Herdr 不跟踪 PR，也没有仓库发现（项目按本地绝对路径登记）。
    workspace: { cleanup: true, prLink: false, discovery: false },
  }
  private herdr: CommandRunner
  private git: CommandRunner
  private workersDir: string
  private home?: string
  private agent: string
  private model?: string
  private claudeProjectsDir?: string
  private worktreesRoot: string
  private gitProvider: GitWorktreeProvider
  private spawnServer?: HerdrServerSpawner
  private logger: Logger

  constructor(opts: HerdrRuntimeOptions) {
    this.herdr = opts.herdr
    this.git = opts.git
    this.workersDir = opts.workersDir
    this.home = opts.home
    this.agent = String(opts.agent || runtimeOptionDefault(HERDR_RUNTIME_ID, 'agent') || '').trim()
    this.model = opts.model?.trim() || undefined
    this.claudeProjectsDir = opts.claudeProjectsDir
    this.worktreesRoot = opts.worktreesRoot ?? join(opts.home ?? opts.workersDir, 'worktrees')
    this.gitProvider = new GitWorktreeProvider({
      git: opts.git,
      worktreesRoot: this.worktreesRoot,
    })
    this.spawnServer = opts.spawnServer
    this.logger = opts.logger ?? noopLogger
  }

  async start(ctx: WorkerContext): Promise<StartResult> {
    const ticket = ctx.ticket
    const repo = ticket.repo
    const baseBranch = ticket.branch
    if (!repo) throw new WorkerRuntimeError('workspace:missing-repo', '工单没有指定仓库，拒绝创建 worktree')
    if (!baseBranch) throw new WorkerRuntimeError('workspace:missing-branch', '工单没有指定起始分支，拒绝创建 worktree')
    // Herdr 只认本地路径：不像 Orca 那样有 name:/id: 选择器。
    if (!repo.startsWith('/')) {
      throw new WorkerRuntimeError(
        'workspace:missing-repo',
        `herdr 运行时需要本地仓库绝对路径，收到: ${repo}（请在 runtime.projects.herdr 里登记本地路径）`,
      )
    }

    const statePath = ctx.report?.statePath ?? join(this.workersDir, ticket.id, 'state.json')
    const eventsPath = ctx.report?.eventsPath ?? join(this.workersDir, ticket.id, 'events.log')
    const branch = workBranch(ticket)
    const name = worktreeName(ticket)
    const workdir = ctx.workdir || join(this.worktreesRoot, name)
    const prompt = ctx.brief?.contract ?? buildWorkerPrompt({
      ticket,
      mandateScope: ticket.title,
      statePath,
      eventsPath,
      repo,
      branch: baseBranch,
      workBranch: branch,
      workdir: ctx.workdir,
      ...(this.home ? { home: this.home } : {}),
    })

    // Herdr 的每条命令都走本地 socket 服务端；服务端不在，后面每一步都会失败。
    await this.ensureServer()

    // 1) 检出归 ra 自己管：纯 git worktree，不碰 Herdr 的仓库登记。
    const workspace = await this.gitProvider.create({
      ticketId: ticket.id,
      repo,
      baseBranch,
      workBranch: branch,
      name,
      workdir,
    })

    // 2) Herdr 只做最基础的事：在检出目录上开一个终端窗口。
    let created: HerdrWorkspaceResult
    try {
      created = await this.createWorkspace(workspace.workdir, `ra-${ticket.id}`)
    } catch (error) {
      await this.gitProvider.remove(workspace.workdir).catch(() => {})
      throw error
    }
    const paneId = created.paneId
    if (!paneId) {
      await this.gitProvider.remove(workspace.workdir).catch(() => {})
      throw new WorkerRuntimeError('workspace:create-failed', 'herdr workspace create 没有返回 pane id')
    }

    const kind = this.agentKind()
    const agentName = agentNameFor({ kind: kind.value, repo, branch })
    const meta: HerdrMeta = {
      schemaVersion: 3,
      ticketId: ticket.id,
      assignmentId: ctx.assignment.id,
      runtime: this.id,
      handle: paneId,
      agentName,
      paneId,
      ...(created.workspaceId ? { workspaceId: created.workspaceId } : {}),
      workdir: workspace.workdir,
      repo,
      branch: baseBranch,
      workBranch: workspace.branch || branch,
      agent: kind.value,
      status: 'starting',
      startedAt: new Date().toISOString(),
    }
    this.writeMeta(ticket.id, meta)

    try {
      await this.startAgent(meta, kind)
      this.logger.info('herdr:agent-launched', {
        ticketId: ticket.id,
        paneId,
        agent: kind.value,
        ...(this.model ? { model: this.model } : {}),
      })
      // 契约作为首轮输入投进去；Herdr 的 agent prompt 会补上 Enter。
      await this.run(agentPrompt(paneId, withWorkdir(prompt, workspace.workdir)))
      return {
        handle: paneId,
        workdir: workspace.workdir,
        branch: meta.workBranch,
        ...(created.workspaceId ? { workspaceRef: created.workspaceId } : {}),
      }
    } catch (error) {
      await this.rollback(meta).catch(() => {})
      if (error instanceof WorkerRuntimeError) {
        throw new WorkerRuntimeError(error.code, error.reason, {
          retryable: error.retryable,
          cause: error.cause,
          detail: { ...error.detail, workdir: workspace.workdir, paneId },
        })
      }
      throw new WorkerRuntimeError('agent:launch-failed', error instanceof Error ? error.message : String(error), {
        cause: error instanceof Error ? error.stack : undefined,
        detail: { workdir: workspace.workdir, paneId },
      })
    }
  }

  async deliver(ref: WorkerRef, inputs: InboundMessage[], _opts?: DeliverOptions): Promise<DeliveryReceipt> {
    const accepted: string[] = []
    for (const input of inputs) {
      if (!input.text.trim()) continue
      let res = await this.herdr.run(agentPrompt(ref.handle, renderInput(input)))
      if (res.code !== 0) {
        const error = parseCliError(res)
        // Agent 正卡在确认弹窗上：Herdr 拒收输入。先看看是不是「信任此文件夹」，
        // 能自动确认就替用户点掉再投一次；否则让 Router 稍后重投。
        if (error?.code === 'agent_blocked' && await this.acceptTrustPrompt(ref.handle)) {
          res = await this.herdr.run(agentPrompt(ref.handle, renderInput(input)))
        }
        if (res.code !== 0) {
          const retryError = parseCliError(res)
          if (retryError?.code === 'agent_blocked') {
            return {
              status: 'rejected',
              inputIds: accepted,
              reason: 'herdr:agent-blocked',
              retryable: true,
              retryAfterMs: 30_000,
            }
          }
          if (retryError?.code === 'agent_not_found' || retryError?.code === 'agent_not_running') {
            return { status: 'rejected', inputIds: accepted, reason: `herdr:${retryError.code}`, retryable: false }
          }
          throw new WorkerRuntimeError('agent:not-accepting-input', `herdr agent prompt 失败: ${retryError?.message ?? res.stderr.trim()}`, {
            cause: retryError?.message ?? res.stderr,
            detail: { handle: ref.handle },
          })
        }
      }
      accepted.push(input.id)
    }
    return { status: 'accepted', inputIds: accepted }
  }

  /**
   * 停止：关掉承载 Agent 的 pane（连带 workspace）。
   *
   * 回收检出不在这里做 —— 那是 removeWorkspace 的事，拆开是为了让
   * 「先停 Agent、稍后再回收目录」这种节奏也能成立。
   */
  async stop(ref: WorkerRef, _reason: string): Promise<void> {
    const paneId = ref.handle
    if (!paneId) return
    const res = await this.herdr.run(paneClose(paneId))
    if (res.code !== 0) {
      const error = parseCliError(res)
      // pane 已经不在了（重复 stop / 已被回收）视为幂等成功。
      if (!error || !/not_found|already/i.test(error.code)) {
        throw new WorkerRuntimeError('agent:gone', `herdr pane close 失败: ${error?.message ?? res.stderr.trim()}`, {
          cause: error?.message ?? res.stderr,
          detail: { handle: paneId },
        })
      }
    }
    const meta = this.readMeta(ref.ticketId)
    // 关掉最后一个 pane 会连带关掉 workspace；再关一次是幂等的，能收掉残骸。
    if (meta?.workspaceId) {
      await this.herdr.run(workspaceClose(meta.workspaceId)).catch(() => ({ code: 1, stdout: '', stderr: '' }))
    }
    if (meta) {
      meta.status = 'stopped'
      this.writeMeta(ref.ticketId, meta)
    }
  }

  /** 状态：把 Herdr 的屏幕识别结果映射成中立的 AgentStatus。 */
  async status(ref: WorkerRef): Promise<AgentStatus | null> {
    const res = await this.herdr.run(agentGet(ref.handle))
    if (res.code !== 0) {
      const error = parseCliError(res)
      // 目标不存在 = Agent 已经没了；查询本身失败 = 判断不了，返回 null。
      if (error?.code === 'agent_not_found' || error?.code === 'agent_not_running') {
        return { alive: false, phase: 'lost', acceptingInput: false, detail: { source: 'herdr' } }
      }
      return null
    }
    const agent = parseAgent(res.stdout)
    if (!agent) return null
    const detail = {
      source: 'herdr',
      agentStatus: agent.status,
      agentKind: agent.kind,
      ...(agent.stateChangeSeq !== undefined ? { stateChangeSeq: agent.stateChangeSeq } : {}),
      ...(agent.completionSeq !== undefined ? { completionSeq: agent.completionSeq } : {}),
    }
    switch (agent.status) {
      case 'blocked':
        // Herdr 认出的确认 / 提问弹窗：Agent 活着但在等人，Router 不该往里投输入。
        return { alive: true, phase: 'blocked', acceptingInput: false, detail }
      case 'idle':
      case 'done':
      case 'working':
        // working 时 Herdr 仍然接受 prompt（可以边干边插话），所以 acceptingInput 保持 true。
        return { alive: true, phase: 'running', acceptingInput: true, detail }
      case 'unknown':
        return { alive: true, phase: 'unknown', acceptingInput: false, detail }
      default:
        return { alive: true, phase: 'unknown', acceptingInput: false, detail }
    }
  }

  /** 输出尾部：读终端渲染文本；Agent 正在忙时退回 visible 源。 */
  async output(ref: WorkerRef, opts: { limit?: number } = {}): Promise<AgentOutput | null> {
    const limit = opts.limit ?? 60
    const res = await this.herdr.run(agentRead(ref.handle, { lines: limit }))
    if (res.code !== 0) {
      const error = parseCliError(res)
      // Agent 忙 / 被阻塞时，带 --lines 的 recent 源会拒绝读取；visible 源不需要。
      if (error?.code !== 'agent_not_idle') return null
      const fallback = await this.herdr.run(agentRead(ref.handle, { lines: limit, source: 'visible' }))
      if (fallback.code !== 0) return null
      return { status: 'running', lines: splitLines(fallback.stdout, limit), source: 'herdr-visible' }
    }
    return { status: 'running', lines: splitLines(res.stdout, limit), source: 'herdr' }
  }

  /** 结构化活动：读 Agent 自己的会话记录，比终端屏幕干净。 */
  async activity(query: ActivityQuery): Promise<SessionSnapshot | null> {
    const workdir = query.ref.workdir
    if (!workdir) return null
    const meta = this.readMeta(query.ref.ticketId)
    const resolved = resolveSession(workdir, meta?.agent ?? this.agent, {
      ...(this.claudeProjectsDir ? { roots: { claude: this.claudeProjectsDir } } : {}),
    })
    if (!resolved) return null
    return resolved.reader.read(workdir, query.opts ?? {})
  }

  async inspectWorkspace(ref: WorkspaceRef): Promise<WorkspaceInfo | null> {
    if (!ref.workdir) return null
    return this.gitProvider.inspect(ref.workdir)
  }

  /** 回收检出：先关 Herdr 窗口，再让 git 删掉 worktree。 */
  async removeWorkspace(ref: WorkspaceRef): Promise<void> {
    const meta = this.readMeta(ref.ticketId)
    const paneId = meta?.paneId
    const workspaceId = meta?.workspaceId ?? ref.workspaceRef
    if (paneId) await this.herdr.run(paneClose(paneId)).catch(() => ({ code: 1, stdout: '', stderr: '' }))
    if (workspaceId) await this.herdr.run(workspaceClose(workspaceId)).catch(() => ({ code: 1, stdout: '', stderr: '' }))
    const workdir = ref.workdir || meta?.workdir
    if (workdir) await this.removeWorktree(workdir, meta?.repo)
    this.clearMeta(ref.ticketId)
  }

  async doctor(): Promise<DiagnosticCheck[]> {
    const checks: DiagnosticCheck[] = []
    const ver = await this.herdr.run(version())
    const cliOk = ver.code === 0
    checks.push({
      name: 'Herdr CLI',
      status: cliOk ? 'ok' : 'fail',
      detail: cliOk ? ver.stdout.trim() : `${ver.stderr || ver.stdout}`.trim().slice(0, 160),
      ...(cliOk ? {} : { hint: '安装 Herdr，并确保 herdr 在 PATH 中（https://herdr.dev/docs/install）' }),
    })
    if (!cliOk) {
      checks.push({
        name: 'Herdr server',
        status: 'fail',
        detail: '未检测（Herdr CLI 不可用）',
        hint: '安装 Herdr，并确保 herdr 在 PATH 中（https://herdr.dev/docs/install）',
      })
      return checks
    }
    // 检测时顺手把服务端拉起来：没有服务端，herdr 的每条命令都会返回 server_not_running。
    const server = await ensureHerdrServer({
      runner: this.herdr,
      ...(this.spawnServer ? { spawnFn: this.spawnServer } : {}),
    })
    checks.push({
      name: 'Herdr server',
      status: server.running ? 'ok' : 'fail',
      detail: server.running
        ? `${server.version ?? 'running'}${server.started ? '（已自动拉起）' : ''}`
        : (server.reason ?? '未找到运行中的 Herdr 服务端'),
      ...(server.running ? {} : { hint: '启动 Herdr 服务端（herdr server），否则所有 herdr 命令都会返回 server_not_running' }),
    })
    return checks
  }

  /**
   * 本地路径仓库的 PR 跟踪需要 owner/repo。
   *
   * 检出是源仓库的 linked worktree，origin 与源仓库一致，
   * 所以直接在检出目录里读 remote 就行。
   */
  async repoSlug(ref: WorkerRef): Promise<string | null> {
    const workdir = ref.workdir
    if (!workdir) return null
    return this.gitProvider.remoteRepo(workdir)
  }

  /** 服务端不在就把它拉起来；拉不起来时给出可重试的 runtime:unavailable。 */
  private async ensureServer(): Promise<void> {
    const state = await ensureHerdrServer({
      runner: this.herdr,
      ...(this.spawnServer ? { spawnFn: this.spawnServer } : {}),
    })
    if (!state.running) {
      throw new WorkerRuntimeError(
        'runtime:unavailable',
        `herdr 服务端不可用：${state.reason ?? '未知原因'}`,
        { retryable: true, detail: { reason: state.reason } },
      )
    }
  }

  private async createWorkspace(cwd: string, label: string): Promise<HerdrWorkspaceResult> {
    const res = await this.run(workspaceCreate({ cwd, label }))
    const created = parseWorkspaceResult(res.stdout)
    if (!created.paneId) {
      throw new WorkerRuntimeError('workspace:create-failed', 'herdr workspace create 没有返回 pane id', {
        detail: { cwd },
      })
    }
    return created
  }

  /**
   * 拉起 Agent，并处理两种「起不来」：
   * - 名字被上一轮残留的 Agent 占了：把那个 pane 关掉再试一次；
   * - Agent 卡在启动前的确认弹窗（Claude Code 的「信任此文件夹」）：替用户点掉。
   */
  private async startAgent(meta: HerdrMeta, kind: HerdrAgentKind): Promise<void> {
    const paneId = meta.paneId!
    const name = meta.agentName!
    const args = this.launchArgs(kind)
    const res = await this.herdr.run(agentStart({ name, kind: kind.value, pane: paneId, args }))
    if (res.code === 0) {
      meta.status = 'running'
      this.writeMeta(meta.ticketId, meta)
      return
    }
    const error = parseCliError(res)
    if (error?.code === 'agent_name_taken') {
      const stalePane = parseStalePaneId(error.message)
      if (!stalePane || stalePane === paneId) {
        throw this.startError(error, res, paneId)
      }
      await this.herdr.run(paneClose(stalePane)).catch(() => ({ code: 1, stdout: '', stderr: '' }))
      const retry = await this.herdr.run(agentStart({ name, kind: kind.value, pane: paneId, args }))
      if (retry.code === 0) {
        meta.status = 'running'
        this.writeMeta(meta.ticketId, meta)
        return
      }
      throw this.startError(parseCliError(retry), retry, paneId)
    }
    if (error?.code === 'agent_not_ready') {
      if (!await this.acceptTrustPrompt(paneId)) {
        throw this.startError(error, res, paneId)
      }
      await this.waitForAgentReady(paneId)
      meta.status = 'running'
      this.writeMeta(meta.ticketId, meta)
      return
    }
    throw this.startError(error, res, paneId)
  }

  /**
   * 自动确认「是否信任此文件夹」。
   *
   * 弹窗默认选中「No, exit」，所以往下挪一格选「Yes, I trust this folder」再回车。
   * 只在文本确实命中时才动手，避免误触别的确认框。
   */
  private async acceptTrustPrompt(paneId: string): Promise<boolean> {
    const res = await this.herdr.run(paneRead(paneId, { lines: 40 }))
    if (res.code !== 0) return false
    if (!TRUST_PROMPT_PATTERN.test(res.stdout)) return false
    const down = await this.herdr.run(agentSendKeys(paneId, ['down']))
    if (down.code !== 0) return false
    const enter = await this.herdr.run(agentSendKeys(paneId, ['enter']))
    return enter.code === 0
  }

  /** 等 Agent 从 blocked 变成能收输入的状态。 */
  private async waitForAgentReady(paneId: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const res = await this.herdr.run(agentGet(paneId))
      if (res.code === 0) {
        const agent = parseAgent(res.stdout)
        if (agent && agent.status !== 'blocked' && agent.status !== 'unknown') return
      }
      await sleep(300)
    }
    throw new WorkerRuntimeError('agent:launch-failed', `herdr Agent 在 ${timeoutMs}ms 内没有就绪`, {
      retryable: true,
      detail: { paneId },
    })
  }

  private agentKind(): HerdrAgentKind {
    const kind = herdrAgentKindOf(this.agent)
    if (kind) return kind
    const fallback = herdrAgentKindOf(String(runtimeOptionDefault(HERDR_RUNTIME_ID, 'agent') ?? ''))
    if (fallback) return fallback
    throw new WorkerRuntimeError('runtime:unknown', `未知的 Herdr Agent kind: ${this.agent}`)
  }

  private launchArgs(kind: HerdrAgentKind): string[] {
    const args = [...kind.args]
    if (this.model && kind.modelFlag) args.push(kind.modelFlag, this.model)
    return args
  }

  private startError(error: HerdrCliError | null, res: CommandResult, paneId: string): WorkerRuntimeError {
    const reason = error?.message ?? res.stderr.trim()
    if (error?.code === 'server_not_running') {
      return new WorkerRuntimeError('runtime:unavailable', 'herdr 服务端没有在运行，请先启动 Herdr（herdr server）', {
        retryable: true,
        cause: reason,
        detail: { paneId },
      })
    }
    if (error?.code === 'agent_not_ready') {
      return new WorkerRuntimeError('agent:launch-failed', `herdr agent start 未就绪（Agent 被阻塞，通常是首次运行的确认弹窗）: ${reason}`, {
        cause: reason,
        detail: { paneId },
      })
    }
    return new WorkerRuntimeError('agent:launch-failed', `herdr agent start 失败: ${reason}`, {
      cause: reason,
      detail: { paneId },
    })
  }

  private async run(argv: string[]): Promise<CommandResult> {
    const res = await this.herdr.run(argv)
    if (res.code !== 0) {
      const error = parseCliError(res)
      const reason = error?.message ?? res.stderr.trim() ?? ''
      if (error?.code === 'server_not_running') {
        throw new WorkerRuntimeError('runtime:unavailable', 'herdr 服务端没有在运行，请先启动 Herdr（herdr server）', {
          retryable: true,
          cause: reason,
          detail: { argv: argv.slice(0, 2).join(' ') },
        })
      }
      throw new WorkerRuntimeError('workspace:create-failed', `herdr ${argv.slice(0, 2).join(' ')} 失败: ${reason}`, {
        cause: reason,
        detail: { argv: argv.slice(0, 2).join(' ') },
      })
    }
    return res
  }

  /** 启动半失败时把窗口与检出回收掉，避免重试撞分支。 */
  private async rollback(meta: HerdrMeta): Promise<void> {
    if (meta.paneId) await this.herdr.run(paneClose(meta.paneId)).catch(() => ({ code: 1, stdout: '', stderr: '' }))
    if (meta.workspaceId) {
      await this.herdr.run(workspaceClose(meta.workspaceId)).catch(() => ({ code: 1, stdout: '', stderr: '' }))
    }
    if (meta.workdir) await this.removeWorktree(meta.workdir, meta.repo).catch(() => {})
  }

  /**
   * 删检出。
   *
   * `git worktree remove` 必须在仓库上下文里跑，所以 cwd 给源仓库而不是检出目录；
   * 检出里有改动时先温和地删，失败了再强制删。
   */
  private async removeWorktree(workdir: string, repo?: string): Promise<void> {
    // 先确认它确实是一个受管的检出，避免误删别的路径。
    const info = await this.gitProvider.inspect(workdir).catch(() => null)
    if (!info) return
    const opts = repo && repo.startsWith('/') ? { cwd: repo } : {}
    const res = await this.git.run(['worktree', 'remove', '--', workdir], opts)
    if (res.code === 0) return
    const forced = await this.git.run(['worktree', 'remove', '--force', '--', workdir], opts)
    if (forced.code !== 0) {
      throw new WorkerRuntimeError('workspace:remove-failed', `git worktree remove 失败: ${forced.stderr || forced.stdout}`, {
        cause: forced.stderr || forced.stdout,
        detail: { workdir, repo },
      })
    }
  }

  private metaPath(ticketId: string): string {
    return join(this.workersDir, ticketId, 'meta.json')
  }

  private readMeta(ticketId: string): HerdrMeta | null {
    if (!ticketId) return null
    try {
      return JSON.parse(readFileSync(this.metaPath(ticketId), 'utf8')) as HerdrMeta
    } catch {
      return null
    }
  }

  private writeMeta(ticketId: string, meta: HerdrMeta): void {
    const path = this.metaPath(ticketId)
    mkdirSync(join(this.workersDir, ticketId), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  }

  private clearMeta(ticketId: string): void {
    const path = this.metaPath(ticketId)
    if (existsSync(path)) {
      try {
        renameSync(path, `${path}.removed`)
      } catch {
        // 删不掉就留着；下一轮 start 会覆盖它。
      }
    }
  }
}

/** 投递时带上输入 id：worker 只有看到 id 才能写进 acked_inputs，Router 才不会重投。 */
export function renderInput(input: InboundMessage): string {
  return `【Router 输入 ${input.id}】\n${input.text}`
}

/**
 * 把契约里的「工作目录待定」占位换成 Herdr 实际建出来的检出路径。
 *
 * 中立契约里写的是「(由运行时决定)」，Orca 的手册里写的是「(由 Orca 决定)」；
 * 两种都换成真实路径，worker 才知道自己在哪。
 */
export function withWorkdir(text: string, workdir: string): string {
  if (!workdir) return text
  return text.replaceAll('(由运行时决定)', workdir).replaceAll('(由 Orca 决定)', workdir)
}

/**
 * Agent 名字：`<项目>-<分支>-<短哈希>`。
 *
 * Herdr 要求名字匹配 `[a-z][a-z0-9_-]{0,31}` 且存活期间唯一。
 * 末尾的短哈希由「工具 + 项目路径 + 分支」算出：同一个组合永远得到同一个名字，
 * 换个工具或换个分支立刻不同 —— 比工单号这种递增数字稳定，
 * 重派工时也能算出同名（撞名就回收旧窗口）。
 */
export function agentNameFor(opts: { kind: string; repo: string; branch: string }): string {
  const hash = shortHash(`${opts.kind}\n${opts.repo}\n${opts.branch}`)
  const repoPart = slugOf(basename(opts.repo)).slice(0, REPO_PART_MAX)
  const branchPart = slugOf(opts.branch.split('/').pop() ?? opts.branch).slice(0, BRANCH_PART_MAX)
  const head = [repoPart, branchPart].filter(Boolean).join('-')
  const room = AGENT_NAME_MAX - 1 - hash.length
  const base = `ra-${head}`.slice(0, room).replace(/-+$/, '')
  return `${base}-${hash}`
}

/** 内容哈希：短、稳定、只做唯一后缀。 */
export function shortHash(input: string, length = 8): string {
  return createHash('sha256').update(String(input ?? '')).digest('hex').slice(0, length)
}

export interface HerdrWorkspaceResult {
  paneId?: string
  workspaceId?: string
  tabId?: string
}

/** 解析 `herdr workspace create` 的返回。 */
export function parseWorkspaceResult(stdout: string): HerdrWorkspaceResult {
  const root = parseJson(stdout)
  const result = (root?.result ?? {}) as Record<string, any>
  const pane = (result.root_pane ?? {}) as Record<string, any>
  const workspace = (result.workspace ?? {}) as Record<string, any>
  return {
    ...(pane.pane_id ? { paneId: String(pane.pane_id) } : {}),
    ...(workspace.workspace_id ? { workspaceId: String(workspace.workspace_id) } : {}),
    ...(pane.tab_id ? { tabId: String(pane.tab_id) } : {}),
  }
}

/** 从「名字被占用」的错误里捞出占用者所在的 pane。 */
export function parseStalePaneId(message: string): string | null {
  return String(message ?? '').match(/pane_id=([A-Za-z0-9:_-]+)/)?.[1] ?? null
}

export interface HerdrAgentInfo {
  status: string
  kind?: string
  name?: string
  paneId?: string
  stateChangeSeq?: number
  completionSeq?: number
  sessionId?: string
  interactiveReady?: boolean
}

/** 解析 `herdr agent get/start/prompt` 里的 Agent 快照。 */
export function parseAgent(stdout: string): HerdrAgentInfo | null {
  const root = parseJson(stdout)
  const result = (root?.result ?? {}) as Record<string, any>
  const agent = (result.agent ?? {}) as Record<string, any>
  if (!agent || typeof agent !== 'object' || !agent.agent_status) return null
  const session = (agent.agent_session ?? {}) as Record<string, any>
  return {
    status: String(agent.agent_status),
    ...(agent.agent ? { kind: String(agent.agent) } : {}),
    ...(agent.name ? { name: String(agent.name) } : {}),
    ...(agent.pane_id ? { paneId: String(agent.pane_id) } : {}),
    ...(agent.state_change_seq !== undefined ? { stateChangeSeq: Number(agent.state_change_seq) } : {}),
    ...(agent.completion_seq !== undefined ? { completionSeq: Number(agent.completion_seq) } : {}),
    ...(session.value ? { sessionId: String(session.value) } : {}),
    ...(agent.interactive_ready !== undefined ? { interactiveReady: Boolean(agent.interactive_ready) } : {}),
  }
}

/** 解析 Herdr CLI 的错误体。 */
export function parseCliError(res: CommandResult): HerdrCliError | null {
  for (const raw of [res.stderr, res.stdout]) {
    const text = raw?.trim()
    if (!text) continue
    try {
      const parsed = JSON.parse(text) as Record<string, any>
      const error = parsed?.error as Record<string, any> | undefined
      if (error) {
        return {
          code: String(error.code ?? 'unknown'),
          message: String(error.message ?? text).slice(0, 300),
        }
      }
    } catch {
      // 不是 JSON（例如 CLI 用法错误），按纯文本处理。
    }
  }
  return null
}

function slugOf(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function parseJson(stdout: string): Record<string, any> | null {
  const text = stdout?.trim()
  if (!text) return null
  try {
    return JSON.parse(text) as Record<string, any>
  } catch {
    return null
  }
}

function splitLines(text: string, limit: number): string[] {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .slice(-limit)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
