import type { CommandRunner } from '../infra/process.js'
import { isGithubPullRequestUrl, type GitHubTracker, type PrInfo, type PrViewHint } from './github.js'
import type { GitLabTracker } from './gitlab.js'
import { isGitlabMergeRequestUrl, parseGitRemote } from './forge.js'

type Forge = 'github' | 'gitlab' | 'none'

export interface ForgeTrackerOptions {
  github: GitHubTracker
  gitlab: GitLabTracker
  /** 读取 worktree 的 git remote；缺省时无法做 host 判断。 */
  git?: CommandRunner
}

/**
 * 按「MR/PR 链接 → git remote 主机」的顺序选择跟踪器。
 *
 * 关键点：GitLab 仓库的 `group/repo` 不能交给 `gh`，否则 gh 会默认去查 github.com，
 * 同名仓库存在时还可能误读状态。读不到 remote 的本地路径直接放弃，不再猜。
 */
export class ForgeTracker {
  constructor(private opts: ForgeTrackerOptions) {}

  async view(repo: string, number: number, hint: PrViewHint = {}): Promise<PrInfo | null> {
    const target = await this.resolve(repo, hint)
    if (target.forge === 'none') return null
    return target.forge === 'gitlab'
      ? this.opts.gitlab.view(target.repo, number, hint)
      : this.opts.github.view(target.repo, number, hint)
  }

  async findByBranch(repo: string, branch: string, hint: { cwd?: string } = {}): Promise<PrInfo | null> {
    const target = await this.resolve(repo, hint)
    if (target.forge === 'none') return null
    return target.forge === 'gitlab'
      ? this.opts.gitlab.findByBranch(target.repo, branch, hint)
      : this.opts.github.findByBranch(target.repo, branch)
  }

  private async resolve(repo: string, hint: { url?: string; cwd?: string }): Promise<{ forge: Forge; repo: string }> {
    if (hint.url && isGitlabMergeRequestUrl(hint.url)) return { forge: 'gitlab', repo }
    if (hint.url && isGithubPullRequestUrl(hint.url)) return { forge: 'github', repo }

    if (hint.cwd && this.opts.git) {
      const remote = await this.remoteOf(hint.cwd)
      const parsed = remote ? parseGitRemote(remote) : null
      if (parsed) {
        // 自建 GitLab 域名不一定带 gitlab，非 GitHub 主机都按 GitLab 再试一次；
        // 失败只会返回 null，不会影响 GitHub 仓库。
        return { forge: parsed.forge === 'github' ? 'github' : 'gitlab', repo: parsed.path }
      }
    }

    // 本地路径但读不到 remote：不要再用路径末两段猜 owner/repo。
    if (repo.startsWith('/') || repo.startsWith('path:')) return { forge: 'none', repo }
    return { forge: 'github', repo }
  }

  private async remoteOf(cwd: string): Promise<string | null> {
    const res = await this.opts.git!.run(['remote', 'get-url', 'origin'], { cwd })
    return res.code === 0 ? res.stdout.trim() : null
  }
}
