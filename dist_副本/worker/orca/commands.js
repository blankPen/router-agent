export function worktreeCreate(opts) {
    return [
        'worktree', 'create',
        '--repo', repoSelector(opts.repo),
        '--name', opts.name,
        ...(opts.baseBranch ? ['--base-branch', opts.baseBranch] : []),
        '--agent', 'claude',
        // 必须是终端 surface：chat 会话不在 terminal list 里，send/close/inspect 都用不了。
        '--surface', 'terminal',
        '--prompt', opts.prompt,
        '--no-parent',
        '--setup', 'skip',
        '--json',
    ];
}
/**
 * 配置里可以写 Orca 的 displayName（如 `teamwork-repos`），
 * 也可以直接写完整选择器（`id:xxx` / `name:xxx` / `path:/abs`）。
 */
export function repoSelector(repo) {
    const trimmed = repo.trim();
    if (/^(id|name|path):/.test(trimmed))
        return trimmed;
    return `name:${trimmed}`;
}
export function terminalSend(handle, text) {
    return ['terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--json'];
}
export function terminalClose(handle) {
    return ['terminal', 'close', '--terminal', handle];
}
export function terminalList() {
    return ['terminal', 'list', '--json'];
}
export function worktreeShow(selector) {
    return ['worktree', 'show', '--worktree', selector, '--json'];
}
export function worktreeRemove(selector) {
    return ['worktree', 'rm', '--worktree', selector, '--force'];
}
export function agentLaunch(opts) {
    return ['agent', 'launch', '--agent', 'claude', '--worktree', opts.worktree, '--prompt', opts.prompt];
}
//# sourceMappingURL=commands.js.map