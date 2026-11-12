import type { CommandRunner } from '#infra/process.js'
import type { PrInfo, PrViewHint } from './github.js'
import { parseGitRemote, parseGitlabMergeRequestUrl } from './forge.js'

export interface GlabTarget {
  cwd?: string
  /** glab 接受 OWNER/REPO、GROUP/NAMESPACE/REPO 或完整 URL。 */
  repo?: string
}

/** GitLab 的 opened / locked 都还是打开状态，不能当成 closed，否则会误关单。 */
export function normalizeGitlabState(state: string): PrInfo['state'] {
  const value = state.trim().toLowerCase()
  if (value === 'merged') return 'merged'
  if (value === 'closed') return 'closed'
  return 'open'
}

function toPrInfo(raw: Record<string, unknown>): PrInfo | null {
  const number = Number(raw.iid ?? raw.number)
  if (!Number.isFinite(number) || number <= 0) return null
  return {
    number,
    url: String(raw.web_url ?? raw.url ?? ''),
    state: normalizeGitlabState(String(raw.state ?? 'opened')),
    title: String(raw.title ?? ''),
    branch: String(raw.source_branch ?? raw.headRefName ?? ''),
    ...(typeof raw.description === 'string' ? { body: raw.description } : {}),
  }
}

/** 解析 `glab mr view --output json`，兼容裸对象与 `{ merge_request: {...} }`。 */
export function parseGlabMrView(stdout: string): PrInfo | null {
  if (!stdout.trim()) return null
  try {
    const raw = JSON.parse(stdout) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const obj = raw as Record<string, unknown>
    const mr = obj.merge_request && typeof obj.merge_request === 'object' && !Array.isArray(obj.merge_request)
      ? obj.merge_request as Record<string, unknown>
      : obj
    return toPrInfo(mr)
  } catch {
    return null
  }
}

/** 解析 `glab mr list --output json`：兼容裸数组与 `{ merge_requests: [...] }`。 */
export function parseGlabMrList(stdout: string): PrInfo | null {
  if (!stdout.trim()) return null
  try {
    const parsed = JSON.parse(stdout) as unknown
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).merge_requests)
        ? (parsed as Record<string, unknown>).merge_requests as unknown[]
        : []
    const first = list[0]
    return first && typeof first === 'object' ? toPrInfo(first as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function glabMrViewCommand(number: number, target: GlabTarget = {}): string[] {
  return [
    'mr', 'view', String(number),
    '--output', 'json',
    ...(target.repo ? ['--repo', target.repo] : []),
  ]
}

export function glabMrListCommand(branch: string, target: GlabTarget = {}): string[] {
  return [
    'mr', 'list',
    '--source-branch', branch,
    // 默认只列 open，合并/关闭后也要能查到，才能触发闭环。
    '--all',
    '--output', 'json',
    ...(target.repo ? ['--repo', target.repo] : []),
  ]
}

/**
 * 有 workdir 时交给 glab 从 git remote 推断项目；
 * 没有 workdir 时从 MR 链接或仓库 URL 推导出完整 repo URL。
 */
function targetOf(selector: string, hint: PrViewHint = {}): GlabTarget | null {
  if (hint.cwd) return { cwd: hint.cwd }
  const mr = hint.url ? parseGitlabMergeRequestUrl(hint.url) : null
  if (mr) return { repo: `https://${mr.host}/${mr.path}` }
  const remote = parseGitRemote(selector)
  if (remote) return { repo: `https://${remote.host}/${remote.path}` }
  return null
}

/** GitLab MR 状态跟踪：与 GitHubTracker 对称，只是换成 glab。 */
export class GitLabTracker {
  constructor(private runner: CommandRunner) {}

  async view(repo: string, number: number, hint: PrViewHint = {}): Promise<PrInfo | null> {
    const target = targetOf(repo, hint)
    if (!target) return null
    const res = await this.runner.run(
      glabMrViewCommand(number, target),
      target.cwd ? { cwd: target.cwd } : {},
    )
    return res.code === 0 ? parseGlabMrView(res.stdout) : null
  }

  async findByBranch(repo: string, branch: string, hint: { cwd?: string } = {}): Promise<PrInfo | null> {
    const target = targetOf(repo, hint)
    if (!target) return null
    const res = await this.runner.run(
      glabMrListCommand(branch, target),
      target.cwd ? { cwd: target.cwd } : {},
    )
    return res.code === 0 ? parseGlabMrList(res.stdout) : null
  }
}
