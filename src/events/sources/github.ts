/**
 * GitHub Issue 事件来源：定时用 gh 拉取新 Issue。
 *
 * 只做「把 Issue 变成事件」，判定与派工交给事件管线；
 * 订阅配置里写明的仓库与标签作为上下文线索，不直接决定归属项目。
 */
import type { EventSourceConfig } from '../../config.js'
import type { EventEnvelope, EventSource } from '#event/port.js'
import type { CommandRunner } from '#infra/process.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'

export interface GithubEventSourceDeps {
  /** 执行 gh 的运行器；测试注入。 */
  runner: CommandRunner
  logger?: Logger
  /** 拉多少条 Issue。 */
  limit?: number
}

/** GitHub Issue 事件来源。 */
export class GithubEventSource implements EventSource {
  readonly id: string
  readonly kind = 'github'
  private config: EventSourceConfig
  private runner: CommandRunner
  private logger: Logger
  private limit: number

  constructor(id: string, config: EventSourceConfig, deps: GithubEventSourceDeps) {
    this.id = id
    this.config = config
    this.runner = deps.runner
    this.logger = deps.logger ?? noopLogger
    this.limit = deps.limit ?? 30
  }

  async poll(): Promise<EventEnvelope[]> {
    const repo = (this.config.repo ?? '').trim()
    if (!repo) {
      this.logger.warn('event:source-not-configured', { sourceId: this.id, kind: this.kind })
      return []
    }
    const argv = [
      'issue', 'list',
      '--repo', repo,
      '--state', 'open',
      '--limit', String(this.limit),
      '--json', 'number,title,body,labels,url,createdAt',
    ]
    const result = await this.runner.run(argv, { timeoutMs: 60_000 })
    if (result.code !== 0) {
      // 拉取失败只记日志：来源不可用不该让整条管线停摆，下次轮询还会再试。
      this.logger.warn('event:github-poll-failed', {
        sourceId: this.id,
        repo,
        detail: (result.stderr || result.stdout).slice(0, 200),
      })
      return []
    }
    return parseGithubIssues(result.stdout, repo, this.config)
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

/** 从 gh 的 JSON 输出里解析 Issue 列表；只保留命中标签过滤的事件。 */
export function parseGithubIssues(stdout: string, repo: string, config: EventSourceConfig): EventEnvelope[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout || '[]')
  } catch (error) {
    throw new Error(`github:issues-parse-failed: ${errorMessage(error)}`)
  }
  if (!Array.isArray(parsed)) return []
  const wanted = (config.labels ?? []).map(label => label.trim().toLowerCase()).filter(Boolean)
  const out: EventEnvelope[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const number = Number(row.number)
    if (!Number.isFinite(number) || number <= 0) continue
    const labels = Array.isArray(row.labels)
      ? row.labels
        .map(label => String(typeof label === 'object' && label ? (label as Record<string, unknown>).name ?? '' : label))
        .map(label => label.toLowerCase())
      : []
    // 配了标签白名单时，只处理带白名单标签的 Issue。
    if (wanted.length > 0 && !labels.some(label => wanted.includes(label))) continue
    const title = String(row.title ?? '').trim()
    const body = String(row.body ?? '').trim()
    const context: Record<string, string> = { repo }
    if (config.project) context.project = config.project
    out.push({
      externalId: `issue:${repo}#${number}`,
      title: title || `Issue #${number}`,
      body,
      ...(row.url ? { url: String(row.url) } : {}),
      raw: row,
      ...(row.createdAt ? { receivedAt: String(row.createdAt) } : {}),
      context,
    })
  }
  return out
}

/** 从 externalId 里取 Issue 序号。 */
export function issueNumberOf(externalId: string): number {
  const match = externalId.match(/#(\d+)$/)
  return match ? Number(match[1]) : 0
}
