/**
 * Herdr CLI 的 argv 构造。
 *
 * 只放纯函数：拼命令的地方集中在一处，adapter 与单测都从这里取。
 *
 * Herdr CLI 的约定（见 https://herdr.dev/docs/cli-reference）：
 * - 结果类命令把 JSON 打到 stdout；
 * - 失败时把 `{"id":…,"error":{"code":…,"message":…}}` 打到 stderr，退出码 1；
 * - `agent read` / `pane read` 例外：它们直接把终端文本打到 stdout，不是 JSON。
 */
import type { CommandResult, CommandRunner } from '../../../infra/process.js'

export type { CommandResult, CommandRunner }

/** `agent start` 的启动超时；Herdr 要求大于 3000 且不超过 300000 毫秒。 */
export const HERDR_AGENT_START_TIMEOUT_MS = 60_000

/** 在指定仓库下新建 worktree 检出，并把它开成一个 Herdr workspace。 */
export function worktreeCreate(opts: { cwd: string; branch: string; base?: string; label?: string }): string[] {
  return [
    'worktree', 'create',
    '--cwd', opts.cwd,
    '--branch', opts.branch,
    ...(opts.base ? ['--base', opts.base] : []),
    ...(opts.label ? ['--label', opts.label] : []),
    // 不抢焦点：Router 不是交互式终端，抢焦点会打断用户正在看的 Herdr 窗口。
    '--no-focus',
  ]
}

/**
 * 重新打开一个已经存在、但 workspace 已被关闭的 worktree 检出。
 *
 * `pane close` 会连带关掉 workspace，此时 `worktree remove --workspace` 会报
 * `workspace_not_found`；先 open 再 remove 才能真正删掉检出目录。
 */
export function worktreeOpen(opts: { cwd: string; branch: string; label?: string }): string[] {
  return [
    'worktree', 'open',
    '--cwd', opts.cwd,
    '--branch', opts.branch,
    ...(opts.label ? ['--label', opts.label] : []),
    '--no-focus',
  ]
}

export function worktreeRemove(workspaceId: string, opts: { force?: boolean } = {}): string[] {
  return ['worktree', 'remove', '--workspace', workspaceId, ...(opts.force ? ['--force'] : [])]
}

export function worktreeList(opts: { cwd?: string } = {}): string[] {
  return ['worktree', 'list', ...(opts.cwd ? ['--cwd', opts.cwd] : [])]
}

/** 在指定 pane 里启动 Agent；`args` 原样透传给 Agent 可执行文件。 */
export function agentStart(opts: {
  name: string
  kind: string
  pane: string
  timeoutMs?: number
  args?: string[]
}): string[] {
  return [
    'agent', 'start', opts.name,
    '--kind', opts.kind,
    '--pane', opts.pane,
    '--timeout', String(opts.timeoutMs ?? HERDR_AGENT_START_TIMEOUT_MS),
    // `--` 之后的参数原样交给 Agent；没有参数时不要多传一个裸 `--`。
    ...(opts.args?.length ? ['--', ...opts.args] : []),
  ]
}

/** 提交一条输入（Herdr 会补上 Enter）。 */
export function agentPrompt(target: string, text: string): string[] {
  return ['agent', 'prompt', target, text]
}

export function agentGet(target: string): string[] {
  return ['agent', 'get', target]
}

/** 读取终端渲染文本。`recent-unwrapped` 会展开软换行，适合看 Agent 的回复。 */
export function agentRead(target: string, opts: { lines?: number; source?: string } = {}): string[] {
  return [
    'agent', 'read', target,
    '--source', opts.source ?? 'recent-unwrapped',
    '--lines', String(opts.lines ?? 60),
  ]
}

export function agentList(): string[] {
  return ['agent', 'list']
}

export function paneClose(paneId: string): string[] {
  return ['pane', 'close', paneId]
}

export function serverStatus(): string[] {
  return ['status', 'server']
}

export function version(): string[] {
  return ['--version']
}
