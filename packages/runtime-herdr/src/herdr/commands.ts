/**
 * Herdr CLI 的 argv 构造。
 *
 * 只放纯函数：拼命令的地方集中在一处，adapter 与单测都从这里取。
 *
 * Herdr CLI 的约定（见 https://herdr.dev/docs/cli-reference）：
 * - 结果类命令把 JSON 打到 stdout；
 * - 失败时把 `{"id":…,"error":{"code":…,"message":…}}` 打到 stderr，退出码 1；
 * - `agent read` / `pane read` 例外：它们直接把终端文本打到 stdout，不是 JSON。
 *
 * 检出与分支由 ra 自己用 git worktree 管（见 GitWorktreeProvider），
 * Herdr 只负责「在终端里跑 Agent」这件基础事 —— 所以这里没有 worktree 命令。
 */
import type { CommandResult, CommandRunner } from '@router-agent/infra/process.js'

export type { CommandResult, CommandRunner }

/** `agent start` 的启动超时；Herdr 要求大于 3000 且不超过 300000 毫秒。 */
export const HERDR_AGENT_START_TIMEOUT_MS = 60_000

/** 在指定目录上开一个 Herdr workspace；它会带出第一个 tab 与根 pane。 */
export function workspaceCreate(opts: { cwd: string; label?: string }): string[] {
  return [
    'workspace', 'create',
    '--cwd', opts.cwd,
    ...(opts.label ? ['--label', opts.label] : []),
    // 不抢焦点：Router 不是交互式终端，抢焦点会打断用户正在看的 Herdr 窗口。
    '--no-focus',
  ]
}

/** 关掉 workspace（连带它的 tab 与 pane）。 */
export function workspaceClose(workspaceId: string): string[] {
  return ['workspace', 'close', workspaceId]
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

// pane 级读取不要求 Agent 已被 Herdr 登记，因此「Agent 卡在启动前的确认弹窗」
// 这种状态也读得到 —— 判断「是否信任此文件夹」弹窗正需要它。
export function paneRead(paneId: string, opts: { lines?: number; source?: string } = {}): string[] {
  return [
    'pane', 'read', paneId,
    '--source', opts.source ?? 'visible',
    '--lines', String(opts.lines ?? 40),
  ]
}

export function agentList(): string[] {
  return ['agent', 'list']
}

/** 给 Agent 的交互界面发按键（enter / esc / down / ctrl+c …）。 */
export function agentSendKeys(target: string, keys: string[]): string[] {
  return ['agent', 'send-keys', target, ...keys]
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
