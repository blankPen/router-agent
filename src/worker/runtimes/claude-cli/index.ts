import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CommandRunner } from '../../../infra/process.js'
import { GitWorktreeProvider } from '../../workspaces/git-worktree.js'
import { readClaudeSession } from '../../orca/session.js'
import { workBranch, worktreeName } from '../../naming.js'
import {
  WorkerRuntimeError,
  type ActivityQuery,
  type AgentOutput,
  type AgentStatus,
  type RuntimeCapabilities,
  type DeliverOptions,
  type DeliveryReceipt,
  type DiagnosticCheck,
  type InboundMessage,
  type SessionSnapshot,
  type StartResult,
  type WorkerRuntime,
  type WorkerContext,
  type WorkerRef,
  type ToolPolicy,
  type WorkspaceInfo,
  type WorkspaceRef,
} from '../../port.js'

export interface ClaudeCliRuntimeOptions {
  claude: CommandRunner
  git: CommandRunner
  /** ~/.router-agent/workers */
  workersDir: string
  /** ~/.router-agent */
  home: string
  claudeProjectsDir?: string
  model?: string
  permissionMode?: string
  allowedTools?: string
  /** 额外允许的环境变量；默认只给 PATH/HOME/TMPDIR/LANG。 */
  env?: NodeJS.ProcessEnv
  /** 允许创建 worktree 的根目录；默认 <home>/worktrees。 */
  worktreesRoot?: string
}

interface ClaudeAgentRecord {
  id: string
  pid?: number
  cwd?: string
  kind?: string
  name?: string
  state?: string
  status?: string
  waitingFor?: string
  sessionId?: string
  startedAt?: number
}

interface ClaudeMeta {
  schemaVersion?: number
  ticketId: string
  assignmentId: string
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
  lastHandedOffInputId?: string
  lastHandedOffAttempt?: number
}

/**
 * Claude Code CLI 运行时：用 Claude 自己的后台会话管理（agent view）承载工单。
 *
 * - 首轮：claude --bg "<brief 文件路径>"；
 * - 状态：claude agents --json --all；
 * - 追问：会话 done/stopped 后 claude --bg --resume <sessionId>，**不能带新 flags**；
 * - 停止：claude stop <id>（保留会话）。
 */
export class ClaudeCliRuntime implements WorkerRuntime {
  readonly id = 'claude-cli'
  readonly capabilities: RuntimeCapabilities = {
    agent: { liveStatus: true, processExit: false, output: true, activity: true, structuredInput: true, nudge: false },
    workspace: { cleanup: true, prLink: false, discovery: false },
  }
  private claude: CommandRunner
  private workersDir: string
  private home: string
  private claudeProjectsDir?: string
  private model?: string
  private permissionMode: string
  private allowedTools?: string
  private env: NodeJS.ProcessEnv
  private gitProvider: GitWorktreeProvider

  constructor(opts: ClaudeCliRuntimeOptions) {
    this.claude = opts.claude
    this.workersDir = opts.workersDir
    this.home = opts.home
    this.claudeProjectsDir = opts.claudeProjectsDir ?? defaultClaudeProjectsDir()
    this.model = opts.model
    this.permissionMode = opts.permissionMode ?? 'acceptEdits'
    this.allowedTools = opts.allowedTools ?? [
      'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'Bash(ra report:*)', 'Bash(ra doc:*)', 'Bash(git:*)', 'Bash(gh:*)',
      'Bash(pnpm:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(yarn:*)', 'Bash(bun:*)',
      'Bash(python:*)', 'Bash(python3:*)', 'Bash(pytest:*)', 'Bash(cargo:*)', 'Bash(go:*)', 'Bash(make:*)', 'Bash(mvn:*)', 'Bash(gradle:*)',
    ].join(',')
    this.env = buildEnv(opts.env)
    this.gitProvider = new GitWorktreeProvider({
      git: opts.git,
      worktreesRoot: opts.worktreesRoot ?? join(opts.home, 'worktrees'),
    })
  }

