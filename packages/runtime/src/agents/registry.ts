/**
 * Agent 档案注册表：id 与外部工具的 agent id 对齐（orca --agent codex、ACP 的 agent 等）。
 *
 * 新增一种 Agent 只要在这里加一条档案 —— 会话读取与人工恢复都从档案里取，
 * 运行时与内核不需要知道具体是哪个 Agent。
 */
import { claudeSessionReader } from './claude.js'
import { codexSessionReader } from './codex.js'
import type { AgentProfile, AgentSessionReader } from './profile.js'

export const AGENT_PROFILES: readonly AgentProfile[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    resume: { command: 'claude', args: ['--resume', '{sessionId}'] },
    session: claudeSessionReader,
  },
  {
    id: 'codex',
    label: 'Codex',
    resume: {
      command: 'codex',
      args: ['resume', '{sessionId}'],
      note: 'Codex 会话恢复为 best-effort；若找不到会话，请在 worktree 内运行 codex resume 选择历史会话。',
    },
    session: codexSessionReader,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    resume: { command: 'opencode', args: ['--session', '{sessionId}'] },
  },
]

export function agentProfileOf(id?: string | null): AgentProfile | null {
  const value = String(id ?? '').trim()
  if (!value) return null
  return AGENT_PROFILES.find(profile => profile.id === value) ?? null
}

export interface ResolveSessionOptions {
  /** 各 Agent 的会话记录根目录覆盖（测试注入）。 */
  roots?: Record<string, string>
}

/** 命中的 Agent 档案与它的读取器。 */
export interface ResolvedSession {
  profile: AgentProfile
  reader: AgentSessionReader
}

/** 把读取器绑定到指定的数据根目录；读取时统一用它。 */
function bindRoot(reader: AgentSessionReader, root?: string): AgentSessionReader {
  if (!root) return reader
  return {
    latestSessionId: (workdir, opts) => reader.latestSessionId(workdir, { ...opts, root }),
    read: (workdir, opts) => reader.read(workdir, { ...opts, root }),
  }
}

/**
 * 解析某个 workdir 该用哪个会话读取器。
 *
 * 指定了 agent 就用它的档案；没指定（跟随运行时默认）时按注册表顺序探测，
 * 谁在这个 workdir 留下了会话记录就用谁 —— 这样运行时不必知道自己跑的是哪种 Agent。
 */
export function resolveSession(
  workdir: string,
  agentId?: string | null,
  opts: ResolveSessionOptions = {},
): ResolvedSession | null {
  if (!workdir) return null
  const profile = agentProfileOf(agentId)
  if (profile?.session) {
    // 指定了 agent 却还没落盘会话时，仍然用它的读取器：读不到由调用方退回终端屏幕。
    return { profile, reader: bindRoot(profile.session, opts.roots?.[profile.id]) }
  }
  if (agentId) return null
  for (const candidate of AGENT_PROFILES) {
    if (!candidate.session) continue
    const root = opts.roots?.[candidate.id]
    if (candidate.session.latestSessionId(workdir, root ? { root } : {})) {
      return { profile: candidate, reader: bindRoot(candidate.session, root) }
    }
  }
  return null
}

/** 找到 workdir 对应的会话 id；指定了 agent 就用它，否则自动探测。 */
export function resolveSessionId(
  workdir: string,
  agentId?: string | null,
  opts: ResolveSessionOptions = {},
): string | null {
  const resolved = resolveSession(workdir, agentId, opts)
  return resolved?.reader.latestSessionId(workdir) ?? null
}
