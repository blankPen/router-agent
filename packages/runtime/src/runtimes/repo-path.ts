/**
 * 项目路径口径：所有运行时的项目清单统一写本地仓库绝对路径。
 *
 * - `/abs` 与 `path:/abs` 指同一个目录，`path:` 只是兼容写法；
 * - Orca 的 `name:` / `id:` 是历史写法：读取时原样保留，由 Orca 适配器透传给 Orca。
 */

/** 取本地仓库绝对路径：去掉 `path:` 前缀；不是本地路径时返回空串。 */
export function projectRepoPath(repo: string): string {
  const value = repo.trim().replace(/^path:/, '')
  return value.startsWith('/') ? value : ''
}

/** repo 是否是本地仓库绝对路径（`/abs` 或 `path:/abs`）。 */
export function isProjectRepoPath(repo: string): boolean {
  return projectRepoPath(repo) !== ''
}