  async start(ctx: WorkerContext): Promise<StartResult> {
    const ticket = ctx.ticket
    const repo = ticket.repo
    const baseBranch = ticket.branch
    const branch = workBranch(ticket)
    if (!repo) throw new WorkerRuntimeError('workspace:missing-repo', '工单没有指定仓库，拒绝创建 worktree')
    if (!baseBranch) throw new WorkerRuntimeError('workspace:missing-branch', '工单没有指定起始分支，拒绝创建 worktree')
    const name = worktreeName(ticket)
    const workdir = ctx.workdir || join(this.home, 'worktrees', name)
    const dir = join(this.workersDir, ticket.id)
    mkdirSync(dir, { recursive: true })
    const briefPath = join(dir, 'brief.md')

    const workspace = await this.gitProvider.create({
      ticketId: ticket.id,
      repo,
      baseBranch,
      workBranch: branch,
      name,
      workdir,
    })
    // 中立的 brief 里 workdir 是「由运行时决定」，拿到实际路径后替换掉。
    writeFileSync(briefPath, (ctx.brief?.contract ?? '').replace('(由运行时决定)', workspace.workdir), 'utf8')
    const meta: ClaudeMeta = {
      schemaVersion: 2,
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
    }
    this.writeMeta(ticket.id, meta)

    try {
      const prompt = `Read ${briefPath} and execute the ticket. Report via ra report.`
      const allowedTools = ctx.tools ? allowedToolsFrom(ctx.tools) : this.allowedTools
      const res = await this.runClaude(
        [
          '--bg',
          '--name', name,
          // brief/input 文件在 workers 目录，显式加入可读目录（会被会话保存，resume 时不需要重复传）。
          '--add-dir', dir,
          ...(this.permissionMode ? ['--permission-mode', this.permissionMode] : []),
          ...(this.model ? ['--model', this.model] : []),
          ...(allowedTools ? ['--allowedTools', allowedTools] : []),
          // --allowedTools 是 variadic；必须用 -- 把 prompt 与工具列表分开。
          '--',
          prompt,
        ],
        workspace.workdir,
      )
      const handle = parseBackgroundId(res.stdout)
      if (!handle) {
        throw new WorkerRuntimeError('agent:launch-failed', `claude --bg 没有返回会话 id: ${res.stdout.slice(0, 200)}`)
      }
      const record = await this.waitForAgent(handle)
      meta.handle = handle
      meta.status = 'running'
      if (record?.sessionId) meta.sessionId = record.sessionId
      if (record?.pid) meta.pid = record.pid
      this.writeMeta(ticket.id, meta)
      return {
        handle,
        workdir: workspace.workdir,
        branch: workspace.branch,
        ...(record?.sessionId ? { sessionId: record.sessionId } : {}),
        workspaceRef: workspace.workspaceRef,
      }
    } catch (error) {
      // launch 半成功：回滚本次新建的 worktree/branch，避免重试冲突。
      await this.bestEffortRollback(workspace.workdir, workspace.branch, repo)
      if (error instanceof WorkerRuntimeError) {
        throw new WorkerRuntimeError(error.code, error.reason, {
          retryable: error.retryable,
          cause: error.cause,
          detail: { ...error.detail, workdir: workspace.workdir, branch: workspace.branch },
        })
      }
      throw new WorkerRuntimeError('agent:launch-failed', error instanceof Error ? error.message : String(error), {
        cause: error instanceof Error ? error.stack : undefined,
        detail: { workdir: workspace.workdir, branch: workspace.branch },
      })
    }
  }

