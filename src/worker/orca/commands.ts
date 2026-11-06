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
}

export function worktreeCreate(opts: CreateOptions): string[] {
  return [
    'worktree', 'create',
    '--repo', repoSelector(opts.repo),
    '--name', opts.name,
    ...(opts.baseBranch ? ['--base-branch', opts.baseBranch] : []),
    ...(opts.branch ? ['--branch', opts.branch] : []),
    '--agent', 'claude',
    // 必须是终端 surface：chat 会话不在 terminal list 里，send/close/inspect 都用不了。
    '--surface', 'terminal',
    '--prompt', opts.prompt,
    '--no-parent',
    '--setup', 'skip',
    '--json',
  ]
}

/**
 * 配置里可以写 Orca 的 displayName（如 `teamwork-repos`），
 * 也可以直接写完整选择器（`id:xxx` / `name:xxx` / `path:/abs`）。
 */
export function repoSelector(repo: string): string {
  const trimmed = repo.trim()
  if (/^(id|name|path):/.test(trimmed)) return trimmed
  return `name:${trimmed}`
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

export function worktreeShow(selector: string): string[] {
  return ['worktree', 'show', '--worktree', selector, '--json']
}

export function worktreeRemove(selector: string): string[] {
  return ['worktree', 'rm', '--worktree', selector, '--force']
}

export function agentLaunch(opts: { worktree: string; prompt: string }): string[] {
  return ['agent', 'launch', '--agent', 'claude', '--worktree', opts.worktree, '--prompt', opts.prompt]
}
