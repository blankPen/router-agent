import type { Store } from '../store/db.js'
import type { EventSettings, EventSourceSettings } from '../config.js'
import type { CommandRunner } from '#infra/process.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import type { EventEnvelope, EventSource } from '#core/event.js'
import { GithubIssueSource, mapGithubWebhook, verifyGithubSignature, type CursorStore } from '../sources/event-github.js'
import { CronSource } from '../sources/event-cron.js'
import { mapWebhookPayload, verifyBearer } from '../sources/event-webhook.js'

/** 构建来源与 webhook 入口所需的依赖。 */
export interface EventRuntimeOptions {
  /** 动态读配置：面板改完立即生效。 */
  config: () => EventSettings
  store: Store
  /** gh 命令执行器。 */
  runner: CommandRunner
  /** 读密钥用；密钥只从环境变量取，不写进配置文件。 */
  env: NodeJS.ProcessEnv
  logger?: Logger
  clock?: { now(): string }
}

/** Store 的游标读写正好满足来源要的形状。 */
function cursorStoreOf(store: Store): CursorStore {
  return {
    getCursor: key => store.getCursor(key),
    setCursor: (key, value, at) => { store.setCursor(key, value, at) },
  }
}

/** 按配置构建全部拉取型来源；webhook 型来源由入口直接处理，不进轮询。 */
export function buildEventSources(options: EventRuntimeOptions): EventSource[] {
  const settings = options.config()
  const sources: EventSource[] = []
  const cursors = cursorStoreOf(options.store)
  for (const source of settings.sources) {
    if (source.mode === 'webhook') continue
    if (source.type === 'github') {
      sources.push(new GithubIssueSource({
        id: source.id,
        repos: source.repos,
        labels: source.labels,
        state: source.state,
        ...(source.project ? { project: source.project } : {}),
        priorityHint: source.priorityHint,
        costClass: source.costClass,
        ...(source.lane ? { lane: source.lane } : {}),
        ...(source.notifyChat ? { notifyChat: source.notifyChat } : {}),
        runner: options.runner,
        cursors,
      }))
      continue
    }
    if (source.type === 'cron') {
      sources.push(new CronSource({
        id: source.id,
        cron: source.cron || '0 * * * *',
        task: source.cron || '定时任务',
        ...(source.project ? { project: source.project } : {}),
        priorityHint: source.priorityHint,
        costClass: source.costClass,
        ...(source.lane ? { lane: source.lane } : {}),
      }))
    }
  }
  return sources
}

/** webhook 入口的结果。 */
export interface WebhookAcceptResult {
  accepted: boolean
  reason?: string
  envelope?: EventEnvelope
}

/**
 * webhook 入口网关。
 *
 * 按来源 id 找到配置，验签通过后映射成统一事件；任何不合规都不入队。
 */
export class EventWebhookGateway {
  private options: EventRuntimeOptions

  constructor(options: EventRuntimeOptions) {
    this.options = options
  }

  /** 校验并映射一条 webhook 负载。 */
  accept(sourceId: string, body: string, headers: Record<string, string | undefined>): WebhookAcceptResult {
    const logger = this.options.logger ?? noopLogger
    const source = this.options.config().sources.find(item => item.id === sourceId)
    if (!source) return { accepted: false, reason: 'event:source-unknown' }
    const secret = source.secretRef ? this.options.env[source.secretRef] ?? '' : ''
    if (source.type === 'github') {
      const deliveryId = headers['x-github-delivery'] ?? ''
      const eventName = headers['x-github-event'] ?? ''
      if (!deliveryId) return { accepted: false, reason: 'event:delivery-missing' }
      if (!verifyGithubSignature(secret, body, headers['x-hub-signature-256'] ?? '')) {
        logger.warn('event:webhook-rejected', { source: sourceId, reason: 'event:signature-invalid' })
        return { accepted: false, reason: 'event:signature-invalid' }
      }
      const draft = mapGithubWebhook(body, deliveryId, eventName)
      if (!draft) return { accepted: false, reason: 'event:webhook-ignored' }
      if (source.repos.length > 0 && !source.repos.includes(draft.repo)) {
        logger.warn('event:webhook-rejected', { source: sourceId, reason: 'event:repo-not-allowed' })
        return { accepted: false, reason: 'event:repo-not-allowed' }
      }
      return {
        accepted: true,
        envelope: {
          id: '',
          source: source.id,
          type: draft.type,
          externalId: draft.externalId,
          subject: draft.subject,
          summary: draft.summary,
          ...(draft.body ? { detail: draft.body } : {}),
          ...(draft.link ? { link: draft.link } : {}),
          actor: { id: draft.author, name: draft.author || 'unknown', type: 'external' },
          ...(source.project ? { project: source.project } : {}),
          lane: source.lane || `repo:${draft.repo}`,
          priorityHint: source.priorityHint,
          costClass: source.costClass,
          receivedAt: this.options.clock?.now() ?? new Date().toISOString(),
          hops: 0,
        },
      }
    }

    if (!verifyBearer(headers.authorization, secret)) {
      logger.warn('event:webhook-rejected', { source: sourceId, reason: 'event:token-invalid' })
      return { accepted: false, reason: 'event:token-invalid' }
    }
    const draft = mapWebhookPayload(safeJson(body))
    if (!draft) return { accepted: false, reason: 'event:payload-invalid' }
    return {
      accepted: true,
      envelope: {
        id: '',
        source: source.id,
        type: draft.type,
        externalId: draft.externalId,
        subject: draft.subject,
        summary: draft.summary,
        ...(draft.detail ? { detail: draft.detail } : {}),
        ...(draft.link ? { link: draft.link } : {}),
        actor: draft.actor,
        ...(draft.project ? { project: draft.project } : {}),
        lane: source.lane || `source:${source.id}`,
        priorityHint: source.priorityHint,
        costClass: source.costClass,
        receivedAt: this.options.clock?.now() ?? new Date().toISOString(),
        hops: 0,
      },
    }
  }
}

/** 解析 JSON；失败返回 null。 */
function safeJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch (error) {
    void errorMessage(error)
    return null
  }
}
