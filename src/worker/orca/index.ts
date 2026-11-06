import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { WorkerBackend, WorkerContext, InboundMessage, ContextItem } from '../port.js'
import { buildWorkerPrompt } from '../spec/index.js'
import { workBranch, worktreeName } from '../naming.js'
import {
  agentLaunch,
  terminalClose,
  terminalList,
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

  async inspectWorktree(selector: string): Promise<Record<string, unknown> | null> {
    const res = await this.run(worktreeShow(selector))
    const parsed = parseJsonOrThrow(res.stdout) as Record<string, any>
    const result = parsed.result ?? parsed
    return (result.worktree ?? result) as Record<string, unknown>
  }

  async removeWorktree(selector: string): Promise<void> {
    await this.run(worktreeRemove(selector))
  }

  async relaunchAgent(worktree: string, prompt: string): Promise<void> {
    await this.run(agentLaunch({ worktree, prompt }))
  }

  private async run(argv: string[]): Promise<CommandResult> {
    const res = await this.runner.run(argv)
    if (res.code !== 0) {
      throw new Error(`orca:command-failed(${argv[0]} ${argv[1]}): code=${res.code} ${res.stderr.slice(0, 300)}`)
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