  async deliver(ref: WorkerRef, inputs: InboundMessage[], opts: DeliverOptions = {}): Promise<DeliveryReceipt> {
    const inputIds = inputs.map(input => input.id)
    if (inputs.length === 0) return { status: 'accepted', inputIds }
    const meta = this.readMeta(ref.ticketId)
    const record = await this.findAgent(ref.handle)
    if (record === null) {
      // agents 查询失败：无法判断当前会话是否在跑，排队等下一轮，绝不盲目 resume。
      return { status: 'queued', inputIds, reason: 'claude:agents-unavailable' }
    }
    if (!record) {
      return { status: 'rejected', inputIds, reason: 'claude:session-not-found', retryable: false }
    }
    const sessionId = ref.sessionId ?? meta?.sessionId ?? record.sessionId
    if (!sessionId) {
      return { status: 'rejected', inputIds, reason: 'claude:session-id-missing', retryable: true, retryAfterMs: 30_000 }
    }
    // 启动时可能没来得及捕获 sessionId；后续拿到就回填，避免追问永久失败。
    if (meta && !meta.sessionId && record.sessionId) {
      meta.sessionId = record.sessionId
      this.writeMeta(ref.ticketId, meta)
    }
    if (record.state === 'working' || record.state === 'blocked') {
      // 当前轮还没结束；不做 resume（会 fork 副本），等状态变成 done/stopped。
      return { status: 'queued', inputIds, reason: `claude:${record.state}` }
    }
    if (record.state !== 'done' && record.state !== 'stopped') {
      return { status: 'queued', inputIds, reason: `claude:${record.state ?? 'unknown'}` }
    }
    if (opts.redeliver !== true && meta?.lastHandedOffInputId === inputs.at(-1)?.id && meta?.lastHandedOffAttempt === (opts.attempt ?? 1)) {
      return { status: 'accepted', inputIds }
    }

    const dir = join(this.workersDir, ref.ticketId)
    mkdirSync(dir, { recursive: true })
    const inputPath = join(dir, `input-${safeSegment(inputs[0]!.id)}.md`)
    writeFileSync(inputPath, inputs.map(input => `【Router 输入 ${input.id}】\n${input.text}`).join('\n\n'), 'utf8')
    const prompt = `Read ${inputPath} and continue the ticket. This is a Router follow-up; report via ra report.`
    const res = await this.runClaude(['--bg', '--resume', sessionId, '--', prompt], meta?.workdir ?? ref.workdir ?? process.cwd())
    if (/started a copy as/i.test(res.stdout)) {
      throw new WorkerRuntimeError('agent:launch-failed', `claude --resume 产生了副本，拒绝切换会话: ${res.stdout.slice(0, 200)}`)
    }
    const newId = parseBackgroundId(res.stdout)
    if (newId && newId !== ref.handle) {
      throw new WorkerRuntimeError('agent:launch-failed', `claude --resume 返回了新会话 ${newId}，原会话 ${ref.handle} 未被继续`)
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
    const res = await this.claude.run(['stop', ref.handle], { cwd: ref.workdir ?? this.home, env: this.env })
    // 会话已经不存在时 stop 可能失败；stop 必须幂等，这里不抛错。
    if (res.code !== 0 && !/not found|no such|unknown|no job matching/i.test(`${res.stderr}${res.stdout}`)) {
      throw new WorkerRuntimeError('agent:gone', `claude stop 失败: ${res.stderr || res.stdout}`, {
        cause: res.stderr || res.stdout,
        detail: { handle: ref.handle },
      })
    }
    const meta = this.readMeta(ref.ticketId)
    if (meta) {
      meta.status = 'stopped'
      this.writeMeta(ref.ticketId, meta)
    }
  }

  async status(ref: WorkerRef): Promise<AgentStatus | null> {
    const record = await this.findAgent(ref.handle)
    if (record === null) return null // 查询失败，无法判断
    if (!record) return { alive: false, phase: 'lost', acceptingInput: false, detail: { source: 'claude' } }
    const meta = this.readMeta(ref.ticketId)
    if (meta && !meta.sessionId && record.sessionId) {
      meta.sessionId = record.sessionId
      this.writeMeta(ref.ticketId, meta)
    }
    const lastActivityAt = await this.lastActivityAt(ref, record)
    const base = {
      ...(lastActivityAt ? { lastActivityAt } : {}),
      detail: { source: 'claude', state: record.state, status: record.status, waitingFor: record.waitingFor },
    }
    if (record.state === 'working' || record.status === 'busy') {
      return { alive: true, phase: 'running', acceptingInput: false, ...base }
    }
    if (record.state === 'blocked') {
      return { alive: true, phase: 'blocked', acceptingInput: true, ...base }
    }
    if (record.state === 'done' || record.state === 'stopped') {
      return { alive: false, phase: 'exited', acceptingInput: true, ...base }
    }
    return { alive: true, phase: 'unknown', acceptingInput: false, ...base }
  }

  async output(ref: WorkerRef, opts: { limit?: number } = {}): Promise<AgentOutput | null> {
    const res = await this.claude.run(['logs', ref.handle], { cwd: ref.workdir ?? this.home, env: this.env })
    if (res.code !== 0) return null
    const lines = stripAnsi(res.stdout).split('\n').filter(line => line.trim().length > 0)
    const limit = opts.limit ?? 60
    return { status: 'running', lines: lines.slice(-limit), source: 'claude-logs' }
  }

  async activity(query: ActivityQuery): Promise<SessionSnapshot | null> {
    const meta = this.readMeta(query.ref.ticketId)
    const workdir = query.ref.workdir ?? meta?.workdir
    const sessionId = query.ref.sessionId ?? meta?.sessionId
    if (!workdir || !sessionId) return null
    return readClaudeSession(workdir, {
      ...(this.claudeProjectsDir ? { projectsDir: this.claudeProjectsDir } : {}),
      sessionId,
      ...(query.opts ?? {}),
    })
  }

  async inspectWorkspace(ref: WorkspaceRef): Promise<WorkspaceInfo | null> {
    return this.gitProvider.inspect(ref.workdir)
  }

  async removeWorkspace(ref: WorkspaceRef): Promise<void> {
    await this.gitProvider.remove(ref.workdir)
  }

  /** 本地路径仓库的 PR 跟踪需要 owner/repo；从 origin 推导。 */
  async repoSlug(ref: WorkerRef): Promise<string | null> {
    if (!ref.workdir) return null
    return this.gitProvider.remoteRepo(ref.workdir)
  }

  async doctor(): Promise<DiagnosticCheck[]> {
    const checks: DiagnosticCheck[] = []
    const claude = await this.claude.run(['--version'], { env: this.env })
    checks.push({
      name: 'Claude CLI',
      status: claude.code === 0 ? 'ok' : 'fail',
      detail: claude.code === 0 ? claude.stdout.trim() : `${claude.stderr || claude.stdout}`.trim().slice(0, 160),
      ...(claude.code === 0 ? {} : { hint: '安装 Claude Code CLI，并确认 claude --version 可用' }),
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

  private async findAgent(handle: string): Promise<ClaudeAgentRecord | null | undefined> {
    const agents = await this.listAgents()
    if (agents === null) return null
    return agents.find(agent => agent.kind === 'background' && agent.id === handle)
  }

  private async listAgents(): Promise<ClaudeAgentRecord[] | null> {
    const res = await this.claude.run(['agents', '--json', '--all'], { cwd: this.home, env: this.env })
    if (res.code !== 0) return null
    try {
      const parsed = JSON.parse(res.stdout) as unknown
      return Array.isArray(parsed) ? (parsed as ClaudeAgentRecord[]) : null
    } catch {
      return null
    }
  }

  private async lastActivityAt(ref: WorkerRef, record: ClaudeAgentRecord): Promise<string | undefined> {
    try {
      const snapshot = await this.activity({ ref, opts: { maxEvents: 5 } })
      if (snapshot?.at) return snapshot.at
    } catch {
      // 会话文件读不到时退回 startedAt。
    }
    return typeof record.startedAt === 'number' ? new Date(record.startedAt).toISOString() : undefined
  }

  private async waitForAgent(handle: string): Promise<ClaudeAgentRecord | undefined> {
    for (let i = 0; i < 10; i += 1) {
      const record = await this.findAgent(handle)
      if (record) return record
      await sleep(200)
    }
    return undefined
  }

  private async runClaude(argv: string[], cwd: string) {
    const res = await this.claude.run(argv, { cwd, env: this.env })
    if (res.code !== 0) {
      throw new WorkerRuntimeError('agent:launch-failed', `claude 命令失败: ${res.stderr || res.stdout}`, {
        cause: res.stderr || res.stdout,
        detail: { argv: argv.map(arg => (arg.length > 120 ? `<${arg.length} chars>` : arg)) },
      })
    }
    return res
  }

  private async bestEffortRollback(workdir: string, branch: string, repo: string): Promise<void> {
    await this.gitProvider.remove(workdir).catch(() => {})
    // 分支删除不是所有仓库都允许；失败不影响主流程。
    await this.gitProvider.deleteBranch(branch, repo).catch(() => {})
  }

  private metaPath(ticketId: string): string {
    return join(this.workersDir, ticketId, 'meta.json')
  }

  private readMeta(ticketId: string): ClaudeMeta | null {
    try {
      return JSON.parse(readFileSync(this.metaPath(ticketId), 'utf8')) as ClaudeMeta
    } catch {
      return null
    }
  }

  private writeMeta(ticketId: string, meta: ClaudeMeta): void {
    const path = this.metaPath(ticketId)
    mkdirSync(join(this.workersDir, ticketId), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  }
}

function parseBackgroundId(stdout: string): string | null {
  const match = stdout.match(/backgrounded\s*·\s*([0-9a-zA-Z_-]+)/i) ?? stdout.match(/backgrounded[\s\S]*?\b([0-9a-f]{8})\b/i)
  return match?.[1] ?? null
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'input'
}

/** 把中立 ToolPolicy 映射成 Claude 的 allowedTools 列表。 */
export function allowedToolsFrom(tools: ToolPolicy): string {
  const file = tools.fileAccess === 'read-only'
    ? ['Read', 'Glob', 'Grep']
    : ['Read', 'Write', 'Edit', 'Glob', 'Grep']
  const shell = tools.shell === 'deny'
    ? []
    : tools.shell === 'allow'
      ? ['Bash']
      : (tools.shellAllow ?? []).map(command => `Bash(${command}:*)`)
  return [...file, ...shell].join(',')
}

function buildEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'RA_HOME', 'RA_PORT', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']
  const env: NodeJS.ProcessEnv = {}
  for (const key of keep) {
    const value = overrides?.[key] ?? process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Claude Code 的会话记录默认在 ~/.claude/projects；测试可覆盖。 */
export function defaultClaudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects')
}