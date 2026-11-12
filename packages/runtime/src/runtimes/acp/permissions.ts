import type { ToolPolicy } from '../../port.js'

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

/**
 * 根据中立 ToolPolicy 选择一个权限选项。
 *
 * 返回 null 表示没有可用的 allow/reject 选项，调用方应回 `cancelled`。
 * 决策原则是「最小权限」：读/搜/思考默认放行，写类看 fileAccess，执行看 shell 策略，网络看 allowNetwork。
 */
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

/** 判断一次工具调用在当前策略下是否放行。 */
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
      // 未知工具只在可写工作区放行，避免误放行破坏性操作。
      return tools.fileAccess === 'read-write'
  }
}

/** shell 策略：deny 全拒；allow 全放；allowlist 按命令前缀匹配。 */
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

/** 尽量从 toolCall 的 rawInput / title 里还原出要执行的命令。 */
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