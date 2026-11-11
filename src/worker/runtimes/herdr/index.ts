/**
 * Herdr 运行时：用 Herdr 的 worktree + 终端 pane 承载工单。
 *
 * 与 Orca 运行时同构，但控制面换成了 Herdr：
 * - `worktree create` 建检出并开成 workspace；
 * - `agent start` 在 workspace 的 pane 里拉起 Agent；
 * - `agent prompt` 投递工单契约与追问；
 * - `agent get` / `agent read` 读状态与输出；
 * - `worktree remove` 回收检出。
 *
 * 与 Orca 的两点关键差异：
 * 1. Herdr 的 Agent 状态是**从屏幕识别的**（idle / working / done / blocked / unknown），
 *    不是结构化会话记录；结构化活动仍从 Agent 自己的会话记录里读（见 activity()）。
 * 2. Herdr 需要一个**在跑的服务端**；没有服务端时所有命令都返回 `server_not_running`。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
} from '../../port.js'
import { WorkerRuntimeError } from '../../port.js'
import { buildWorkerPrompt } from '../../spec/index.js'
import { workBranch } from '../../naming.js'
import { resolveSession } from '../../agents/registry.js'
import { parseGitHubRepo } from '../../workspaces/git-worktree.js'
import { runtimeOptionDefault } from '../options.js'
import { HERDR_RUNTIME_ID } from '../catalog.js'
import { herdrAgentKindOf, type HerdrAgentKind } from './agents.js'
import {
  agentGet,
  agentPrompt,
  agentRead,
  agentStart,
  paneClose,
  serverStatus,
  version,
  worktreeCreate,
  worktreeList,
  worktreeOpen,
  worktreeRemove,
  type CommandResult,
  type CommandRunner,
} from './commands.js'

export interface HerdrRuntimeOptions {
  herdr: CommandRunner
  /** git runner；用来从检出解析远端仓库（PR 跟踪需要 owner/repo）。 */
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

  constructor(opts: HerdrRuntimeOptions) {
    this.herdr = opts.herdr
   this.git = opts.git
    this.workersDir = opts.workersDir
    this.home = opts.home
    this.agent = String(opts.agent || runtimeOptionDefault(HERDR_RUNTIME_ID, 'agent') || '').trim()
    this.model = opts.model?.trim() || undefined
    this.claudeProjectsDir = opts.claudeProjectsDir
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
    const label = `ra-${ticket.id}`
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

    const createRes = await this.run(worktreeCreate({
      cwd: repo,
      branch,
      base: baseBranch,
      label,
    }))
    const created = parseWorktreeResult(createRes.stdout)
    const workdir = created.path
    const paneId = created.paneId
    const workspaceId = created.workspaceId
    if (!workdir) throw new WorkerRuntimeError('workspace:create-failed', 'herdr worktree create 没有返回检出路径')
    if (!paneId) throw new WorkerRuntimeError('workspace:create-failed', 'herdr worktree create 没有返回 pane id')

    // Agent 名字带上 pane id：Herdr 的名字在存活期间唯一，重派工时不会撞名。
    const agentName = agentNameFor(ticket.id, paneId)
    const kind = this.agentKind()
    const meta: HerdrMeta = {
      schemaVersion: 2,
      ticketId: ticket.id,
      assignmentId: ctx.assignment.id,
      runtime: this.id,
      handle: paneId,
      agentName,
      paneId,
      workspaceId,
      workdir,
      repo,
      branch: baseBranch,
      workBranch: created.branch || branch,
      agent: kind.value,
      status: 'starting',
      startedAt: new Date().toISOString(),
    }
    this.writeMeta(ticket.id, meta)

    try {
      const startRes = await this.run(agentStart({
        name: agentName,
        kind: kind.value,
        pane: paneId,
        args: this.launchArgs(kind),
      }))
      const started = parseAgent(startRes.stdout)
      meta.status = 'running'
      this.writeMeta(ticket.id, meta)

      // 契约作为首轮输入投进去；Herdr 的 agent prompt 会补上 Enter。
      await this.run(agentPrompt(paneId, withWorkdir(prompt, workdir)))
      return {
        handle: paneId,
        workdir,
        branch: meta.workBranch,
        workspaceRef: workspaceId,
        ...(started?.sessionId ? { sessionId: started.sessionId } : {}),
      }
    } catch (error) {
      await this.rollback(meta).catch(() => {})
      if (error instanceof WorkerRuntimeError) {
        throw new WorkerRuntimeError(error.code, error.reason, {
          retryable: error.retryable,
          cause: error.cause,
          detail: { ...error.detail, workdir, paneId, workspaceId },
        })
      }
      throw new WorkerRuntimeError('agent:launch-failed', error instanceof Error ? error.message : String(error), {
        cause: error instanceof Error ? error.stack : undefined,
        detail: { workdir, paneId, workspaceId },
      })
    }
  }

  async deliver(ref: WorkerRef, inputs: InboundMessage[], _opts?: DeliverOptions): Promise<DeliveryReceipt> {
    const accepted: string[] = []
    for (const input of inputs) {
      if (!input.text.trim()) continue
      const res = await this.herdr.run(agentPrompt(ref.handle, renderInput(input)))
      if (res.code !== 0) {
        const error = parseCliError(res)
        // Agent 正卡在确认弹窗上：Herdr 拒收输入。让 Router 稍后重投，不要硬写终端。
        if (error?.code === 'agent_blocked') {
          return {
            status: 'rejected',
            inputIds: accepted,
            reason: 'herdr:agent-blocked',
            retryable: true,
            retryAfterMs: 30_000,
          }
        }
        if (error?.code === 'agent_not_found' || error?.code === 'agent_not_running') {
          return { status: 'rejected', inputIds: accepted, reason: `herdr:${error.code}`, retryable: false }
        }
        throw new WorkerRuntimeError('agent:not-accepting-input', `herdr agent prompt 失败: ${error?.message ?? res.stderr.trim()}`, {
          cause: error?.message ?? res.stderr,
          detail: { handle: ref.handle },
        })
      }
      accepted.push(input.id)
    }
    return { status: 'accepted', inputIds: accepted }
  }

  /**
   * 停止：关掉承载 Agent 的 pane。
   *
 * 副作用要知道：关掉最后一个 pane 会连带关掉 workspace，
 * 此时检出会暂时留在磁盘上，由 removeWorkspace 重新打开后删除。
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
    const res = await this.herdr.run(worktreeList())
    if (res.code !== 0) return null
    const found = parseWorktreeList(res.stdout).find(item => item.path === ref.workdir)
    if (!found) return null
    return {
      workdir: found.path,
      branch: found.branch ?? '',
      ...(found.dirty !== undefined ? { dirty: found.dirty } : {}),
    }
  }

  /**
   * 回收检出。
   *
   * stop() 关掉最后一个 pane 时会连带关掉 workspace，此时按 workspace id 删会报
   * `workspace_not_found`、检出目录留在磁盘上；先按分支重新打开再删。
   */
  async removeWorkspace(ref: WorkspaceRef): Promise<void> {
    const meta = this.readMeta(ref.ticketId)
    const workspaceId = meta?.workspaceId ?? ref.workspaceRef
    if (workspaceId) {
      const res = await this.herdr.run(worktreeRemove(workspaceId, { force: true }))
      if (res.code === 0) {
        this.clearMeta(ref.ticketId)
        return
      }
      const error = parseCliError(res)
      if (error?.code !== 'workspace_not_found') {
        throw new WorkerRuntimeError('workspace:remove-failed', `herdr worktree remove 失败: ${error?.message ?? res.stderr.trim()}`, {
          cause: error?.message ?? res.stderr,
          detail: { workspaceId, workdir: ref.workdir },
        })
      }
    }
    // workspace 已经没了：按「仓库 + 分支」把检出来重新打开，再删一次。
    if (!meta?.repo || !meta.workBranch) {
      throw new WorkerRuntimeError('workspace:remove-failed', 'herdr 找不到可回收的检出信息（缺少仓库或分支）', {
        detail: { workdir: ref.workdir },
      })
    }
    const openRes = await this.herdr.run(worktreeOpen({ cwd: meta.repo, branch: meta.workBranch }))
    if (openRes.code !== 0) {
      const error = parseCliError(openRes)
      throw new WorkerRuntimeError('workspace:remove-failed', `herdr worktree open 失败: ${error?.message ?? openRes.stderr.trim()}`, {
        cause: error?.message ?? openRes.stderr,
        detail: { workdir: ref.workdir, branch: meta.workBranch },
      })
    }
    const reopened = parseWorktreeResult(openRes.stdout)
    if (!reopened.workspaceId) {
      throw new WorkerRuntimeError('workspace:remove-failed', 'herdr worktree open 没有返回 workspace id', {
        detail: { workdir: ref.workdir, branch: meta.workBranch },
      })
    }
    const removeRes = await this.herdr.run(worktreeRemove(reopened.workspaceId, { force: true }))
    if (removeRes.code !== 0) {
      const error = parseCliError(removeRes)
      throw new WorkerRuntimeError('workspace:remove-failed', `herdr worktree remove 失败: ${error?.message ?? removeRes.stderr.trim()}`, {
        cause: error?.message ?? removeRes.stderr,
        detail: { workdir: ref.workdir, branch: meta.workBranch },
      })
    }
    this.clearMeta(ref.ticketId)
  }

  async doctor(): Promise<DiagnosticCheck[]> {
    const checks: DiagnosticCheck[] = []
    const ver = await this.herdr.run(version())
    checks.push({
      name: 'Herdr CLI',
      status: ver.code === 0 ? 'ok' : 'fail',
      detail: ver.code === 0 ? ver.stdout.trim() : `${ver.stderr || ver.stdout}`.trim().slice(0, 160),
      ...(ver.code === 0 ? {} : { hint: '安装 Herdr，并确保 herdr 在 PATH 中（https://herdr.dev/docs/install）' }),
    })
    const server = await this.herdr.run(serverStatus())
    const running = server.code === 0 && /^status:\s*running\s*$/m.test(server.stdout)
    checks.push({
      name: 'Herdr server',
      status: running ? 'ok' : 'fail',
      detail: running
        ? (server.stdout.match(/^version:\s*(.+)$/m)?.[1]?.trim() ?? 'running')
        : `${server.stderr || server.stdout}`.trim().slice(0, 160),
      ...(running ? {} : { hint: '启动 Herdr 服务端（herdr server），否则所有 herdr 命令都会返回 server_not_running' }),
    })
    return checks
  }

  /**
   * 本地路径仓库的 PR 跟踪需要 owner/repo。
   *
   * Herdr 的检出是源仓库的 linked worktree，origin 与源仓库一致，
   * 所以直接在检出目录里读 remote 就行。
   */
  async repoSlug(ref: WorkerRef): Promise<string | null> {
    const workdir = ref.workdir
    if (!workdir) return null
    const res = await this.git.run(['remote', 'get-url', 'origin'], { cwd: workdir })
    if (res.code !== 0) return null
    return parseGitHubRepo(res.stdout.trim())
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
      if (error?.code === 'agent_not_ready') {
        throw new WorkerRuntimeError('agent:launch-failed', `herdr agent start 未就绪（Agent 被阻塞，通常是首次运行的确认弹窗）: ${reason}`, {
          cause: reason,
          detail: { argv: argv.slice(0, 3).join(' ') },
        })
      }
      throw new WorkerRuntimeError('agent:launch-failed', `herdr ${argv.slice(0, 2).join(' ')} 失败: ${reason}`, {
        cause: reason,
        detail: { argv: argv.slice(0, 2).join(' ') },
      })
    }
    return res
  }

  /** 启动半失败时把这次建出来的检出回收掉，避免重试撞分支。 */
  private async rollback(meta: HerdrMeta): Promise<void> {
    if (meta.paneId) await this.herdr.run(paneClose(meta.paneId)).catch(() => ({ code: 1, stdout: '', stderr: '' }))
    if (meta.workspaceId) {
      await this.herdr.run(worktreeRemove(meta.workspaceId, { force: true })).catch(() => ({ code: 1, stdout: '', stderr: '' }))
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
 * Agent 名字：`ra-<工单号>-<pane>`。
 *
 * Herdr 的名字在存活期间唯一，必须匹配 `[a-z][a-z0-9_-]{0,31}`；
 * 带上 pane id 后，重派工不会和上一轮残留的 Agent 撞名。
 */
export function agentNameFor(ticketId: string, paneId: string): string {
  const slug = String(ticketId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const pane = String(paneId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const name = `ra-${slug}-${pane}`.slice(0, 32).replace(/-+$/, '')
  return name || 'ra-worker'
}

export interface HerdrWorktreeResult {
  path?: string
  branch?: string
  paneId?: string
  workspaceId?: string
}

/** 解析 `herdr worktree create/open` 的返回。 */
export function parseWorktreeResult(stdout: string): HerdrWorktreeResult {
  const root = parseJson(stdout)
  const result = (root?.result ?? {}) as Record<string, any>
  const worktree = (result.worktree ?? {}) as Record<string, any>
  const workspace = (result.workspace ?? {}) as Record<string, any>
  const pane = (result.root_pane ?? {}) as Record<string, any>
  return {
    ...(worktree.path ? { path: String(worktree.path) } : {}),
    ...(worktree.branch ? { branch: String(worktree.branch) } : {}),
    ...(pane.pane_id ? { paneId: String(pane.pane_id) } : {}),
    ...(workspace.workspace_id ? { workspaceId: String(workspace.workspace_id) } : {}),
  }
}

export interface HerdrWorktreeEntry {
  path: string
  branch?: string
  workspaceId?: string
  dirty?: boolean
}

/** 解析 `herdr worktree list` 的返回。 */
export function parseWorktreeList(stdout: string): HerdrWorktreeEntry[] {
  const root = parseJson(stdout)
  const result = (root?.result ?? {}) as Record<string, any>
  const list = Array.isArray(result.worktrees) ? result.worktrees : []
  return list.map(item => {
    const entry = item as Record<string, any>
    return {
      path: String(entry.path ?? ''),
      ...(entry.branch ? { branch: String(entry.branch) } : {}),
      ...(entry.open_workspace_id ? { workspaceId: String(entry.open_workspace_id) } : {}),
      ...(entry.dirty !== undefined ? { dirty: Boolean(entry.dirty) } : {}),
    }
  })
}

export interface HerdrAgentInfo {
  status: string
  kind?: string
  name?: string
  paneId?: string
  stateChangeSeq?: number
  completionSeq?: number
  sessionId?: string
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
