import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { SessionEvent, SessionSnapshot } from '../port.js'

/** Claude Code 默认把会话记录写在这里。 */
export function defaultClaudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects')
}

/** Claude Code 把 cwd 里所有非字母数字字符替换成 `-` 作为项目目录名。 */
export function claudeProjectSlug(workdir: string): string {
  return workdir.replace(/[^a-zA-Z0-9]/g, '-')
}

export interface ReadSessionOptions {
  projectsDir?: string
  /** 只读文件尾部这么多字节，避免把几 MB 的会话全量读进内存。 */
  maxBytes?: number
  /** 最多保留多少条最近活动。 */
  maxEvents?: number
  /** 精确匹配会话 ID；找不到时返回 null，不退化成「最新文件」。 */
  sessionId?: string
}

/**
 * 读取某个 workdir 对应 Claude Code 会话的最新活动。
 *
 * 优先用 Agent 自己的结构化会话记录，而不是终端渲染屏幕：
 * 这里只有 assistant 文本与工具调用，没有 TUI 状态栏、spinner 和输入回显。
 * 找不到会话（非 Claude 后端 / 文件尚未落盘）时返回 null，调用方退回终端读取。
 */
export function readClaudeSession(workdir: string, opts: ReadSessionOptions = {}): SessionSnapshot | null {
  if (!workdir) return null
  const projectsDir = opts.projectsDir ?? defaultClaudeProjectsDir()
  const dir = join(projectsDir, claudeProjectSlug(workdir))
  if (!existsSync(dir)) return null

  let files: string[]
  try {
    files = readdirSync(dir).filter(file => file.endsWith('.jsonl'))
  } catch {
    return null
  }
  if (files.length === 0) return null

  if (opts.sessionId) {
    const exact = files.find(file => file === `${opts.sessionId}.jsonl` || file.includes(opts.sessionId!))
    if (!exact) return null
    files = [exact]
  }

  const latest = files
    .map(file => {
      const path = join(dir, file)
      try {
        return { path, mtime: statSync(path).mtimeMs }
      } catch {
        return { path, mtime: 0 }
      }
    })
    .sort((a, b) => b.mtime - a.mtime)[0]!

  const maxBytes = opts.maxBytes ?? 512 * 1024
  const maxEvents = opts.maxEvents ?? 40
  const events: SessionEvent[] = []
  let at = ''
  let sessionId = ''

  for (const line of readTailLines(latest.path, maxBytes)) {
    let record: Record<string, any>
    try {
      record = JSON.parse(line) as Record<string, any>
    } catch {
      continue
    }
    if (record?.type !== 'assistant') continue
    const timestamp = typeof record.timestamp === 'string' ? record.timestamp : ''
    const content = record.message?.content
    if (!timestamp || !Array.isArray(content)) continue

    const before = events.length
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text') {
        const text = String(block.text ?? '').trim()
        if (text) events.push({ at: timestamp, kind: 'text', text })
      } else if (block.type === 'tool_use') {
        events.push({
          at: timestamp,
          kind: 'tool',
          text: describeToolUse(block.name, block.input),
          tool: describeToolInfo(block.name, block.input),
        })
      }
    }
    if (events.length > before) {
      at = timestamp
      if (typeof record.sessionId === 'string') sessionId = record.sessionId
    }
  }

  if (events.length === 0) return null
  return {
    at,
    events: events.slice(-maxEvents),
    ...(sessionId ? { sessionId } : {}),
    filePath: latest.path,
  }
}

/** 从文件尾部读有界的一段；首行可能被截断，直接丢弃。 */
function readTailLines(path: string, maxBytes: number): string[] {
  const size = statSync(path).size
  const start = Math.max(0, size - maxBytes)
  const length = size - start
  if (length <= 0) return []
  const buffer = Buffer.alloc(length)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buffer, 0, length, start)
  } finally {
    closeSync(fd)
  }
  const lines = buffer.toString('utf8').split('\n')
  if (start > 0) lines.shift()
  return lines.filter(line => line.trim().length > 0)
}

/** 工具调用的结构化摘要：只保留「工具名 + 目标」，不把完整命令 / 文件内容带进话题。 */
export interface ToolInfo {
  name: string
  target?: string
}

/** 从工具名与入参里提炼结构化目标，供进展巡检生成语义摘要。 */
export function describeToolInfo(name: unknown, input: unknown): ToolInfo {
  const tool = String(name ?? 'tool')
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const file = typeof args.file_path === 'string' ? basename(args.file_path) : ''
  const target = (value: unknown): { target: string } | Record<string, never> => {
    const text = oneLine(value)
    return text ? { target: text } : {}
  }
  switch (tool) {
    case 'Bash':
      return { name: 'Bash', ...target(args.description ?? args.command) }
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { name: tool, ...(file ? { target: file } : {}) }
    case 'Grep':
    case 'Glob':
      return { name: tool, ...target(args.pattern) }
    case 'Task':
      return { name: 'Task', ...target(args.description) }
    default:
      return { name: tool }
  }
}

/** 把工具调用压成一行人话；不把完整命令 / 文件内容带进话题。 */
export function describeToolUse(name: unknown, input: unknown): string {
  const info = describeToolInfo(name, input)
  switch (info.name) {
    case 'Bash':
      return `Bash：${info.target ?? '执行命令'}`
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return info.target ? `${info.name}(${info.target})` : info.name
    case 'Grep':
    case 'Glob':
      return `${info.name}(${info.target ?? '搜索'})`
    case 'Task':
      return `Task：${info.target ?? '子任务'}`
    default:
      return info.name
  }
}

function oneLine(value: unknown): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= 160 ? text : `${text.slice(0, 160)}…`
}