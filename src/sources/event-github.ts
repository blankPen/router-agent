import { createHmac, timingSafeEqual } from 'node:crypto'
import type { CommandRunner } from '#infra/process.js'
import type { EventEnvelope, EventSource } from '#core/event.js'

/** 轮询游标的存放位置；Store 的游标读写正好满足这个形状。 */
export interface CursorStore {
  getCursor(key: string): string | null
  setCursor(key: string, value: string, at: string): void
}

/** 一条 Issue 的最小信息。 */
export interface IssueBrief {
  number: number
  title: string
  body: string
  url: string
  updatedAt: string
  author: string
  labels: string[]
}

/** 轮询一次最多拉多少条。 */
export const ISSUE_POLL_LIMIT = 50

/** gh 命令：按仓库、状态、标签与增量游标拉 Issue。 */
export function ghIssueListCommand(
  repo: string,
  state: string,
  search: string,
  labels: string[],
  limit: number,
): string[] {
  const argv = [
    'issue', 'list',
    '--repo', repo,
    '--state', state || 'open',
    '--json', 'number,title,body,url,updatedAt,author,labels',
    '--limit', String(limit),
  ]
  if (search) argv.push('--search', search)
  for (const label of labels) argv.push('--label', label)
  return argv
}

/** 解析 gh issue list 的输出；不是合法 JSON 时返回空列表。 */
export function parseIssueList(stdout: string): IssueBrief[] {
  if (!stdout.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const issues: IssueBrief[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const number = Number(row.number)
    if (!Number.isFinite(number) || number <= 0) continue
    const labels = Array.isArray(row.labels)
      ? row.labels.map(label => {
        const entry = label as Record<string, unknown>
        return typeof entry?.name === 'string' ? entry.name : ''
      }).filter(Boolean)
      : []
    const author = row.author && typeof row.author === 'object'
      ? String((row.author as Record<string, unknown>).login ?? '')
      : ''
    issues.push({
      number,
      title: String(row.title ?? ''),
      body: String(row.body ?? ''),
      url: String(row.url ?? ''),
      updatedAt: String(row.updatedAt ?? ''),
      author,
      labels,
    })
  }
  return issues
}

/** 校验 GitHub 的 `X-Hub-Signature-256`；常量时间比较，避免时序泄漏。 */
export function verifyGithubSignature(secret: string, body: string, signature: string): boolean {
  if (!secret || !signature.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret).update(body).digest('hex')
  const given = signature.slice('sha256='.length)
  if (given.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given, 'hex'))
}

/** webhook 事件映射的产物：还差来源配置才能变成完整事件。 */
export interface GithubWebhookDraft {
  type: string
  externalId: string
  subject: string
  summary: string
  body: string
  link: string
  author: string
  repo: string
}

/** 把 GitHub webhook 负载映射成事件草稿；心跳与不关心的动作返回 null。 */
export function mapGithubWebhook(body: string, deliveryId: string, eventName: string): GithubWebhookDraft | null {
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(body) as Record<string, unknown>
  } catch {
    return null
  }
  const repo = String((payload.repository as Record<string, unknown> | undefined)?.full_name ?? '')
  const action = String(payload.action ?? '')
  if (eventName === 'issue_comment') {
    const issue = payload.issue as Record<string, unknown> | undefined
    if (!issue) return null
    const number = Number(issue.number)
    if (!Number.isFinite(number)) return null
    const comment = payload.comment as Record<string, unknown> | undefined
    return {
      type: 'issue.comment',
      externalId: deliveryId,
      subject: `${repo}#${number}`,
      summary: String(issue.title ?? ''),
      body: String(comment?.body ?? ''),
      link: String(comment?.html_url ?? issue.html_url ?? ''),
      author: String((comment?.user as Record<string, unknown> | undefined)?.login ?? ''),
      repo,
    }
  }
  if (eventName !== 'issues') return null
  const issue = payload.issue as Record<string, unknown> | undefined
  if (!issue) return null
  const number = Number(issue.number)
  if (!Number.isFinite(number)) return null
  const type = action === 'opened' ? 'issue.opened' : action === 'closed' ? 'issue.closed' : 'issue.updated'
  return {
    type,
    externalId: deliveryId,
    subject: `${repo}#${number}`,
    summary: String(issue.title ?? ''),
    body: String(issue.body ?? ''),
    link: String(issue.html_url ?? ''),
    author: String((issue.user as Record<string, unknown> | undefined)?.login ?? ''),
    repo,
  }
}

/** GitHub Issue 来源的配置。 */
export interface GithubIssueSourceOptions {
  id: string
  repos: string[]
  labels: string[]
  state: string
  project?: string
  priorityHint: number
  costClass: EventEnvelope['costClass']
  lane?: string
  notifyChat?: string
  /** 拉取命令的执行器；测试注入假实现。 */
  runner: CommandRunner
  cursors: CursorStore
}

/**
 * GitHub Issue 轮询来源。
 *
 * 每个仓库一个增量游标，只在拉取成功后推进；失败保留旧游标并退避重试。
 */
export class GithubIssueSource implements EventSource {
  readonly id: string
  readonly family = 'issue' as const
  private options: GithubIssueSourceOptions

  constructor(options: GithubIssueSourceOptions) {
    this.options = options
    this.id = options.id
  }

  async poll(ctx: { now: string }): Promise<EventEnvelope[]> {
    const events: EventEnvelope[] = []
    for (const repo of this.options.repos) {
      const cursorKey = `github-issues:${repo}`
      const cursor = this.options.cursors.getCursor(cursorKey) ?? ''
      const argv = ghIssueListCommand(
        repo,
        this.options.state,
        cursor ? `updated:>${cursor}` : '',
        this.options.labels,
        ISSUE_POLL_LIMIT,
      )
      const result = await this.options.runner.run(argv, { timeoutMs: 60_000 })
      if (result.code !== 0) continue
      const issues = parseIssueList(result.stdout)
      for (const issue of issues) {
        events.push(this.toEnvelope(repo, issue, ctx.now))
      }
      const newest = issues.map(issue => issue.updatedAt).filter(Boolean).sort().at(-1)
      if (newest) this.options.cursors.setCursor(cursorKey, newest, ctx.now)
    }
    return events
  }

  /** Issue → 统一事件。 */
  private toEnvelope(repo: string, issue: IssueBrief, now: string): EventEnvelope {
    return {
      id: '',
      source: this.options.id,
      type: 'issue.updated',
      // 更新时刻进幂等键：同一条 Issue 改了内容会再进一次，改回旧内容不会重复进。
      externalId: `${repo}#${issue.number}@${issue.updatedAt}`,
      subject: `${repo}#${issue.number}`,
      summary: issue.title || `${repo}#${issue.number}`,
      detail: issue.body,
      link: issue.url,
      actor: { id: issue.author, name: issue.author || 'unknown', type: 'external' },
      ...(this.options.project ? { project: this.options.project } : {}),
      lane: this.options.lane || `repo:${repo}`,
      priorityHint: this.options.priorityHint,
      costClass: this.options.costClass,
      receivedAt: now,
      hops: 0,
    }
  }
}
