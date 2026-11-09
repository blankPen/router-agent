/**
 * 人工恢复命令的拼装与运行时映射。
 *
 * 恢复命令只依赖三件事：工作目录、底层 Agent 的真实 session id、该 Agent 的 CLI
 * 语法。这里用一张静态表把这些知识集中起来，不要求每个运行时实现额外方法。
 * 只生成 POSIX shell（sh/bash/zsh）可执行的一行命令；动态值全部单引号转义。
 */
import type { ResumeHint } from './port.js'
import { CLAUDE_CODE_RUNTIME_ID, ORCA_RUNTIME_ID, normalizeRuntimeId } from './runtimes/catalog.js'

/** 单个运行时的 CLI 恢复模板。 */
export interface ResumeSpec {
  /** 有真实 sessionId 时执行的命令。 */
  command: string
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
 * runtime id → CLI 恢复模板。
 *
 * 只收录已核实 session id 语义和 CLI 语法的运行时；未收录的运行时不出按钮，
 * 避免复制出打不开正确会话的命令。
 */
const RESUME_SPECS: Record<string, ResumeSpec> = {
  [CLAUDE_CODE_RUNTIME_ID]: {
    command: 'claude',
    args: ['--resume', '{sessionId}'],
    handleArgs: ['attach', '{handle}'],
    handleNote: '未读到 sessionId，改用 attach 接管后台会话。',
  },
  // Orca 的 meta 只存终端句柄，sessionId 由 service 按 workdir 从 Claude 会话记录里补；
  // 找不到会话记录时退回 Orca 自己的终端切换命令，作为最后的兜底。
  [ORCA_RUNTIME_ID]: {
    command: 'claude',
    args: ['--resume', '{sessionId}'],
    handleCommand: 'orca',
    handleArgs: ['terminal', 'switch', '--terminal', '{handle}'],
    handleRequiresWorkdir: false,
    note: '按工作目录定位到的 Claude 会话恢复；接回的是普通终端会话，不再由 Orca 托管。',
    handleNote: '未找到 Claude 会话记录，改为在 Orca 中切回原终端。',
  },
  'acp-claude': {
    command: 'claude',
    args: ['--resume', '{sessionId}'],
  },
  'acp-codex': {
    command: 'codex',
    args: ['resume', '{sessionId}'],
    note: 'Codex 会话恢复为 best-effort；若找不到会话，请在 worktree 内运行 codex resume 选择历史会话。',
  },
  'acp-opencode': {
    command: 'opencode',
    args: ['--session', '{sessionId}'],
  },
}

/** 按运行时 id 取恢复模板；未知/未核实返回 null。 */
export function resumeSpecOf(runtimeId: string): ResumeSpec | null {
  return RESUME_SPECS[normalizeRuntimeId(runtimeId.trim())] ?? null
}

export interface ResumeSource {
  workdir?: string
  /** 底层 Agent 的真实会话 id；优先级最高。 */
  sessionId?: string
  /** 运行时自己的短句柄；没有 sessionId 时用于 attach 类命令。 */
  handle?: string
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
  const spec = resumeSpecOf(runtimeId)
  if (!spec || !source.workdir) return null

  const useSession = Boolean(spec.args && source.sessionId)
  const useHandle = !useSession && Boolean(spec.handleArgs && source.handle)
  if (!useSession && !useHandle) return null

  const template = (useSession ? spec.args : spec.handleArgs)!
  const args = template.map(arg => arg
    .replaceAll('{sessionId}', source.sessionId ?? '')
    .replaceAll('{handle}', source.handle ?? ''))
  const command = useSession ? spec.command : (spec.handleCommand ?? spec.command)
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