import type { CommandRunner } from '../infra/process.js'

export interface PrInfo {
  number: number
  url: string
  state: 'open' | 'merged' | 'closed'
  title: string
  branch: string
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
  return ['pr', 'view', String(number), '--repo', ghRepoOf(repo), '--json', 'number,url,state,title,headRefName']
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

  async view(repo: string, number: number): Promise<PrInfo | null> {
    const res = await this.runner.run(ghPrViewCommand(repo, number))
    return res.code === 0 ? parsePrView(res.stdout) : null
  }

  async findByBranch(repo: string, branch: string): Promise<PrInfo | null> {
    const res = await this.runner.run(ghPrListCommand(repo, branch))
    return res.code === 0 ? parsePrList(res.stdout) : null
  }
}
