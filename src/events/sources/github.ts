/**
 * GitHub 事件来源：按订阅的仓库与事件类型把 GitHub 上的动静收成事件。
 *
 * 数据来自 GitHub 的两条线：
 * - `repos/<repo>/events`：Issue、PR、评论、评审等；
 * - `repos/<repo>/actions/runs`：工作流（Action）的触发与结论。
 *
 * 只做「把动静变成事件」，判定与派工交给事件管线。
 */
import type { EventSourceConfig } from '../../config.js'
import type { EventEnvelope, EventSource } from '#event/port.js'
import { GITHUB_EVENT_TYPES, githubEventLabel, type GithubEventType } from '#core/github-events.js'
import type { CommandRunner } from '#infra/process.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'

/** GitHub 事件流与工作流列表最多翻几页；feed 本身最多 300 条。 */
const MAX_EVENT_PAGES = 3

export interface GithubEventSourceDeps {
  /** 执行 gh 的运行器；测试注入。 */
  runner: CommandRunner
  logger?: Logger
  /** 每次拉多少条；GitHub 的 per_page 上限 100。 */
  limit?: number
  /** 增量游标：记住上次拉到哪儿，下次只取更新的事件。 */
  cursor?: EventCursor
}

/** 增量游标：来源用它记住「上次拉到的位置」。 */
export interface EventCursor {
  get(key: string): string | null
  set(key: string, value: string): void
}

/** GitHub 事件来源：一个来源实例 = 一个仓库。 */
export class GithubEventSource implements EventSource {
  readonly id: string
  readonly kind = 'github'
  private config: EventSourceConfig
  private runner: CommandRunner
  private logger: Logger
  private limit: number
  private cursor?: EventCursor

  constructor(id: string, config: EventSourceConfig, deps: GithubEventSourceDeps) {
    this.id = id
    this.config = config
    this.runner = deps.runner
    this.logger = deps.logger ?? noopLogger
    this.limit = deps.limit ?? 100
    this.cursor = deps.cursor
  }

  async poll(): Promise<EventEnvelope[]> {
    const repo = (this.config.repo ?? '').trim()
    if (!repo) {
      this.logger.warn('event:source-not-configured', { sourceId: this.id, kind: this.kind })
      return []
    }
    const wanted = subscribedTypes(this.config)
    if (wanted.length === 0) return []
    const wantedIds = wanted.map(type => type.id)

    const envelopes: EventEnvelope[] = []
    if (wanted.some(type => type.kind !== 'workflow_run')) {
      // 事件流一页装不下的订阅事件：GitHub 的 feed 每页 100 条、最多翻到 300 条，
      // 只拉第 1 页会把排在后面的 Issue / PR 事件整片丢掉。
      const pages: EventEnvelope[] = []
      for (let page = 1; page <= MAX_EVENT_PAGES; page += 1) {
        const result = await this.runner.run(
          ['api', `repos/${repo}/events?per_page=${this.limit}&page=${page}`],
          { timeoutMs: 60_000 },
        )
        if (result.code !== 0) {
          // 拉取失败只记日志：来源不可用不该让整条管线停摆，下次轮询还会再试。
          this.logger.warn('event:github-poll-failed', {
            sourceId: this.id,
            repo,
            detail: (result.stderr || result.stdout).slice(0, 200),
          })
          break
        }
        const parsed = parseGithubEvents(result.stdout, repo, wantedIds)
        // 结束条件看本页原始条数：本页没有订阅事件不代表后面没有
        // （feed 里混着大量 PushEvent，订阅事件可能排在第 2、3 页）。
        if (pageEntryCount(result.stdout) === 0) break
        await this.fillPullRequestDetails(parsed, repo)
        pages.push(...parsed)
      }
      envelopes.push(...this.freshEvents(pages, `github:${repo}`))
    }

    if (wanted.some(type => type.kind === 'workflow_run')) {
      const pages: EventEnvelope[] = []
      for (let page = 1; page <= MAX_EVENT_PAGES; page += 1) {
        const result = await this.runner.run(
          ['api', `repos/${repo}/actions/runs?per_page=${this.limit}&page=${page}`],
          { timeoutMs: 60_000 },
        )
        if (result.code !== 0) {
          this.logger.warn('event:github-poll-failed', {
            sourceId: this.id,
            repo,
            detail: (result.stderr || result.stdout).slice(0, 200),
          })
          break
        }
        const parsed = parseGithubRuns(result.stdout, repo, wantedIds)
        if (pageEntryCount(result.stdout) === 0) break
        pages.push(...parsed)
      }
      envelopes.push(...this.freshEvents(pages, `github:${repo}:runs`))
    }
    return envelopes
  }

