import { timingSafeEqual } from 'node:crypto'
import type { EventEnvelope } from '#core/event.js'

/**
 * 通用 webhook 的请求契约（七字段）。
 *
 * 字段名固定，缺一个就不入队——外部系统的负载形状不统一，
 * 让它进来只会在判定层变成噪音。
 */
export interface WebhookPayload {
  /** 来源侧稳定 ID；幂等键的第一段。 */
  id: string
  /** 事件类型，小写点分。 */
  type: string
  /** 对象标识，只允许标识符字符。 */
  subject: string
  /** 一句话摘要。 */
  summary: string
  /** 发起者。 */
  actor: { id: string; name: string }
  /** 绑定的项目。 */
  project: string
  /** 原始链接。 */
  link: string
}

/** 映射后的 webhook 事件草稿。 */
export interface WebhookDraft {
  externalId: string
  type: string
  subject: string
  summary: string
  detail: string
  actor: { id: string; name: string; type: 'external' }
  project?: string
  link?: string
}

/** 七字段契约的映射；字段不齐返回 null。 */
export function mapWebhookPayload(payload: unknown): WebhookDraft | null {
  if (!payload || typeof payload !== 'object') return null
  const row = payload as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  const type = typeof row.type === 'string' ? row.type.trim() : ''
  const subject = typeof row.subject === 'string' ? row.subject.trim() : ''
  const summary = typeof row.summary === 'string' ? row.summary.trim() : ''
  const actorRow = row.actor && typeof row.actor === 'object' ? row.actor as Record<string, unknown> : null
  const actorId = actorRow && typeof actorRow.id === 'string' ? actorRow.id.trim() : ''
  const actorName = actorRow && typeof actorRow.name === 'string' ? actorRow.name.trim() : ''
  const project = typeof row.project === 'string' ? row.project.trim() : ''
  const link = typeof row.link === 'string' ? row.link.trim() : ''
  if (!id || !type || !subject || !summary) return null
  if (!actorId && !actorName) return null
  return {
    externalId: id,
    type,
    subject,
    summary,
    detail: typeof row.detail === 'string' ? row.detail : '',
    actor: { id: actorId, name: actorName || actorId, type: 'external' },
    ...(project ? { project } : {}),
    ...(link ? { link } : {}),
  }
}

/** Bearer 令牌校验；常量时间比较。 */
export function verifyBearer(header: string | undefined, token: string): boolean {
  if (!token) return false
  const given = (header ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!given || given.length !== token.length) return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(token))
}

/** 通用 webhook 来源的配置。 */
export interface WebhookSourceOptions {
  id: string
  project?: string
  priorityHint: number
  costClass: EventEnvelope['costClass']
  lane?: string
  /** Bearer 令牌；由环境变量读出，不写进配置文件。 */
  token?: string
}

/**
 * 通用 webhook 来源。
 *
 * 鉴权在入口做（Bearer + 可选 HMAC），负载映射成统一事件后与其它来源同路。
 */
export class WebhookSource {
  readonly id: string
  readonly family = 'webhook' as const
  private options: WebhookSourceOptions

  constructor(options: WebhookSourceOptions) {
    this.options = options
    this.id = options.id
  }

  /** 校验并映射一条 webhook 负载；不合规返回 null。 */
  accept(body: string, headers: { authorization?: string; requestId?: string }): WebhookDraft | null {
    if (!verifyBearer(headers.authorization, this.options.token ?? '')) return null
    let payload: unknown
    try {
      payload = JSON.parse(body)
    } catch {
      return null
    }
    const draft = mapWebhookPayload(payload)
    if (!draft) return null
    // 请求头带 ID 时优先用它：外部系统没给负载 ID 也能幂等。
    if (headers.requestId) draft.externalId = headers.requestId
    return draft
  }

  /** 草稿 → 统一事件。 */
  toEnvelope(draft: WebhookDraft, now: string): EventEnvelope {
    return {
      id: '',
      source: this.options.id,
      type: draft.type,
      externalId: draft.externalId,
      subject: draft.subject,
      summary: draft.summary,
      ...(draft.detail ? { detail: draft.detail } : {}),
      ...(draft.link ? { link: draft.link } : {}),
      actor: draft.actor,
      ...(draft.project ? { project: draft.project } : {}),
      lane: this.options.lane || `source:${this.options.id}`,
      priorityHint: this.options.priorityHint,
      costClass: this.options.costClass,
      receivedAt: now,
      hops: 0,
    }
  }
}
