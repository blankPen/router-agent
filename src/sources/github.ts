import type { CommandRunner } from '../infra/process.js'

export interface PrInfo {
  number: number
  url: string
  state: 'open' | 'merged' | 'closed'
  title: string
  branch: string
  /** PR 描述正文；UI 证据门禁用它检查 Before / After。列表查询不返回时为 undefined。 */
  body?: string
}

function normalizeState(state: string): PrInfo['state'] {
  if (state === 'MERGED' || state === 'merged') return 'merged'
  if (state === 'CLOSED' || state === 'closed') return 'closed'
  return 'open'
}

function toPrInfo(raw: Record<string, unknown>): PrInfo | null {
  const number = Number(raw.number)
  if (!Number.isFinite(number) || number <= 0) return null
  return {
    number,
    url: String(raw.url ?? ''),
    state: normalizeState(String(raw.state ?? 'OPEN')),
    title: String(raw.title ?? ''),
    branch: String(raw.headRefName ?? ''),
    ...(typeof raw.body === 'string' ? { body: raw.body } : {}),
  }
}

export function parsePrView(stdout: string): PrInfo | null {
  if (!stdout.trim()) return null
  try {
    return toPrInfo(JSON.parse(stdout) as Record<string, unknown>)
  } catch {
    return null
  }
}

export function parsePrList(stdout: string): PrInfo | null {
  if (!stdout.trim()) return null
  try {
    const list = JSON.parse(stdout) as Record<string, unknown>[]
    const first = Array.isArray(list) ? list[0] : undefined
    return first ? toPrInfo(first) : null
  } catch {
    return null
  }
}

export function ghPrViewCommand(repo: string, number: number): string[] {
  return ['pr', 'view', String(number), '--repo', ghRepoOf(repo), '--json', 'number,url,state,title,headRefName,body']
}

/** 直接按 PR 链接查询：gh 自己解析 host/owner/repo，绕开项目名与 path 选择器。 */
export function ghPrViewUrlCommand(url: string): string[] {
  return ['pr', 'view', url, '--json', 'number,url,state,title,headRefName,body']
}

/** 不给 --repo，交给 gh 在 workdir 里从 git remote 推断仓库。 */
export function ghPrViewFromCwdCommand(number: number): string[] {
  return ['pr', 'view', String(number), '--json', 'number,url,state,title,headRefName,body']
}

/** 只有常规 GitHub PR 链接能交给 gh；GitLab MR 链接不要让 gh 去试。 */
export function isGithubPullRequestUrl(url: string): boolean {
  return /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?(?:[?#].*)?$/i.test(url.trim())
}

export interface PrViewHint {
  /** 完整 PR 链接：工单已经存了，优先用它，最可靠。 */
  url?: string
  /** 工单 workdir：repo 选择器（项目名 / id / path）无法直接映射 owner/name 时兜底。 */
  cwd?: string
}

export function ghPrListCommand(repo: string, branch: string): string[] {
  return ['pr', 'list', '--repo', ghRepoOf(repo), '--head', branch, '--state', 'all', '--json', 'number,url,state,title,headRefName', '--limit', '1']
}

/**
 * 工单里的仓库可能是 Orca 选择器（name:/id:/path:），gh 只认 owner/name。
 * path 选择器取路径最后两段（约定为 owner/repo 目录结构）。
 */
export function ghRepoOf(repo: string): string {
  const trimmed = repo.trim()
  if (trimmed.startsWith('path:')) {
    const parts = trimmed.slice('path:'.length).split('/').filter(Boolean)
    return parts.slice(-2).join('/')
  }
  return trimmed.replace(/^(id|name):/, '')
}

/** PR 状态跟踪：优先 Orca 的 linkedPR，取不到再用 gh 兜底。 */
export class GitHubTracker {
  constructor(private runner: CommandRunner) {}

  /**
   * 按 PR 链接 → owner/name → workdir 三级兜底查询。
   *
   * 工单里存的 repo 通常是项目名（如 `router-agent`）或 `path:` 选择器，
   * 都不是 gh 要的 `[HOST/]OWNER/REPO`；直接拼 `--repo` 会以 exit=1 失败，
   * 结果 PR 状态永远停在 open，合并后既不闭环又会被当成「PR 还开着」。
   */
  async view(repo: string, number: number, hint: PrViewHint = {}): Promise<PrInfo | null> {
    const url = hint.url?.trim() ?? ''
    if (url && isGithubPullRequestUrl(url)) {
      const byUrl = await this.runner.run(ghPrViewUrlCommand(url))
      const info = byUrl.code === 0 ? parsePrView(byUrl.stdout) : null
      if (info) return info
    }

    if (ghRepoOf(repo).includes('/')) {
      const res = await this.runner.run(ghPrViewCommand(repo, number))
      const info = res.code === 0 ? parsePrView(res.stdout) : null
      if (info) return info
    }

    // 裸项目名 / id 选择器 / 与实际目录结构不符的 path 选择器：交给 git remote 推断。
    if (hint.cwd) {
      const res = await this.runner.run(ghPrViewFromCwdCommand(number), { cwd: hint.cwd })
      if (res.code === 0) return parsePrView(res.stdout)
    }
    return null
  }

  async findByBranch(repo: string, branch: string): Promise<PrInfo | null> {
    const res = await this.runner.run(ghPrListCommand(repo, branch))
    return res.code === 0 ? parsePrList(res.stdout) : null
  }
}
