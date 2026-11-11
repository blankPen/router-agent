import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  WorkerRuntime,
  WorkerContext,
  InboundMessage,
  ContextItem,
  TerminalOutput,
  SessionSnapshot,
  WorkerRef,
  StartResult,
  DeliveryReceipt,
  DeliverOptions,
  AgentStatus,
  AgentOutput,
  ActivityQuery,
  WorkspaceInfo,
  WorkspaceRef,
  RepoDescriptor,
} from '../port.js'
import { buildWorkerPrompt } from '../spec/index.js'
import { workBranch, worktreeName } from '../naming.js'
import { readClaudeSession } from './session.js'
import {
  agentLaunch,
  terminalClose,
  terminalList,
  terminalRead,
  terminalSend,
  worktreeCreate,
  worktreeRemove,
  worktreeShow,
  type CommandRunner,
  type CommandResult,
} from './commands.js'

export interface OrcaRuntimeOptions {
  runner: CommandRunner
  /** ~/.router-agent/workers */
  workersDir: string
  /** 状态目录；传入后 Worker 规范优先读 `<home>/specs/worker/` 下的覆盖文件。 */
  home?: string
  /** Claude Code 会话记录目录；默认 ~/.claude/projects，测试可注入临时目录。 */
  claudeProjectsDir?: string
}

export interface OrcaTerminalInfo {
  handle: string
  connected: boolean
  writable: boolean
  orphaned: boolean
  lastOutputAt: string
  worktreePath: string
  branch: string
}

/**
 * Orca CLI 失败时的结构化信息。
 * `--json` 模式下 Orca 把错误体写在 stdout（`{"ok":false,"error":{...}}`），stderr 常常为空，
 * 所以只读 stderr 会得到一句没有信息量的 `code=1`。这里把 stdout 的错误体和命令摘要一并保留。
 */
export interface OrcaCommandFailure {
  /** 子命令，如 `worktree create`。 */
  command: string
  code: number
  orcaCode?: string
  orcaMessage?: string
  /**
   * 错误体 `data.cause` 里的底层原因。
   * Orca 会把 git 失败等真实错误包装成通用文案（如 agent_session_operation_unknown），
   * 真正原因只保留在这里；不取出来日志就只剩一句「结果未知」。
   */
  orcaCause?: string
  /** 启动结果未知时的重试句柄；Orca 要求用它 `--retry-launch`，而不是重新派工。 */
  orcaOperationId?: string
  /** 脱敏后的参数摘要：`--prompt` 只保留长度，避免整段 prompt 进日志。 */
  args: string
  stdoutTail: string
  stderrTail: string
}

export class OrcaCommandError extends Error {
  readonly detail: OrcaCommandFailure

  constructor(detail: OrcaCommandFailure) {
    super(formatCommandFailure(detail))
    this.name = 'OrcaCommandError'
    this.detail = detail
  }
}

/** 把一次失败整理成便于日志与消息展示的一行。 */
export function formatCommandFailure(detail: OrcaCommandFailure): string {
  const parts = [`orca:command-failed(${detail.command}): exit=${detail.code}`]
  if (detail.orcaCode) parts.push(`code=${detail.orcaCode}`)
  if (detail.orcaMessage) parts.push(`message=${detail.orcaMessage}`)
  if (detail.orcaCause) parts.push(`cause=${detail.orcaCause}`)
  if (detail.orcaOperationId) parts.push(`operationId=${detail.orcaOperationId}`)
  if (!detail.orcaCode && !detail.orcaMessage && detail.stdoutTail) parts.push(`stdout=${detail.stdoutTail}`)
  if (detail.stderrTail) parts.push(`stderr=${detail.stderrTail}`)
  return parts.join(' | ')
}

/** 从 argv 生成脱敏摘要：跳过长文本参数，保留可复现的关键选项。 */
export function summarizeArgs(args: string[]): string {
  const out: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--prompt') {
      const value = args[i + 1] ?? ''
      out.push(`--prompt <${value.length} chars>`)
      i += 1
      continue
    }
    const next = args[i + 1]
    if (arg.startsWith('--') && next !== undefined && !next.startsWith('--')) {
      out.push(`${arg} ${next}`)
      i += 1
      continue
    }
    out.push(arg)
  }
  return out.join(' ')
}

