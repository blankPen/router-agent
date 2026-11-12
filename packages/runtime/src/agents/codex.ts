/**
 * Codex 的会话记录读取。
 *
 * Codex 把每次会话写成 `~/.codex/sessions/<年>/<月>/<日>/rollout-<时间>-<uuid>.jsonl`：
 * 目录按日期分，不像 Claude 那样按项目分，所以要靠首行的 `session_meta.cwd` 反查
 * 「哪个会话属于这个 worktree」。
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent, SessionSnapshot } from '../port.js'
import type { AgentSessionReader } from './profile.js'

/** Codex 的数据根目录。 */
export function defaultCodexHome(): string {
  return join(homedir(), '.codex')
}

/** 最多检查多少个 rollout 文件；按 mtime 从新到旧找，超出就不再往下翻。 */
const MAX_CANDIDATES = 300

/** 查找结果的短缓存：一次巡检里「找会话」与「读会话」会连着调两次。 */
const LOOKUP_TTL_MS = 5_000
const lookupCache = new Map<string, { found: { path: string; sessionId: string } | null; at: number }>()

interface RolloutCandidate {
  path: string
  mtime: number
}

/** 会话文件的首行：session_meta 里带 session_id 与 cwd。 */
interface SessionMeta {
  sessionId: string
  cwd: string
}

function sessionsRoot(root: string): string {
  return join(root, 'sessions')
}

/** 收集 rollout 文件（年/月/日 三层目录），按 mtime 从新到旧排序。 */
function collectRollouts(root: string): RolloutCandidate[] {
  const base = sessionsRoot(root)
  if (!existsSync(base)) return []
  const candidates: RolloutCandidate[] = []
  let years: string[]
  try {
    years = readdirSync(base)
  } catch {
    return []
  }
  for (const year of years) {
    const yearDir = join(base, year)
    let months: string[]
    try {
      months = readdirSync(yearDir)
    } catch {
      continue
    }
    for (const month of months) {
      const monthDir = join(yearDir, month)
      let days: string[]
      try {
        days = readdirSync(monthDir)
      } catch {
        continue
      }
      for (const day of days) {
        const dayDir = join(monthDir, day)
        let files: string[]
        try {
          files = readdirSync(dayDir)
        } catch {
          continue
        }
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue
          const path = join(dayDir, file)
          try {
            candidates.push({ path, mtime: statSync(path).mtimeMs })
          } catch {
            // 读不到 mtime 的文件排在最后。
          }
        }
      }
    }
  }
  return candidates.sort((a, b) => b.mtime - a.mtime)
}