  /**
   * 补上 PR 的标题与正文。
   *
   * 仓库事件流里的 PR 载荷只有编号与分支，标题正文要另外查一次。
   */
  private async fillPullRequestDetails(events: EventEnvelope[], repo: string): Promise<void> {
    // 同一个 PR 在一轮里可能有多个事件（新建 + 评论），只查一次详情。
    const cache = new Map<number, { title: string; body: string }>()
    for (const event of events) {
      if (!event.eventType?.startsWith('pull_request.')) continue
      const number = pullNumberOf(event.externalId)
      if (!number) continue
      let detail = cache.get(number)
      if (!detail) {
        detail = await this.pullRequestDetail(number, repo)
        cache.set(number, detail)
      }
      if (detail.title) {
        const suffix = event.title.includes(`#${number}`) ? `#${number}` : ''
        const prefix = suffix ? event.title.slice(0, event.title.length - suffix.length) : event.title
        event.title = `${prefix}${detail.title}`
      }
      if (detail.body) event.body = [detail.body, event.body].filter(Boolean).join('\n\n')
    }
  }

  /** 查一个 PR 的标题与正文；查不到就返回空，不影响其它事件。 */
  private async pullRequestDetail(number: number, repo: string): Promise<{ title: string; body: string }> {
    const result = await this.runner.run(
      ['pr', 'view', String(number), '--repo', repo, '--json', 'title,body'],
      { timeoutMs: 60_000 },
    )
    if (result.code !== 0) return { title: '', body: '' }
    try {
      const detail = JSON.parse(result.stdout || '{}') as Record<string, unknown>
      return { title: String(detail.title ?? '').trim(), body: String(detail.body ?? '').trim() }
    } catch (error) {
      this.logger.warn('event:github-poll-failed', {
        sourceId: this.id,
        repo,
        detail: errorMessage(error).slice(0, 200),
      })
      return { title: '', body: '' }
    }
  }

  /**
   * 丢掉上次已见过的事件，并推进游标。
   *
   * 同一族里的 GitHub 事件 id 严格降序，所以游标记「已处理过的最大 id」。
   * 注意：必须等所有页都拉完后一次性算 —— 同一族里第 1 页的 id 反而比第 2 页大，
   * 每页各算一次会让第 1 页把游标推过头，后面几页的事件全被当成旧事件丢掉。
   */
  private freshEvents(events: EventEnvelope[], cursorKey: string): EventEnvelope[] {
    if (!this.cursor) return events
    const since = Number(this.cursor.get(cursorKey) ?? '0')
    const out = events.filter(event => Number(event.id ?? '0') > since)
    const newest = out.reduce((max, event) => Math.max(max, Number(event.id ?? '0')), since)
    if (newest > since) this.cursor.set(cursorKey, String(newest))
    return out
  }

  async publish(target: { externalId: string; url?: string }, text: string): Promise<void> {
    const repo = (this.config.repo ?? '').trim()
    const number = issueNumberOf(target.externalId)
    if (!repo || !number) {
      this.logger.warn('event:writeback-unsupported', { sourceId: this.id, externalId: target.externalId })
      return
    }
    const result = await this.runner.run(['issue', 'comment', String(number), '--repo', repo, '--body', text], { timeoutMs: 60_000 })
    if (result.code !== 0) {
      this.logger.warn('event:writeback-failed', {
        sourceId: this.id,
        externalId: target.externalId,
        detail: (result.stderr || result.stdout).slice(0, 200),
      })
    }
  }
}

