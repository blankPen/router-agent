/**
 * GitHub 事件 watcher：按订阅的仓库与事件类型把 GitHub 上的动静收成事件。
 *
 * 数据来自 GitHub 的两条线：
 * - `repos/<repo>/events`：Issue、PR、评论、评审等；
 * - `repos/<repo>/actions/runs`：工作流（Action）的触发与结论。
 *
 * 只做「把动静变成事件」，判定与派工交给事件管线。
 *
 * 订阅是参数而不是构造参数：同一个仓库可以被多个任务订阅，
 * 每个订阅有自己的游标 —— 共用游标会让先跑的订阅把后跑的挡在门外。
 */
import type { EventEnvelope } from '#event/port.js'
import { GITHUB_EVENT_PREFIX, GITHUB_EVENT_TYPES, githubEventLabel, withGithubPrefix, type GithubEventType } from '#core/github-events.js'
import type { CommandRunner } from '#infra/process.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import type { EventWatcher } from '../watcher.js'
import type { ResolvedSubscription } from '../subscriptions.js'

/** GitHub 事件流与工作流列表最多翻几页；feed 本身最多 300 条。 */
const MAX_EVENT_PAGES = 3

/** 游标格式版本：水位语义变了就 +1，旧键自然作废、重新建基线。 */
const CURSOR_VERSION = 'v2'

/** 只处理最近 3 天的事件；更早的存量对派工没有意义。 */
const SINCE_DAYS = 3
const DAY_MS = 24 * 60 * 60 * 1000

export interface GithubEventSourceDeps {
  /** 执行 gh 的运行器；测试注入。 */
  runner: CommandRunner
  logger?: Logger
  /** 当前时间；宿主注入后窗口过滤可复现。 */
  clock?: () => string
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

/** GitHub 事件 watcher（poll 形态）。 */
export class GithubEventSource implements EventWatcher {
  readonly catalogId = 'github'
  readonly mode = 'poll' as const
  private runner: CommandRunner
  private logger: Logger
  private clock: () => string
  private limit: number
  private cursor?: EventCursor

  constructor(deps: GithubEventSourceDeps) {
    this.runner = deps.runner
    this.logger = deps.logger ?? noopLogger
    this.clock = deps.clock ?? (() => new Date().toISOString())
    this.limit = deps.limit ?? 100
    this.cursor = deps.cursor
  }

