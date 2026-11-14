/**
 * Worker 上报的解析与校验。
 *
 * 本地 `/api/reports` 与远端节点回传的上报走同一份规则：
 * 状态、轮次、回复载荷的判定必须一致，否则同一条工单在两种通道上表现会不一样。
 */
import type { Store } from '../store/db.js'
import type { WorkerStateFile } from '#runtime/report-poller.js'
import { isReplyPayload, type ReplyPayload } from '#core/reply.js'

export interface ReportStateResult {
  ok: true
  state: WorkerStateFile
}

export interface ReportStateFailure {
  ok: false
  status: number
  body: Record<string, unknown>
}

export type ReportStateOutcome = ReportStateResult | ReportStateFailure

/** 把上报请求体折算成 worker 状态；校验不过时给出该回什么状态码。 */
export function buildReportState(
  body: Record<string, any>,
  store: Store,
  now: string,
): ReportStateOutcome {
  const ticketId = String(body.ticketId ?? body.ticket_id ?? '')
  const ticket = store.getTicket(ticketId)
  if (!ticket) return { ok: false, status: 404, body: { error: 'ticket-not-found' } }

  const assignment = (body.assignmentId ? store.getAssignment(String(body.assignmentId)) : null) ?? store.latestAssignment(ticketId)
  if (!assignment) return { ok: false, status: 409, body: { error: 'no-assignment' } }

  const state = String(body.state ?? '')
  if (!['progress', 'ready', 'blocked', 'failed', 'dropped', 'waiting'].includes(state)) {
    return { ok: false, status: 400, body: { error: 'invalid-state' } }
  }
  const summary = String(body.summary ?? '').trim()
  if (!summary) return { ok: false, status: 400, body: { error: 'summary-required' } }

  // worker 不传 turn 时按已有序号自增，避免同一 turn 的多次回答被幂等键吞掉。
  const latest = store.latestReport(ticketId)
  const requestedTurn = Number(body.turn)
  const turn = Number.isFinite(requestedTurn) && requestedTurn >= 0 ? requestedTurn : (latest?.turn ?? 0) + 1

  const rawPayload = body.replyPayload
  if (rawPayload !== undefined && !isReplyPayload(rawPayload)) {
    return { ok: false, status: 400, body: { error: 'invalid-reply-payload', message: 'replyPayload 结构不合法' } }
  }
  const replyPayload = isReplyPayload(rawPayload) ? rawPayload as ReplyPayload : undefined
  const reply = String(body.reply ?? legacyReply(body.deliverable) ?? replyPayload?.fallbackText ?? '').trim()
  const uiChange = optionalBoolean(body.uiChange)

  return {
    ok: true,
    state: {
      ticketId,
      assignmentId: assignment.id,
      turn,
      state: state as WorkerStateFile['state'],
      summary,
      ...(body.humanAction ? { humanAction: String(body.humanAction) } : {}),
      prNumber: Number(body.prNumber ?? 0) || 0,
      prUrl: String(body.prUrl ?? ''),
      ...(uiChange !== undefined ? { uiChange } : {}),
      ...(reply ? { reply } : {}),
      ...(replyPayload ? { replyPayload } : {}),
      ackedInputs: Array.isArray(body.ackedInputs) ? body.ackedInputs.map(String) : [],
      updatedAt: String(body.updatedAt ?? now),
    },
  }
}

/** 旧版 deliverable 字段折算成纯回复。 */
function legacyReply(deliverable: unknown): string {
  if (!deliverable || typeof deliverable !== 'object') return ''
  const value = deliverable as Record<string, unknown>
  return [String(value.content ?? '').trim(), String(value.url ?? '').trim()].filter(Boolean).join('\n\n')
}

/** 上报里的三态布尔：true / false / 未声明。字符串兼容旧客户端。 */
function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}