/** 订阅的事件类型；没配就是全部。 */
function subscribedTypes(config: EventSourceConfig): GithubEventType[] {
  const ids = (config.events ?? []).filter(id => typeof id === 'string' && id.trim())
  if (ids.length === 0) return [...GITHUB_EVENT_TYPES]
  return GITHUB_EVENT_TYPES.filter(type => ids.includes(type.id))
}

/** 从 externalId 里取 Issue / PR 序号。 */
export function issueNumberOf(externalId: string): number {
  const match = /#(\d+)/.exec(externalId)
  return match ? Number(match[1]) : 0
}

/** 从 externalId 里取 PR 序号（PR 的 externalId 以 pull_request 开头）。 */
function pullNumberOf(externalId: string): number {
  if (!externalId.startsWith('pull_request:')) return 0
  return issueNumberOf(externalId)
}

/**
 * 解析仓库事件流，只保留命中订阅类型的条目。
 *
 * GitHub 的事件类型与动作组合很多，这里按「类别.动作」对齐目录：
 * IssueComment 算 issues 评论，PullRequest 算 PR。
 */
export function parseGithubEvents(stdout: string, repo: string, wanted: string[]): EventEnvelope[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout || '[]')
  } catch (error) {
    throw new Error(`github:events-parse-failed: ${errorMessage(error)}`)
  }
  if (!Array.isArray(parsed)) return []
  const out: EventEnvelope[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const type = String(row.type ?? '')
    const payload = isRecord(row.payload) ? row.payload : {}
    const action = String(payload.action ?? '')
    const id = String(row.id ?? '')
    const createdAt = String(row.created_at ?? '')
    const actor = isRecord(row.actor) ? String(row.actor.login ?? '') : ''

    const issue = isRecord(payload.issue) ? payload.issue : null
    const pull = isRecord(payload.pull_request) ? payload.pull_request : null
    const review = isRecord(payload.review) ? payload.review : null

    // PR 的评论在 GitHub 里也是 IssueCommentEvent，但主体带 pull_request：按 PR 归类。
    const isPull = Boolean(pull) || Boolean(issue && 'pull_request' in issue)
    const subject = pull ?? issue
    const number = subject ? Number(subject.number) : 0
    if (!subject || !Number.isFinite(number) || number <= 0) continue

    const eventType = subscriptionTypeOf(type, action, isPull, pull?.merged === true)
    if (!eventType) continue
    if (!wanted.includes(eventType)) continue

    const title = String(subject.title ?? '').trim() || `#${number}`
    const body = bodyOf(subject, payload)
    const url = String(subject.html_url ?? '')
    out.push({
      // 幂等键带上 GitHub 的事件 id：同一个 Issue 的「新建」与「评论」是两条不同事件。
      externalId: `${eventType.split('.')[0]}:${repo}#${number}:${id}`,
      title: `${githubEventLabel(eventType)} · ${title}`,
      eventType,
      id,
      body,
      ...(url ? { url } : {}),
      raw: row,
      ...(createdAt ? { receivedAt: createdAt } : {}),
      context: { repo, ...(actor ? { actor } : {}), ...(review?.state ? { reviewState: String(review.state) } : {}) },
    })
  }
  return out
}

