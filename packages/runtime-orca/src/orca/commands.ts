import { projectRepoPath } from '@router-agent/runtime'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface CommandRunner {
  run(argv: string[], opts?: { cwd?: string }): Promise<CommandResult>
}

export interface CreateOptions {
  repo: string
  name: string
  prompt: string
  /** worktree 的起始分支；不传则用仓库默认分支。 */
  baseBranch?: string
  /** 新 worktree 的 git 分支名（绕过 Orca 配置的用户前缀），用于语义化命名。 */
  branch?: string
  /** 启动哪个 Agent；留空 = 不传 --agent，由 Orca 自己的配置决定。 */
  agent?: string
}

export function worktreeCreate(opts: CreateOptions): string[] {
  return [
    'worktree', 'create',
    '--repo', repoSelector(opts.repo),
    '--name', opts.name,
    ...(opts.baseBranch ? ['--base-branch', opts.baseBranch] : []),
    ...(opts.branch ? ['--branch', opts.branch] : []),
    ...(opts.agent ? ['--agent', opts.agent] : []),
    // 必须是终端 surface：chat 会话不在 terminal list 里，send/close/inspect 都用不了。
    '--surface', 'terminal',
    '--prompt', opts.prompt,
    '--no-parent',
    '--setup', 'skip',
    '--json',
  ]
}

/**
 * Orca 的仓库选择器。
 *
 * 项目清单统一写本地仓库绝对路径，这里翻译成 Orca 的 `path:` 选择器；
 * 历史的 `name:` / `id:` 选择器（Orca 的 displayName / 项目 id）原样透传。
 */
export function repoSelector(repo: string): string {
  const trimmed = repo.trim()
  if (/^(id|name|path):/.test(trimmed)) return trimmed
  const path = projectRepoPath(trimmed)
  return path ? `path:${path}` : `name:${trimmed}`
}

/** 把本地目录登记成 Orca 项目；目录已登记时 Orca 直接返回原项目，幂等。 */
export function repoAdd(path: string): string[] {
  return ['repo', 'add', '--path', path, '--kind', 'git', '--json']
}

export function terminalSend(handle: string, text: string): string[] {
  return ['terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--json']
}

export function terminalClose(handle: string): string[] {
  return ['terminal', 'close', '--terminal', handle]
}

export function terminalList(): string[] {
  return ['terminal', 'list', '--json']
}

/** 读取渲染屏幕的尾部行；--screen 比默认的累计流更适合看「现在在做什么」。 */
export function terminalRead(handle: string, opts: { limit?: number } = {}): string[] {
  return ['terminal', 'read', '--terminal', handle, '--screen', '--limit', String(opts.limit ?? 60), '--json']
}

export function worktreeShow(selector: string): string[] {
  return ['worktree', 'show', '--worktree', selector, '--json']
}

export function worktreeRemove(selector: string, opts: { force?: boolean } = {}): string[] {
  return [
    'worktree', 'rm',
    '--worktree', selector,
    // 默认不强删：脏工作区由 Orca 拒绝，避免误删未提交改动。
    ...(opts.force ? ['--force'] : []),
    '--json',
  ]
}

export function agentLaunch(opts: { worktree: string; prompt: string; agent?: string }): string[] {
  return [
    'agent', 'launch',
    ...(opts.agent ? ['--agent', opts.agent] : []),
    '--worktree', opts.worktree,
    '--prompt', opts.prompt,
  ]
}
