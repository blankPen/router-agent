import type { ToolPolicy } from '../port.js'

/** ACP 的 ToolKind 取值（允许后端扩展，未知值按 other 处理）。 */
export type AcpToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other'

export interface AcpToolCallInfo {
  toolCallId: string
  title?: string
  kind?: string
  rawInput?: unknown
  locations?: Array<{ path?: string }>
}

export interface AcpPermissionOption {
  optionId: string
  name?: string
  kind: string
}

export function decidePermission(
  tools: ToolPolicy,
  toolCall: AcpToolCallInfo,
  options: AcpPermissionOption[],
): AcpPermissionOption | null {
  const kind = normalizeKind(toolCall.kind)
  const allowed = isAllowed(tools, kind, toolCall)
  const desired = allowed ? 'allow' : 'reject'
  return options.find(option => option.kind.startsWith(desired)) ?? null
}

export function isAllowed(tools: ToolPolicy, kind: AcpToolKind, toolCall: AcpToolCallInfo): boolean {
  switch (kind) {
    case 'read':
    case 'search':
    case 'think':
      return true
    case 'fetch':
      return tools.allowNetwork
    case 'edit':
    case 'move':
    case 'delete':
      return tools.fileAccess === 'read-write'
    case 'execute':
      return shellAllowed(tools, commandOf(toolCall))
    case 'other':
    default:
      return tools.fileAccess === 'read-write'
  }
}

export function shellAllowed(tools: ToolPolicy, command: string | null): boolean {
  if (tools.shell === 'deny') return false
  if (tools.shell === 'allow') return true
  if (!command) return false
  return (tools.shellAllow ?? []).some(prefix => {
    const value = prefix.trim()
    if (!value) return false
    return command === value || command.startsWith(`${value} `)
  })
}

export function commandOf(toolCall: AcpToolCallInfo): string | null {
  const raw = toolCall.rawInput
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>
    if (typeof record.command === 'string') return record.command.trim() || null
    if (Array.isArray(record.command) && record.command.every(item => typeof item === 'string')) {
      return (record.command as string[]).join(' ').trim() || null
    }
    const argv = record.argv ?? record.args
    if (Array.isArray(argv) && argv.every(item => typeof item === 'string')) {
      return (argv as string[]).join(' ').trim() || null
    }
  }
  if (typeof toolCall.title === 'string') return toolCall.title.trim() || null
  return null
}

function normalizeKind(kind: string | undefined): AcpToolKind {
  switch (kind) {
    case 'read':
    case 'edit':
    case 'delete':
    case 'move':
    case 'search':
    case 'execute':
    case 'think':
    case 'fetch':
      return kind
    default:
      return 'other'
  }
}