  async poll(subscription: ResolvedSubscription): Promise<EventEnvelope[]> {
    const repo = (subscription.params.repo ?? '').trim()
    if (!repo) {
      this.logger.warn('event:source-not-configured', { sourceId: this.catalogId, repo })
      return []
    }
    const wanted = subscribedTypes(subscription.types)
    if (wanted.length === 0) return []
    const wantedIds = wanted.map(type => type.id)
    const now = Date.parse(this.clock())
    const sinceMs = (Number.isFinite(now) ? now : Date.now()) - SINCE_DAYS * DAY_MS

    const envelopes: EventEnvelope[] = []
    if (wanted.some(type => type.kind !== 'workflow_run')) {
      // 事件流一页装不下的订阅事件：GitHub 的 feed 每页 100 条、最多翻到 300 条，
      // 只拉第 1 页会把排在后面的 Issue / PR 事件整片丢掉。
      const pages: EventEnvelope[] = []
      const cursorKey = this.cursorKey(subscription.id, repo)
      const baselining = this.isBaselining(cursorKey)
      let rawMaxId = 0
      let complete = true
      for (let page = 1; page <= MAX_EVENT_PAGES; page += 1) {
        const result = await this.runner.run(
          ['api', `repos/${repo}/events?per_page=${this.limit}&page=${page}`],
          { timeoutMs: 60_000 },
        )
        if (result.code !== 0) {
          // 拉取失败只记日志：来源不可用不该让整条管线停摆，下次轮询还会再试。
          this.logger.warn('event:github-poll-failed', {
            sourceId: this.catalogId,
            repo,
            detail: (result.stderr || result.stdout).slice(0, 200),
          })
          complete = false
          break
        }
        const stats = pageStats(result.stdout)
        // 结束条件看本页原始条数：本页没有订阅事件不代表后面没有
        // （feed 里混着大量 PushEvent，订阅事件可能排在第 2、3 页）。
        if (stats.count === 0) break
        const parsed = parseGithubEvents(result.stdout, repo, wantedIds)
        // 水位只按命中订阅的事件算：feed 里混着 id 空间不同的仓库级事件
        // （PushEvent / CreateEvent 的 id 比 Issue/PR 事件大几十亿），
        // 按整页取最大值会让游标跨空间，之后所有 Issue/PR 事件都被挡在门外。
        rawMaxId = Math.max(rawMaxId, maxIdOf(parsed))
        // 基线轮只记水位，不查 PR 详情 —— 这批事件本来就不入队。
        if (baselining) continue
        // 只给窗口内的事件补详情，避免恢复订阅时对陈年 PR 批量调 gh。
        await this.fillPullRequestDetails(recentEvents(parsed, sinceMs), repo)
        pages.push(...parsed)
      }
      envelopes.push(...this.freshEvents(pages, cursorKey, rawMaxId, complete, sinceMs))
    }

    if (wanted.some(type => type.kind === 'workflow_run')) {
      const pages: EventEnvelope[] = []
      const cursorKey = `${this.cursorKey(subscription.id, repo)}:runs`
      const baselining = this.isBaselining(cursorKey)
      let rawMaxId = 0
      let complete = true
      for (let page = 1; page <= MAX_EVENT_PAGES; page += 1) {
        const result = await this.runner.run(
          ['api', `repos/${repo}/actions/runs?per_page=${this.limit}&page=${page}`],
          { timeoutMs: 60_000 },
        )
        if (result.code !== 0) {
          this.logger.warn('event:github-poll-failed', {
            sourceId: this.catalogId,
            repo,
            detail: (result.stderr || result.stdout).slice(0, 200),
          })
          complete = false
          break
        }
        const stats = pageStats(result.stdout)
        if (stats.count === 0) break
        const parsed = parseGithubRuns(result.stdout, repo, wantedIds)
        // 工作流的 id 属于独立编号空间，水位同样只按命中订阅的运行推进。
        rawMaxId = Math.max(rawMaxId, maxIdOf(parsed))
        if (baselining) continue
        pages.push(...parsed)
      }
      envelopes.push(...this.freshEvents(pages, cursorKey, rawMaxId, complete, sinceMs))
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
      if (!event.eventType?.startsWith(`${GITHUB_EVENT_PREFIX}.pull_request.`)) continue
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
        sourceId: this.catalogId,
        repo,
        detail: errorMessage(error).slice(0, 200),
      })
      return { title: '', body: '' }
    }
  }

  /**
   * 游标键：带来源 id 与仓库。
   *
   * 两个订阅同一个仓库时不能共用游标 —— 否则一个订阅拉到的位置会把另一个订阅的
   * 新事件挡掉。键里必须带来源 id。
   *
   * 末尾的版本号用来作废旧游标格式：早期版本按整页取 id 最大值，
   * 会被 id 空间不同的仓库级事件顶偏，存下来的水位不可信。换个键就是重建基线，
   * 不需要手工清库。
   */
  private cursorKey(subscriptionId: string, repo: string): string {
    return `github:${subscriptionId}:${repo}:${CURSOR_VERSION}`
  }

  /** 这个来源还没建过基线（第一次订阅）。 */
  private isBaselining(cursorKey: string): boolean {
    return Boolean(this.cursor) && this.cursor!.get(cursorKey) === null
  }

  /**
   * 丢掉上次已见过的事件，并推进游标。
   *
   * 同一族里的 GitHub 事件 id 严格降序，所以游标记「已处理过的最大 id」。
   * 注意：必须等所有页都拉完后一次性算 —— 同一族里第 1 页的 id 反而比第 2 页大，
   * 每页各算一次会让第 1 页把游标推过头，后面几页的事件全被当成旧事件丢掉。
   *
   * 第一次订阅时没有基线：只把当前水位记下来，不入队任何事件。
   * 否则新订阅一开就会把 GitHub 上积攒的历史全部当成「刚发生的事」灌进队列，
   * 一夜之间开出几十张工单。
   *
   * 时间窗口与游标是两件事：游标记「见过的最新 id」，窗口决定「要不要入队」。
   * 游标越过窗口外的旧事件，下一次轮询就不会再重复处理它们。
   */
  private freshEvents(
    events: EventEnvelope[],
    cursorKey: string,
    rawMaxId: number,
    complete: boolean,
    sinceMs: number,
  ): EventEnvelope[] {
    if (!this.cursor) return recentEvents(events, sinceMs)
    const stored = this.cursor.get(cursorKey)
    if (stored === null) {
      // 拉取不全时不记水位：否则漏掉的那几页会被永久跳过。
      if (!complete) return []
      if (rawMaxId > 0) this.cursor.set(cursorKey, String(rawMaxId))
      this.logger.info('event:github-baseline', { sourceId: this.catalogId, cursorKey, maxId: rawMaxId })
      return []
    }
    const since = Number(stored)
    const fresh = events.filter(event => Number(event.id ?? '0') > since)
    const recent = recentEvents(fresh, sinceMs)
    const newest = fresh.reduce((max, event) => Math.max(max, Number(event.id ?? '0')), since)
    if (newest > since) this.cursor.set(cursorKey, String(newest))
    if (recent.length < fresh.length) {
      this.logger.info('event:github-window-skipped', {
        sourceId: this.catalogId,
        cursorKey,
        skipped: fresh.length - recent.length,
        since: new Date(sinceMs).toISOString(),
      })
    }
    return recent
  }

  async publish(subscription: ResolvedSubscription, target: { externalId: string; url?: string }, text: string): Promise<void> {
    const repo = (subscription.params.repo ?? '').trim()
    const number = issueNumberOf(target.externalId)
    if (!repo || !number) {
      this.logger.warn('event:writeback-unsupported', { sourceId: this.catalogId, externalId: target.externalId })
      return
    }
    const result = await this.runner.run(['issue', 'comment', String(number), '--repo', repo, '--body', text], { timeoutMs: 60_000 })
    if (result.code !== 0) {
      this.logger.warn('event:writeback-failed', {
        sourceId: this.catalogId,
        externalId: target.externalId,
        detail: (result.stderr || result.stdout).slice(0, 200),
      })
    }
  }
}