export function describeCommandFailure(argv: string[], res: CommandResult): OrcaCommandFailure {
  const command = argv.slice(0, 2).join(' ')
  const args = summarizeArgs(argv.slice(2))
  let orcaCode: string | undefined
  let orcaMessage: string | undefined
  let orcaCause: string | undefined
  let orcaOperationId: string | undefined
  let stdoutTail = ''
  try {
    const parsed = JSON.parse(res.stdout) as Record<string, any>
    if (parsed?.error) {
      if (parsed.error.code) orcaCode = String(parsed.error.code)
      if (parsed.error.message) orcaMessage = String(parsed.error.message)
      const data = parsed.error.data as Record<string, any> | undefined
      if (data) {
        if (typeof data.cause === 'string') {
          // cause 可能是带堆栈的多行文本，只留第一行有效信息。
          const first = data.cause.split('\n').map((line: string) => line.trim()).find(Boolean)
          if (first) orcaCause = first.slice(0, 300)
        }
        if (typeof data.operationId === 'string' && data.operationId) orcaOperationId = data.operationId
      }
    } else {
      stdoutTail = res.stdout.slice(0, 300)
    }
  } catch {
    stdoutTail = res.stdout.slice(0, 300)
  }
  return {
    command,
    code: res.code,
    ...(orcaCode ? { orcaCode } : {}),
    ...(orcaMessage ? { orcaMessage } : {}),
    ...(orcaCause ? { orcaCause } : {}),
    ...(orcaOperationId ? { orcaOperationId } : {}),
    args,
    stdoutTail,
    stderrTail: res.stderr.slice(0, 300),
  }
}

