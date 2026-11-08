import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface ReportOptions {
  ticket: string
  state: string
  summary: string
  assignment?: string
  turn?: string
  humanAction?: string
  prNumber?: string
  prUrl?: string
  /** 要发给发起人的完整回复（Markdown）：字面量、`@文件路径` 或 `-`（从 stdin 读）。 */
  reply?: string
  ack?: string[]
}

export interface ReportDeps {
  home: string
  port: number
  stdout(line: string): void
  stderr(line: string): void
  fetchImpl?: typeof fetch
  stdin?: () => string
  now?: () => string
}

const STATES = ['progress', 'ready', 'blocked', 'failed', 'dropped', 'waiting']

/**
 * Worker 的统一上报入口：优先 POST 给本地 Router 服务，服务不可用时落回 state.json。
 * worker 不需要知道文件结构，也不需要自己算 turn / assignment。
 */
export async function runReport(deps: ReportDeps, opts: ReportOptions): Promise<number> {
  const state = opts.state.trim()
  if (!STATES.includes(state)) {
    deps.stderr(`非法 state: ${state}（可选 ${STATES.join(' / ')}）`)
    return 2
  }
  const summary = opts.summary.trim()
  if (!summary) {
    deps.stderr('--summary 不能为空')
    return 2
  }
  if (!opts.ticket.trim()) {
    deps.stderr('--ticket 不能为空')
    return 2
  }

  const reply = readContentArg(deps, opts.reply).trim()
  const payload = {
    ticketId: opts.ticket.trim(),
    ...(opts.assignment ? { assignmentId: opts.assignment } : {}),
    ...(opts.turn ? { turn: Number(opts.turn) } : {}),
    state,
    summary,
    ...(opts.humanAction ? { humanAction: opts.humanAction } : {}),
    ...(opts.prNumber ? { prNumber: Number(opts.prNumber) } : {}),
    ...(opts.prUrl ? { prUrl: opts.prUrl } : {}),
    ...(reply ? { reply } : {}),
    ackedInputs: opts.ack ?? [],
    updatedAt: (deps.now ?? (() => new Date().toISOString()))(),
  }

  const fetchImpl = deps.fetchImpl ?? fetch
  try {
    const res = await fetchImpl(`http://127.0.0.1:${deps.port}/api/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const text = await res.text()
    if (res.ok) {
      const body = safeJson(text)
      deps.stdout(`已上报 ${payload.ticketId}  state=${state}  turn=${body?.turn ?? opts.turn ?? '?'}${reply ? `  回复=${reply.length}字` : ''}`)
      return 0
    }
    // 4xx 是参数问题，落文件也没用；直接告诉调用方。
    if (res.status < 500) {
      deps.stderr(`上报失败(${res.status})：${text.slice(0, 300)}`)
      return 1
    }
    deps.stderr(`Router 服务异常(${res.status})，改为写入本地 state.json`)
  } catch (error) {
    deps.stderr(`Router 服务不可达（${error instanceof Error ? error.message : String(error)}），改为写入本地 state.json`)
  }

  return writeFallback(deps, payload)
}

export function readContentArg(deps: Pick<ReportDeps, 'stdin'>, value?: string): string {
  if (!value) return ''
  if (value === '-') return deps.stdin ? deps.stdin() : readFileSync(0, 'utf8')
  if (value.startsWith('@')) return readFileSync(resolve(value.slice(1)), 'utf8')
  return value
}

/** 服务不可用时沿用旧的文件通道：写 state.json，由 poller 1 秒内捡起。 */
function writeFallback(
  deps: ReportDeps,
  payload: {
    ticketId: string
    assignmentId?: string
    turn?: number
    state: string
    summary: string
    humanAction?: string
    prNumber?: number
    prUrl?: string
    reply?: string
    ackedInputs: string[]
    updatedAt: string
  },
): number {
  const dir = join(deps.home, 'workers', payload.ticketId)
  const statePath = join(dir, 'state.json')
  let turn = payload.turn
  if (turn === undefined) {
    const existing = readJson(statePath)
    turn = Number(existing?.turn ?? 0) + 1
  }
  const file = {
    ticket_id: payload.ticketId,
    assignment_id: payload.assignmentId ?? String(readJson(join(dir, 'meta.json'))?.assignmentId ?? ''),
    turn,
    state: payload.state,
    summary: payload.summary,
    human_action: payload.humanAction ?? null,
    pr_number: payload.prNumber ?? 0,
    pr_url: payload.prUrl ?? '',
    ...(payload.reply ? { reply: payload.reply } : {}),
    acked_inputs: payload.ackedInputs,
    updated_at: payload.updatedAt,
  }
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    const tmp = `${statePath}.tmp`
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    renameSync(tmp, statePath)
    deps.stdout(`已写入 ${statePath}（turn=${turn}，Router 轮询后生效）`)
    return 0
  } catch (error) {
    deps.stderr(`写入 state.json 失败：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

function readJson(path: string): Record<string, any> | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
  } catch {
    return null
  }
}

function safeJson(text: string): Record<string, any> | null {
  try {
    return JSON.parse(text) as Record<string, any>
  } catch {
    return null
  }
}
