import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ReportState } from '../../core/model.js'
import type { OrcaTerminalInfo } from './index.js'

/** 旧版 state.json 的交付物字段，仅用于向后兼容，不再参与新协议。 */
const LegacyDeliverableSchema = z.object({
  kind: z.string().optional(),
  content: z.string().default(''),
  title: z.string().optional(),
  url: z.string().default(''),
}).nullable().optional()

const StateSchema = z.object({
  ticket_id: z.string().min(1),
  assignment_id: z.string().default(''),
  turn: z.coerce.number().int().min(0).default(0),
  state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped', 'waiting']),
  summary: z.string().min(1),
  human_action: z.string().nullable().optional(),
  pr_number: z.coerce.number().int().min(0).default(0),
  pr_url: z.string().default(''),
  /** Worker 要发给发起人的完整回复（Markdown）。 */
  reply: z.string().optional().default(''),
  /** 旧版交付物字段，读取时拼进 reply。 */
  deliverable: LegacyDeliverableSchema,
  acked_inputs: z.array(z.string()).default([]),
  updated_at: z.string().default(() => new Date().toISOString()),
})

export interface WorkerStateFile {
  ticketId: string
  assignmentId: string
  turn: number
  state: ReportState
  summary: string
  humanAction?: string
  prNumber: number
  prUrl: string
  reply?: string
  ackedInputs: string[]
  updatedAt: string
}

export interface WorkerMeta {
  ticketId: string
  assignmentId: string
  handle: string
  workdir: string
  repo?: string
  [key: string]: unknown
}

export interface PolledState {
  state: WorkerStateFile
  meta: WorkerMeta | null
  mtimeMs: number
}

export interface ReportPollerOptions {
  workersDir: string
  onState: (state: WorkerStateFile, meta: WorkerMeta | null, path: string) => void
  onError?: (ticketId: string, error: Error) => void
}

/** 轮询 ~/.router-agent/workers/<ticketId>/state.json，按文件内容增量上报。 */
export class ReportPoller {
  private workersDir: string
  private onState: ReportPollerOptions['onState']
  private onError?: ReportPollerOptions['onError']
  private seen = new Map<string, string>()

  constructor(opts: ReportPollerOptions) {
    this.workersDir = opts.workersDir
    this.onState = opts.onState
    this.onError = opts.onError
  }

  /** 扫描一轮，返回新上报数量。 */
  scan(): number {
    if (!existsSync(this.workersDir)) return 0
    let count = 0
    const entries = readdirSync(this.workersDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const ticketId = entry.name
      const statePath = join(this.workersDir, ticketId, 'state.json')
      if (!existsSync(statePath)) continue
      try {
        const content = readFileSync(statePath, 'utf8')
        const fingerprint = `${statSync(statePath).mtimeMs}:${content}`
        if (this.seen.get(ticketId) === fingerprint) continue
        const { ticketId: parsedId, state } = parseStateFile(content, ticketId)
        this.seen.set(ticketId, fingerprint)
        const meta = readMeta(this.workersDir, ticketId)
        this.onState({ ...state, ticketId: parsedId }, meta, statePath)
        count += 1
      } catch (error) {
        this.onError?.(ticketId, error instanceof Error ? error : new Error(String(error)))
      }
    }
    return count
  }

  /** 清空基线，让下一轮重新上报（Router 重启对账时用）。 */
  reset(): void {
    this.seen.clear()
  }
}

export function parseStateFile(content: string, expectedTicketId?: string): { ticketId: string; state: WorkerStateFile } {
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch {
    throw new Error('state:invalid-json')
  }
  const parsed = StateSchema.safeParse(json)
  if (!parsed.success) throw new Error(`state:invalid: ${parsed.error.issues.map(i => i.path.join('.')).join(',')}`)
  if (expectedTicketId && parsed.data.ticket_id !== expectedTicketId) {
    throw new Error(`state:ticket-mismatch: 目录 ${expectedTicketId} 收到 ${parsed.data.ticket_id}`)
  }
  const data = parsed.data
  const legacy = data.deliverable
  // 旧版 deliverable 升级成纯回复：正文 + 链接，不再保留 kind。
  const reply = data.reply.trim() || [legacy?.content?.trim(), legacy?.url?.trim()].filter(Boolean).join('\n\n')
  return {
    ticketId: data.ticket_id,
    state: {
      ticketId: data.ticket_id,
      assignmentId: data.assignment_id,
      turn: data.turn,
      state: data.state,
      summary: data.summary,
      ...(data.human_action ? { humanAction: data.human_action } : {}),
      prNumber: data.pr_number,
      prUrl: data.pr_url,
      ...(reply ? { reply } : {}),
      ackedInputs: data.acked_inputs,
      updatedAt: data.updated_at,
    },
  }
}

function readMeta(workersDir: string, ticketId: string): WorkerMeta | null {
  const path = join(workersDir, ticketId, 'meta.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as WorkerMeta
  } catch {
    return null
  }
}

export type IdleVerdict = 'active' | 'idle' | 'dead' | 'orphaned' | 'unknown'

/**
 * 基于 Orca 的结构化字段判定终端状态，绝不解析 TUI 屏幕文本。
 */
export function judgeIdle(input: {
  info: OrcaTerminalInfo | null
  turn: number
  lastTurn: number
  now: number
  idleAfterMs: number
}): IdleVerdict {
  const { info, turn, lastTurn, now, idleAfterMs } = input
  if (!info) return 'unknown'
  if (!info.connected) return 'dead'
  // 实测：CLI 创建的终端可能 orphaned=true 但依然 connected+writable，不能直接判死。
  if (info.orphaned && !info.writable) return 'orphaned'
  const lastOutput = Date.parse(info.lastOutputAt)
  if (Number.isFinite(lastOutput) && now - lastOutput > idleAfterMs && turn <= lastTurn) return 'idle'
  return 'active'
}

/** 追加一条审计事件到 events.log。 */
export function appendEvent(path: string, event: Record<string, unknown>): void {
  mkdirSync(join(path, '..'), { recursive: true })
  if (!existsSync(path)) writeFileSync(path, '', 'utf8')
  appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8')
}