/**
 * 订阅的事件类型；没配就是全部。
 *
 * 订阅里的类型带 `github.` 前缀，GitHub 目录里的 id 不带 —— 这里去掉前缀再匹配。
 */
function subscribedTypes(prefixed: readonly string[]): GithubEventType[] {
  const ids = prefixed
    .filter(id => typeof id === 'string' && id.trim())
    .map(id => (id.startsWith(`${GITHUB_EVENT_PREFIX}.`) ? id.slice(GITHUB_EVENT_PREFIX.length + 1) : id))
  if (ids.length === 0) return [...GITHUB_EVENT_TYPES]
  return GITHUB_EVENT_TYPES.filter(type => ids.includes(type.id))
}

/** 从 externalId 里取 Issue / PR 序号。 */
export function issueNumberOf(externalId: string): number {
  const match = /#(\d+)/.exec(externalId)
  return match ? Number(match[1]) : 0
}

/** 从 externalId 里取 PR 序号（PR 的 externalId 以 `github:pull_request:` 开头）。 */
function pullNumberOf(externalId: string): number {
  if (!externalId.startsWith(`${GITHUB_EVENT_PREFIX}:pull_request:`)) return 0
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
      externalId: `${GITHUB_EVENT_PREFIX}:${eventType.split('.')[0]}:${repo}#${number}:${id}`,
      title: `${githubEventLabel(eventType)} · ${title}`,
      eventType: withGithubPrefix(eventType),
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
      externalId: `${GITHUB_EVENT_PREFIX}:workflow_run:${repo}#${id}:${phase}`,
      title: `${githubEventLabel(eventType)} · ${name}`,
      eventType: withGithubPrefix(eventType),
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

/** 只保留窗口内的事件；缺少时间戳的保留，避免因为字段缺失误丢。 */
function recentEvents(events: EventEnvelope[], sinceMs: number): EventEnvelope[] {
  return events.filter(event => {
    const at = Date.parse(event.receivedAt ?? '')
    return !Number.isFinite(at) || at >= sinceMs
  })
}

/** 一页的原始条数；解析不出来当 0 条（停止翻页）。 */
function pageStats(stdout: string): { count: number } {
  try {
    const parsed: unknown = JSON.parse(stdout || '[]')
    const rows = Array.isArray(parsed)
      ? parsed
      : (isRecord(parsed) && Array.isArray(parsed.workflow_runs) ? parsed.workflow_runs : [])
    return { count: rows.length }
  } catch {
    return { count: 0 }
  }
}

/**
 * 一批事件里的最大 id；没有带 id 的事件时返回 0。
 *
 * 只在**已经解析成订阅事件**的条目上算：GitHub 的事件 feed 混着几套互不相关的
 * id 编号空间（仓库级 PushEvent / CreateEvent 的 id 比 Issue/PR 事件大几十亿），
 * 跨空间取最大值会把游标推到别的空间，之后所有 Issue/PR 事件都小于游标而被挡掉。
 */
function maxIdOf(events: EventEnvelope[]): number {
  let maxId = 0
  for (const event of events) {
    const id = Number(event.id ?? '0')
    if (Number.isFinite(id) && id > maxId) maxId = id
  }
  return maxId
}
