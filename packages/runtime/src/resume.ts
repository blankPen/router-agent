/**
 * 人工恢复命令的拼装与运行时映射。
 *
 * 恢复命令只依赖三件事：工作目录、底层 Agent 的真实 session id、该 Agent 的 CLI
 * 语法。这里用一张静态表把这些知识集中起来，不要求每个运行时实现额外方法。
 * 只生成 POSIX shell（sh/bash/zsh）可执行的一行命令；动态值全部单引号转义。
 */
import type { ResumeHint } from './port.js'
import { CLAUDE_CODE_RUNTIME_ID, ORCA_RUNTIME_ID, normalizeRuntimeId } from './runtimes/catalog.js'
import { agentProfileOf } from './agents/registry.js'

/** 单个运行时的 CLI 恢复模板。 */
export interface ResumeSpec {
  /** 有真实 sessionId 时执行的命令。 */
  command?: string
  /** 有真实 sessionId 时的参数模板，支持 {sessionId}。 */
  args?: readonly string[]
  /** 没有 sessionId、但有运行时 handle 时的备用命令；缺省复用 command。 */
  handleCommand?: string
  /** 没有 sessionId、但有运行时 handle 时的备用模板，支持 {handle}。 */
  handleArgs?: readonly string[]
  /** handle 兜底命令是否需要在 workdir 里执行；默认 true。Orca 的终端切换与目录无关。 */
  handleRequiresWorkdir?: boolean
  /** 有 sessionId 时附加的提示。 */
  note?: string
  /** 走 handle 备用模板时附加的提示。 */
  handleNote?: string
}

/**
 * 由 Agent 档案生成恢复模板：Agent 决定「用什么命令接回去」，
 * 运行时只补充自己的兜底（handle 接管方式）。
 */
function agentResumeSpec(agentId: string, extra: Partial<ResumeSpec> = {}): ResumeSpec {
  const template = agentProfileOf(agentId)?.resume
  const note = [template?.note, extra.note].filter(Boolean).join(' ')
  return {
    ...(template ? { command: template.command, args: template.args } : {}),
    ...extra,
    ...(note ? { note } : {}),
  }
}

/**
 * runtime id → CLI 恢复模板。
 *
 * 只收录已核实 session id 语义和 CLI 语法的运行时；未收录的运行时不出按钮，
 * 避免复制出打不开正确会话的命令。
 */
const RESUME_SPECS: Record<string, ResumeSpec> = {
  [CLAUDE_CODE_RUNTIME_ID]: agentResumeSpec('claude', {
    handleArgs: ['attach', '{handle}'],
    handleNote: '未读到 sessionId，改用 attach 接管后台会话。',
  }),
  'acp-claude': agentResumeSpec('claude'),
  'acp-codex': agentResumeSpec('codex'),
  'codex-app': agentResumeSpec('codex', {
    note: '也可以在 Codex 桌面端用 codex://threads/<threadId> 打开。',
  }),
  'acp-opencode': agentResumeSpec('opencode'),
}

/**
 * Orca 的恢复模板：用哪个 Agent 由配置决定，meta 里只有终端句柄。
 *
 * sessionId 由 service 按 workdir 从 Agent 自己的会话记录里补；
 * 找不到会话记录时退回 Orca 的终端切换命令，作为最后的兜底。
 */
function orcaResumeSpec(agentId?: string): ResumeSpec {
  const base = {
    handleCommand: 'orca',
    handleArgs: ['terminal', 'switch', '--terminal', '{handle}'],
    handleRequiresWorkdir: false,
    handleNote: '未找到 Agent 会话记录，改为在 Orca 中切回原终端。',
  }
  if (!agentId) return base
  return agentResumeSpec(agentId, {
    ...base,
    note: '按工作目录定位到的 Agent 会话恢复；接回的是普通终端会话，不再由 Orca 托管。',
  })
}

/** 按运行时 id 取恢复模板；未知/未核实返回 null。 */
export function resumeSpecOf(runtimeId: string, agentId?: string): ResumeSpec | null {
  const id = normalizeRuntimeId(runtimeId.trim())
  if (id === ORCA_RUNTIME_ID) return orcaResumeSpec(agentId)
  return RESUME_SPECS[id] ?? null
}

export interface ResumeSource {
  workdir?: string
  /** 底层 Agent 的真实会话 id；优先级最高。 */
  sessionId?: string
  /** 运行时自己的短句柄；没有 sessionId 时用于 attach 类命令。 */
  handle?: string
  /** 由外部决定用哪个 Agent 的运行时（如 Orca）需要它来选恢复命令。 */
  agentId?: string
}

/**
 * 根据运行时与会话信息生成恢复命令。
 *
 * @param workdirExists 由调用方传入，保持本模块为纯函数；false 时追加工作区提示。
 */
export function buildResumeHint(
  runtimeId: string,
  source: ResumeSource,
  opts: { workdirExists?: boolean } = {},
): ResumeHint | null {
  const spec = resumeSpecOf(runtimeId, source.agentId)
  if (!spec || !source.workdir) return null

  const useSession = Boolean(spec.command && spec.args && source.sessionId)
  // 没有单独的 handle 命令时，沿用 session 命令（例如 claude attach <handle>）。
  const handleCommand = spec.handleCommand ?? spec.command
  const useHandle = !useSession && Boolean(handleCommand && spec.handleArgs && source.handle)
  if (!useSession && !useHandle) return null

  const template = (useSession ? spec.args : spec.handleArgs)!
  const args = template.map(arg => arg
    .replaceAll('{sessionId}', source.sessionId ?? '')
    .replaceAll('{handle}', source.handle ?? ''))
  const command = useSession ? spec.command! : handleCommand!
  const requiresWorkdir = useSession || (spec.handleRequiresWorkdir ?? true)

  const note = [
    useSession ? spec.note : spec.handleNote,
    opts.workdirExists === false ? '工作目录已不存在，请先恢复 worktree 再执行。' : undefined,
  ].filter((item): item is string => Boolean(item)).join(' ')

  return {
    command: requiresWorkdir ? resumeCommand(source.workdir, command, args) : commandLine(command, args),
    ...(useSession && source.sessionId ? { sessionId: source.sessionId } : {}),
    ...(note ? { note } : {}),
  }
}

/** 单引号转义；内部单引号写成 '\''。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * 生成 `cd <workdir> && <command> <args...>`。
 *
 * `command` 只应来自上面的可信常量，不作为用户输入参与转义；workdir 与参数一律转义。
 */
export function resumeCommand(workdir: string, command: string, args: readonly string[] = []): string {
  return `cd ${shellQuote(workdir)} && ${commandLine(command, args)}`
}

/** 不带 cd 的一行命令；参数逐个转义。 */
function commandLine(command: string, args: readonly string[] = []): string {
  const tail = args.map(shellQuote).join(' ')
  return `${command}${tail ? ` ${tail}` : ''}`
}