/** 解析 `orca worktree create --json` 的返回；不同 Orca 版本字段不同。 */
export function parseCreateResult(stdout: string): { handle: string; workdir?: string; branch?: string } {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    throw new Error(`orca:invalid-json: ${stdout.slice(0, 200)}`)
  }
  const root = json as Record<string, any>
  if (root.ok === false) {
    throw new Error(`orca:create-failed: ${root.error?.message ?? JSON.stringify(root).slice(0, 200)}`)
  }
  const result = (root.result ?? root) as Record<string, any>
  const handle = result.launch?.outcome?.handle ?? result.agentTerminalHandle ?? result.terminalHandle ?? result.terminal?.handle
  if (!handle) throw new Error(`orca:create-failed: 返回中没有 terminal handle: ${stdout.slice(0, 200)}`)
  const workdir = result.worktree?.path ?? result.worktreePath ?? result.path
  const branch = result.worktree?.branch ?? result.branch
  return {
    handle: String(handle),
    ...(workdir ? { workdir: String(workdir) } : {}),
    // Orca 分支名可能是 `refs/heads/xxx`；若同名分支已存在还会自动加数字后缀，回读一次保证记录准确。
    ...(branch ? { branch: String(branch).replace(/^refs\/heads\//, '') } : {}),
  }
}

/** Orca 的 linkedPR / linkedGitLabMR 状态归一化；GitLab 用 opened/locked 表示未关闭。 */
function normalizeLinkedState(state: unknown): 'open' | 'merged' | 'closed' | undefined {
  const value = String(state ?? '').trim().toLowerCase()
  if (value === 'merged') return 'merged'
  if (value === 'closed') return 'closed'
  if (value === 'open' || value === 'opened' || value === 'locked') return 'open'
  return undefined
}

export class OrcaRuntime implements WorkerRuntime {
  readonly id = 'orca'
  readonly capabilities = {
    agent: { liveStatus: true, processExit: false, output: true, activity: true, structuredInput: true, nudge: true },
    workspace: { cleanup: true, prLink: true, discovery: true },
  } as const
  private runner: CommandRunner
  private workersDir: string
  private home?: string
  private claudeProjectsDir?: string

  constructor(opts: OrcaRuntimeOptions) {
    this.runner = opts.runner
    this.workersDir = opts.workersDir
    this.home = opts.home
    this.claudeProjectsDir = opts.claudeProjectsDir
  }

  async start(ctx: WorkerContext): Promise<StartResult> {
    const statePath = ctx.report?.statePath ?? join(this.workersDir, ctx.ticket.id, 'state.json')
    const eventsPath = ctx.report?.eventsPath ?? join(this.workersDir, ctx.ticket.id, 'events.log')
    const name = worktreeName(ctx.ticket)
    // 每张工单自带 repo/branch（多项目派工）；缺了说明是脏数据，直接报错不猜。
    const repo = ctx.ticket.repo
    // 工单上的 branch 是「起始分支」；worktree 自己的工作分支由工单号 + 标题语义生成。
    const baseBranch = ctx.ticket.branch
    const branch = workBranch(ctx.ticket)
    if (!repo) throw new Error('orca:missing-repo: 工单没有指定仓库，拒绝创建 worktree')
    if (!baseBranch) throw new Error('orca:missing-branch: 工单没有指定起始分支，拒绝创建 worktree')
    const prompt = ctx.brief?.contract ?? buildWorkerPrompt({
      ticket: ctx.ticket,
      mandateScope: ctx.ticket.title,
      statePath,
      eventsPath,
      repo,
      branch: baseBranch,
      workBranch: branch,
      workdir: ctx.workdir,
      ...(this.home ? { home: this.home } : {}),
    })
    const res = await this.run(worktreeCreate({ repo, name, prompt, branch, ...(baseBranch ? { baseBranch } : {}) }))
    const parsed = parseCreateResult(res.stdout)
    const workdir = parsed.workdir ?? ctx.workdir
    if (!workdir) throw new Error('orca:workdir-missing: worktree create 没有返回路径')
    this.writeMeta(ctx, { handle: parsed.handle, workdir, statePath, eventsPath, repo, branch: baseBranch, workBranch: parsed.branch ?? branch })
    return {
      handle: parsed.handle,
      workdir,
      ...(parsed.branch ? { branch: parsed.branch } : { branch }),
    }
  }

  async deliver(ref: WorkerRef | string, inputs: InboundMessage[], _opts?: DeliverOptions): Promise<DeliveryReceipt> {
    const handle = this.handleOf(ref)
    const accepted: string[] = []
    for (const input of inputs) {
      if (!input.text.trim()) continue
      await this.run(terminalSend(handle, renderInput(input)))
      accepted.push(input.id)
    }
    return { status: 'accepted', inputIds: accepted }
  }

  async registerContext(ref: WorkerRef | string, items: ContextItem[]): Promise<void> {
    const text = renderContext(items)
    if (!text) return
    await this.run(terminalSend(this.handleOf(ref), text))
  }

  async stop(ref: WorkerRef | string, reason: string): Promise<void> {
    void reason
    await this.run(terminalClose(this.handleOf(ref)))
  }

  async nudge(ref: WorkerRef | string): Promise<void> {
    await this.run(terminalSend(this.handleOf(ref), 'status?'))
  }

  /** 中立活性：把 Orca 终端字段映射成 AgentStatus；查询失败返回 null。 */
  async status(ref: WorkerRef | string): Promise<AgentStatus | null> {
    const handle = this.handleOf(ref)
    let info: OrcaTerminalInfo | null
    try {
      info = await this.inspect(handle)
    } catch {
      return null
    }
    if (!info) return { alive: false, phase: 'lost', acceptingInput: false, detail: { source: 'orca' } }
    if (!info.connected) {
      return { alive: false, phase: 'lost', acceptingInput: false, detail: { source: 'orca', connected: false, orphaned: info.orphaned } }
    }
    if (info.orphaned && !info.writable) {
      return {
        alive: false,
        phase: 'unknown',
        acceptingInput: false,
        ...(info.lastOutputAt ? { lastActivityAt: info.lastOutputAt } : {}),
        detail: { source: 'orca', orphaned: true, writable: false },
      }
    }
    return {
      alive: true,
      phase: 'running',
      acceptingInput: info.writable,
      ...(info.lastOutputAt ? { lastActivityAt: info.lastOutputAt } : {}),
      detail: { source: 'orca', orphaned: info.orphaned, writable: info.writable },
    }
  }

  /** 输出尾部：等价于旧的 read()。 */
  async output(ref: WorkerRef | string, opts: { limit?: number } = {}): Promise<AgentOutput | null> {
    return this.read(this.handleOf(ref), opts)
  }

  /** 结构化活动：优先读 Claude Code 的会话记录；没有 workdir 时返回 null。 */
  async activity(query: ActivityQuery): Promise<SessionSnapshot | null> {
    const workdir = query.ref.workdir
    if (!workdir) return null
    return this.session(workdir, query.opts ?? {})
  }

  async inspectWorkspace(ref: WorkspaceRef): Promise<WorkspaceInfo | null> {
    const selector = ref.workspaceRef ?? `path:${ref.workdir}`
    const worktree = await this.inspectWorktree(selector)
    if (!worktree) return null
    const linked = (worktree.linkedPR ?? worktree.linkedGitLabMR ?? (worktree.worktree as Record<string, any> | undefined)?.linkedPR) as
      | { number?: number; iid?: number; url?: string; webUrl?: string; state?: string }
      | undefined
    const branch = String(worktree.branch ?? (worktree.worktree as Record<string, any> | undefined)?.branch ?? '').replace(/^refs\/heads\//, '')
    const linkedState = normalizeLinkedState(linked?.state)
    return {
      workdir: String(worktree.path ?? (worktree.worktree as Record<string, any> | undefined)?.path ?? ref.workdir),
      branch,
      ...(linked && Number(linked.number ?? linked.iid) > 0
        ? {
            linkedPr: {
              number: Number(linked.number ?? linked.iid),
              url: String(linked.url ?? linked.webUrl ?? ''),
              ...(linkedState ? { state: linkedState } : {}),
            },
          }
        : {}),
    }
  }

  async removeWorkspace(ref: WorkspaceRef): Promise<void> {
    const selector = ref.workspaceRef ?? `path:${ref.workdir}`
    await this.removeWorktree(selector)
  }

  async listRepos(): Promise<RepoDescriptor[]> {
    const res = await this.run(['repo', 'list', '--json'])
    const parsed = parseJsonOrThrow(res.stdout) as Record<string, any>
    const result = (parsed.result ?? parsed) as Record<string, any>
    const list = result.repos ?? result.rows ?? result.items ?? (Array.isArray(result) ? result : [])
    return (Array.isArray(list) ? list : []).map((item: Record<string, any>) => ({
      name: String(item.displayName ?? item.name ?? ''),
      path: String(item.path ?? ''),
      ...(item.kind ? { kind: String(item.kind) } : {}),
    }))
  }

  /** 旧接口：保留给兼容调用与单测。 */
  async inspect(handle: string): Promise<OrcaTerminalInfo | null> {
    const res = await this.run(terminalList())
    const parsed = parseJsonOrThrow(res.stdout)
    const terminals = extractTerminals(parsed)
    const found = terminals.find(t => String(t.handle) === handle)
    return found ? normalizeTerminal(found) : null
  }

  /** 读取终端渲染屏幕的尾部输出；失败（终端已销毁 / 旧版 Orca）时交给调用方跳过本轮巡检。 */
  async read(handle: string, opts: { limit?: number } = {}): Promise<TerminalOutput | null> {
    const res = await this.run(terminalRead(handle, opts))
    const parsed = parseJsonOrThrow(res.stdout) as Record<string, any>
    const raw = parsed.result?.terminal ?? parsed.terminal
    if (!raw) return null
    const status = raw.status === 'running' || raw.status === 'exited' ? raw.status : 'unknown'
    const lines = Array.isArray(raw.tail) ? raw.tail.map((line: unknown) => String(line)) : []
    return { status, lines, ...(raw.source ? { source: String(raw.source) } : {}) }
  }

  /**
   * 优先读 Agent 自己的结构化会话记录（Claude Code JSONL），
   * 比终端屏幕干净得多；找不到时返回 null，由调用方退回 read()。
   */
  async session(workdir: string, opts: { maxBytes?: number; maxEvents?: number } = {}): Promise<SessionSnapshot | null> {
    return readClaudeSession(workdir, {
      ...(this.claudeProjectsDir ? { projectsDir: this.claudeProjectsDir } : {}),
      ...opts,
    })
  }

  async inspectWorktree(selector: string): Promise<Record<string, unknown> | null> {
    const res = await this.run(worktreeShow(selector))
    const parsed = parseJsonOrThrow(res.stdout) as Record<string, any>
    const result = parsed.result ?? parsed
    return (result.worktree ?? result) as Record<string, unknown>
  }

  async removeWorktree(selector: string, opts: { force?: boolean } = {}): Promise<void> {
    await this.run(worktreeRemove(selector, opts))
  }

  async relaunchAgent(worktree: string, prompt: string): Promise<void> {
    await this.run(agentLaunch({ worktree, prompt }))
  }

  private handleOf(ref: WorkerRef | string): string {
    return typeof ref === 'string' ? ref : ref.handle
  }

  private async run(argv: string[]): Promise<CommandResult> {
    const res = await this.runner.run(argv)
    if (res.code !== 0) {
      throw new OrcaCommandError(describeCommandFailure(argv, res))
    }
    return res
  }

  private writeMeta(ctx: WorkerContext, extra: { handle: string; workdir: string; statePath: string; eventsPath: string; repo: string; branch: string; workBranch: string }): void {
    const dir = join(this.workersDir, ctx.ticket.id)
    mkdirSync(dir, { recursive: true })
    const metaPath = join(dir, 'meta.json')
    const meta = {
      schemaVersion: 2,
      ticketId: ctx.ticket.id,
      assignmentId: ctx.assignment.id,
      handle: extra.handle,
      workdir: extra.workdir,
      statePath: extra.statePath,
      eventsPath: extra.eventsPath,
      repo: extra.repo,
      /** 起始分支（base branch）。 */
      branch: extra.branch,
      /** worktree 自己实际使用的工作分支。 */
      workBranch: extra.workBranch,
      runtime: this.id,
      status: 'running',
      startedAt: new Date().toISOString(),
    }
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    if (!existsSync(extra.eventsPath)) writeFileSync(extra.eventsPath, '', 'utf8')
    mkdirSync(dirname(metaPath), { recursive: true })
  }
}

/**
 * 投递时带上输入 id：worker 只有看到 id 才能写进 acked_inputs，Router 才不会重投。
 */
export function renderInput(input: InboundMessage): string {
  return `【Router 输入 ${input.id}】\n${input.text}`
}

function renderContext(items: ContextItem[]): string {
  const lines: string[] = []
  for (const item of items) {
    if (item.kind === 'system-prompt') lines.push(item.text)
    else if (item.kind === 'file') lines.push(`# 文件 ${item.path}\n${item.content}`)
    else if (item.kind === 'env') lines.push(`${item.key}=${item.value}`)
    else lines.push(`# 目录 ${item.path}`)
  }
  return lines.join('\n\n')
}

function parseJsonOrThrow(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`orca:invalid-json: ${stdout.slice(0, 200)}`)
  }
}

function extractTerminals(parsed: unknown): Record<string, any>[] {
  const root = parsed as Record<string, any>
  const result = root.result ?? root
  const list = result.terminals ?? result.rows ?? result.items ?? (Array.isArray(result) ? result : [])
  return Array.isArray(list) ? (list as Record<string, any>[]) : []
}

function normalizeTerminal(raw: Record<string, any>): OrcaTerminalInfo {
  return {
    handle: String(raw.handle ?? ''),
    connected: Boolean(raw.connected),
    writable: Boolean(raw.writable),
    orphaned: Boolean(raw.orphaned),
    lastOutputAt: toIsoTime(raw.lastOutputAt),
    worktreePath: String(raw.worktreePath ?? ''),
    branch: String(raw.branch ?? ''),
  }
}

/** Orca 的 lastOutputAt 实测是毫秒时间戳数字，也兼容 ISO 字符串与秒级时间戳。 */
export function toIsoTime(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
    const n = Number(value)
    const ms = n > 1e12 ? n : n > 1e9 ? n * 1000 : 0
    return ms > 0 ? new Date(ms).toISOString() : ''
  }
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
}