/** 读首行解析 session_meta。 */
function readSessionMeta(path: string): SessionMeta | null {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    const firstLine = buffer.toString('utf8', 0, read).split('\n')[0] ?? ''
    const record = JSON.parse(firstLine) as Record<string, any>
    if (record?.type !== 'session_meta') return null
    const payload = (record.payload ?? {}) as Record<string, any>
    const sessionId = String(payload.session_id ?? payload.id ?? '')
    const cwd = String(payload.cwd ?? '')
    if (!sessionId || !cwd) return null
    return { sessionId, cwd }
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** 找到属于这个 workdir 的最近一次 Codex 会话。 */
export function findCodexSession(
  workdir: string,
  opts: { root?: string; sessionId?: string } = {},
): { path: string; sessionId: string } | null {
  if (!workdir) return null
  const root = opts.root ?? defaultCodexHome()
  const cacheKey = `${root}\u0000${workdir}\u0000${opts.sessionId ?? ''}`
  const cached = lookupCache.get(cacheKey)
  const now = Date.now()
  if (cached && now - cached.at < LOOKUP_TTL_MS) return cached.found
  const found = scanCodexSession(workdir, root, opts.sessionId)
  lookupCache.set(cacheKey, { found, at: now })
  return found
}

/** 扫描 rollout 目录，找到 cwd 匹配且最近的一次会话。 */
function scanCodexSession(
  workdir: string,
  root: string,
  sessionId?: string,
): { path: string; sessionId: string } | null {
  for (const candidate of collectRollouts(root).slice(0, MAX_CANDIDATES)) {
    const meta = readSessionMeta(candidate.path)
    if (!meta || meta.cwd !== workdir) continue
    if (sessionId && meta.sessionId !== sessionId) continue
    return { path: candidate.path, sessionId: meta.sessionId }
  }
  return null
}

/** 按 workdir 找最近一次 Codex 会话的 id。 */
export function latestCodexSessionId(workdir: string, opts: { root?: string } = {}): string | null {
  return findCodexSession(workdir, opts)?.sessionId ?? null
}

/** Codex 的工具调用摘要：只留「工具名 + 目标」，不把完整命令带进话题。 */
export interface CodexToolInfo {
  name: string
  target?: string
}

export function describeCodexToolInfo(name: unknown, args: unknown): CodexToolInfo {
  const tool = String(name ?? 'tool')
  const input = parseArgs(args)
  const target = oneLine(input.cmd ?? input.command ?? input.path ?? input.file_path ?? '')
  switch (tool) {
    case 'exec_command':
    case 'shell':
    case 'local_shell':
      return { name: tool, ...(target ? { target } : {}) }
    case 'apply_patch':
    case 'read_file':
    case 'write_file':
    case 'view_file':
      return { name: tool, ...(target ? { target } : {}) }
    default:
      return { name: tool }
  }
}

export function describeCodexToolUse(name: unknown, args: unknown): string {
  const info = describeCodexToolInfo(name, args)
  return info.target ? `${info.name}(${info.target})` : info.name
}

/**
 * 读取某个 workdir 对应 Codex 会话的最新活动。
 *
 * 只取 assistant 文本与工具调用；reasoning 摘要与 usage 记录不进话题。
 */
export function readCodexSession(
  workdir: string,
  opts: { root?: string; maxBytes?: number; maxEvents?: number; sessionId?: string } = {},
): SessionSnapshot | null {
  if (!workdir) return null
  const root = opts.root ?? defaultCodexHome()
  const found = findCodexSession(workdir, {
    root,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  })
  if (!found) return null

  const maxBytes = opts.maxBytes ?? 512 * 1024
  const maxEvents = opts.maxEvents ?? 40
  const events: SessionEvent[] = []
  let at = ''

  for (const line of readTailLines(found.path, maxBytes)) {
    let record: Record<string, any>
    try {
      record = JSON.parse(line) as Record<string, any>
    } catch {
      continue
    }
    if (record?.type !== 'response_item') continue
    const timestamp = typeof record.timestamp === 'string' ? record.timestamp : ''
    const payload = (record.payload ?? {}) as Record<string, any>
    if (!timestamp) continue

    if (payload.type === 'message' && payload.role === 'assistant') {
      const content = Array.isArray(payload.content) ? payload.content : []
      const before = events.length
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        if (block.type !== 'output_text') continue
        const text = String(block.text ?? '').trim()
        if (text) events.push({ at: timestamp, kind: 'text', text })
      }
      if (events.length > before) at = timestamp
      continue
    }

    if (payload.type === 'function_call') {
      events.push({
        at: timestamp,
        kind: 'tool',
        text: describeCodexToolUse(payload.name, payload.arguments),
        tool: describeCodexToolInfo(payload.name, payload.arguments),
      })
      at = timestamp
    }
  }

  if (events.length === 0) return null
  return {
    at,
    events: events.slice(-maxEvents),
    sessionId: found.sessionId,
    filePath: found.path,
  }
}

/** 从文件尾部读有界的一段；首行可能被截断，直接丢弃。 */
function readTailLines(path: string, maxBytes: number): string[] {
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return []
  }
  const start = Math.max(0, size - maxBytes)
  const length = size - start
  if (length <= 0) return []
  const buffer = Buffer.alloc(length)
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return []
  }
  try {
    readSync(fd, buffer, 0, length, start)
  } finally {
    closeSync(fd)
  }
  const lines = buffer.toString('utf8').split('\n')
  if (start > 0) lines.shift()
  return lines.filter(line => line.trim().length > 0)
}

function parseArgs(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object') return args as Record<string, unknown>
  if (typeof args !== 'string') return {}
  try {
    const parsed = JSON.parse(args)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function oneLine(value: unknown): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= 160 ? text : `${text.slice(0, 160)}…`
}

/** Codex 的会话记录读取器。 */
export const codexSessionReader: AgentSessionReader = {
  latestSessionId(workdir, opts) {
    return latestCodexSessionId(workdir, opts?.root ? { root: opts.root } : {})
  },
  read(workdir, opts) {
    return readCodexSession(workdir, {
      ...(opts?.root ? { root: opts.root } : {}),
      ...(opts?.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
      ...(opts?.maxEvents !== undefined ? { maxEvents: opts.maxEvents } : {}),
      ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
    })
  },
}