/** 解析工作流列表，只保留命中订阅类型的条目。 */
export function parseGithubRuns(stdout: string, repo: string, wanted: string[]): EventEnvelope[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout || '{}')
  } catch (error) {
    throw new Error(`github:runs-parse-failed: ${errorMessage(error)}`)
  }
  const runs = isRecord(parsed) && Array.isArray(parsed.workflow_runs) ? parsed.workflow_runs : []
  const out: EventEnvelope[] = []
  for (const item of runs) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = Number(row.id)
    if (!Number.isFinite(id) || id <= 0) continue
    const status = String(row.status ?? '')
    const conclusion = String(row.conclusion ?? '')
    const eventType = runEventType(status, conclusion, wanted)
    if (!eventType) continue
    const name = String(row.name ?? '').trim() || '工作流'
    const title = String(row.display_title ?? '').trim()
    const url = String(row.html_url ?? '')
    const createdAt = String(row.created_at ?? '')
    // 幂等键带上状态：同一次运行先「触发」后「失败」是两条不同事件。
    const phase = conclusion || status
    out.push({
      externalId: `workflow_run:${repo}#${id}:${phase}`,
      title: `${githubEventLabel(eventType)} · ${name}`,
      eventType,
      id: String(id),
      body: [
        title ? `触发内容：${title}` : '',
        `工作流：${name}`,
        conclusion ? `结论：${conclusion}` : `状态：${status}`,
        row.head_branch ? `分支：${String(row.head_branch)}` : '',
      ].filter(Boolean).join('\n'),
      ...(url ? { url } : {}),
      raw: row,
      ...(createdAt ? { receivedAt: createdAt } : {}),
      context: { repo, ...(row.head_branch ? { branch: String(row.head_branch) } : {}) },
    })
  }
  return out
}

/** 事件正文：Issue / PR 取描述，评论与评审取动作附带的文字。 */
function bodyOf(subject: Record<string, unknown>, payload: Record<string, unknown>): string {
  const comment = isRecord(payload.comment) ? String(payload.comment.body ?? '') : ''
  const review = isRecord(payload.review) ? String(payload.review.body ?? '') : ''
  const description = String(subject.body ?? '')
  return [description, comment, review].filter(Boolean).join('\n\n')
}

/**
 * 工作流的当前状态 → 订阅类型 id；没命中订阅返回 null。
 *
 * 还没跑完的算「触发」（requested）；跑完了按结论取精确类型
 * （success / failure / cancelled …），「执行结束」（completed）是通配，全都算。
 */
function runEventType(status: string, conclusion: string, wanted: string[]): string | null {
  if (!conclusion) {
    // 进行中 / 排队中：只当「触发」事件，没有结论就没有结论类事件。
    return wanted.includes('workflow_run.requested') ? 'workflow_run.requested' : null
  }
  const exact = `workflow_run.${conclusion}`
  if (wanted.includes(exact)) return exact
  return wanted.includes('workflow_run.completed') ? 'workflow_run.completed' : null
}

/**
 * GitHub 的事件类型 → 订阅类型 id。
 *
 * GitHub 的原始类型名与动作名对不上订阅口径：
 * 评论是 `IssueCommentEvent` + `created`，评审是 `PullRequestReviewEvent` + `created`，
 * PR 合并是 `PullRequestEvent` + `closed` 且 payload.merged 为真。
 */
function subscriptionTypeOf(type: string, action: string, isPull: boolean, merged: boolean): string {
  if (type === 'IssuesEvent') return `issues.${action}`
  if (type === 'IssueCommentEvent') return isPull ? 'pull_request.commented' : 'issues.commented'
  if (type === 'PullRequestEvent') {
    if (action === 'closed') return merged ? 'pull_request.merged' : 'pull_request.closed'
    return `pull_request.${action}`
  }
  if (type === 'PullRequestReviewEvent' || type === 'PullRequestReviewCommentEvent') return 'pull_request.reviewed'
  if (type === 'LabelEvent') return 'issues.labeled'
  return ''
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** 这一页里有多少条原始记录；解析不出来当 0 条（停止翻页）。 */
function pageEntryCount(stdout: string): number {
  try {
    const parsed: unknown = JSON.parse(stdout || '[]')
    if (Array.isArray(parsed)) return parsed.length
    if (isRecord(parsed) && Array.isArray(parsed.workflow_runs)) return parsed.workflow_runs.length
    return 0
  } catch {
    return 0
  }
}
