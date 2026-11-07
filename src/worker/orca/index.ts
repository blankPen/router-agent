import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { WorkerBackend, WorkerContext, InboundMessage, ContextItem, TerminalOutput } from '../port.js'
import { buildWorkerPrompt } from '../spec/index.js'
import { workBranch, worktreeName } from '../naming.js'
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

export interface OrcaAdapterOptions {
  runner: CommandRunner
  /** ~/.router-agent/workers */
  workersDir: string
  spec: 'prompt' | 'agent'
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

export class OrcaAdapter implements WorkerBackend {
  readonly id = 'orca'
  private runner: CommandRunner
  private workersDir: string
  private spec: 'prompt' | 'agent'

  constructor(opts: OrcaAdapterOptions) {
    this.runner = opts.runner
    this.workersDir = opts.workersDir
    this.spec = opts.spec
  }

  async start(ctx: WorkerContext): Promise<{ handle: string; workdir?: string }> {
    const statePath = join(this.workersDir, ctx.ticket.id, 'state.json')
    const eventsPath = join(this.workersDir, ctx.ticket.id, 'events.log')
    const name = worktreeName(ctx.ticket)
    // 每张工单自带 repo/branch（多项目派工）；缺了说明是脏数据，直接报错不猜。
    const repo = ctx.ticket.repo
    // 工单上的 branch 是「起始分支」；worktree 自己的工作分支由工单号 + 标题语义生成。
    const baseBranch = ctx.ticket.branch
    const branch = workBranch(ctx.ticket)
    if (!repo) throw new Error('orca:missing-repo: 工单没有指定仓库，拒绝创建 worktree')
    if (!baseBranch) throw new Error('orca:missing-branch: 工单没有指定起始分支，拒绝创建 worktree')
    const prompt = buildWorkerPrompt({
      mode: this.spec,
      ticket: ctx.ticket,
      mandateScope: ctx.ticket.title,
      statePath,
      eventsPath,
      repo,
      branch: baseBranch,
      workBranch: branch,
      workdir: ctx.workdir,
    })
    const res = await this.run(worktreeCreate({ repo, name, prompt, branch, ...(baseBranch ? { baseBranch } : {}) }))
    const parsed = parseCreateResult(res.stdout)
    const workdir = parsed.workdir ?? ctx.workdir
    this.writeMeta(ctx, { handle: parsed.handle, workdir, statePath, eventsPath, repo, branch: baseBranch, workBranch: parsed.branch ?? branch })
    return { handle: parsed.handle, workdir }
  }

  async deliver(handle: string, inputs: InboundMessage[]): Promise<void> {
    for (const input of inputs) {
      if (!input.text.trim()) continue
      await this.run(terminalSend(handle, renderInput(input)))
    }
  }

  async registerContext(handle: string, items: ContextItem[]): Promise<void> {
    const text = renderContext(items)
    if (!text) return
    await this.run(terminalSend(handle, text))
  }

  async stop(handle: string, reason: string): Promise<void> {
    void reason
    await this.run(terminalClose(handle))
  }

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
      backend: this.id,
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
