import type { Store } from '../store/db.js'
import type { Decision, Stage, Strength, Ticket } from '../core/model.js'
import type { Clock, Engine } from '../core/engine.js'
import type { DecisionProposal } from './decision-engine.js'

export interface RouterToolboxDeps {
  store: Store
  /**
   * 写操作（关单 / 回收 workspace）统一走 Engine 与 Effects 队列。
   * 只读工具或 dry-run 场景可以不传，此时写工具会返回 operator:unavailable。
   */
  engine?: Engine
  clock?: Clock
}

/** 一次工具调用的上下文：只有用户明确对 Router 说话时才允许变更工单。 */
export interface ToolContext {
  canMutate: boolean
}

export type ProposeOutcome =
  | { proposal: DecisionProposal }
  | { error: string }

const MAX_LIST_LIMIT = 50

/**
 * Pi 研判与运维工具的实现。
 *
 * 读工具只碰 Store；写工具只做两件事——关单（Engine）和把 workspace 回收排进 Effects，
 * 不直接操作 Orca，保证服务层的重试、去重与审计口径不变。
 */
export class RouterToolbox {
  private store: Store
  private engine?: Engine
  private clock: Clock

  constructor(deps: RouterToolboxDeps) {
    this.store = deps.store
    this.engine = deps.engine
    this.clock = deps.clock ?? { now: () => new Date().toISOString() }
  }

  read(args: Record<string, unknown>): unknown {
    if (args.ticket_id) {
      const ticket = this.store.getTicket(String(args.ticket_id))
      if (!ticket) return { error: 'ticket:not-found' }
      return {
        ticket,
        mandate: this.store.getMandate(ticket.mandateId),
        assignment: this.store.latestAssignment(ticket.id),
        reports: this.store.listReports(ticket.id, 5),
        inputs: this.store.listInputs(ticket.id),
      }
    }
    if (args.trigger_id) {
      const trigger = this.store.getTrigger(String(args.trigger_id))
      if (!trigger) return { error: 'trigger:not-found' }
      return {
        trigger,
        thread: this.store.listTriggersByThread(trigger.threadId, 20),
        tickets: this.store.listSubscriptions(trigger.threadId).map(s => this.store.getTicket(s.ticketId)).filter(Boolean),
      }
    }
    if (args.thread_id) {
      return {
        triggers: this.store.listTriggersByThread(String(args.thread_id), 20),
        subscriptions: this.store.listSubscriptions(String(args.thread_id)),
      }
    }
    return { error: 'router_read:missing-args' }
  }

  ticket(args: Record<string, unknown>): unknown {
    if (args.ticket_id) return this.store.getTicket(String(args.ticket_id)) ?? { error: 'ticket:not-found' }
    const stage = typeof args.stage === 'string' && args.stage ? (args.stage as Stage) : undefined
    return this.store.listTickets({ ...(stage ? { stage } : {}), limit: Number(args.limit ?? 50) })
  }

  /** 工单列表：阶段 / 会话 / 关键词过滤，只返回摘要，完整内容用 router_ticket_progress 查。 */
  list(args: Record<string, unknown>): unknown {
    const stage = typeof args.stage === 'string' && args.stage ? (args.stage as Stage) : undefined
    const chatId = String(args.chat_id ?? '').trim()
    const keyword = String(args.keyword ?? '').trim().toLowerCase()
    const limit = clampLimit(args.limit, 20)

    const tickets = this.store
      .listTickets({ ...(stage ? { stage } : {}), limit: 500 })
      .filter(ticket => (chatId ? ticket.chatId === chatId : true))
      .filter(ticket => {
        if (!keyword) return true
        return ticket.id.toLowerCase().includes(keyword) || ticket.title.toLowerCase().includes(keyword)
      })
      .slice(0, limit)
      .map(ticket => ({
        id: ticket.id,
        title: ticket.title,
        stage: ticket.stage,
        repo: ticket.repo,
        branch: ticket.branch,
        prUrl: ticket.prUrl,
        updatedAt: ticket.updatedAt,
      }))

    return { count: tickets.length, tickets }
  }

  /** 单张工单的进展：阶段、最近上报、待答问题、PR、workspace 与未处理输入。 */
  progress(args: Record<string, unknown>): unknown {
    const ticketId = String(args.ticket_id ?? '').trim()
    if (!ticketId) return { error: 'router_ticket_progress:missing-ticket_id' }
    const ticket = this.store.getTicket(ticketId)
    if (!ticket) return { error: 'ticket:not-found' }

    const assignment = this.store.latestAssignment(ticket.id)
    const reports = this.store.listReports(ticket.id, 10)
    const attention = this.store.getAttention(ticket.id)
    const pendingInputs = this.store.pendingInputs(ticket.id)

    return {
      ticket: {
        id: ticket.id,
        title: ticket.title,
        stage: ticket.stage,
        repo: ticket.repo,
        branch: ticket.branch,
        prNumber: ticket.prNumber,
        prUrl: ticket.prUrl,
        prState: ticket.prState,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
        closedAt: ticket.closedAt,
      },
      assignment: assignment
        ? { status: assignment.status, handle: assignment.handle, workdir: assignment.workdir, startedAt: assignment.startedAt, endedAt: assignment.endedAt }
        : null,
      attention,
      pendingInputs: pendingInputs.map(input => ({ seq: input.seq, kind: input.kind, text: input.text, createdAt: input.createdAt })),
      lastProgressAt: reports[0]?.at ?? ticket.updatedAt,
      reports: reports.map(report => ({
        turn: report.turn,
        state: report.state,
        summary: report.summary,
        ...(report.humanAction ? { humanAction: report.humanAction } : {}),
        ...(report.reply ? { reply: truncate(report.reply, 800) } : {}),
        at: report.at,
      })),
    }
  }

  /**
   * 关闭工单，并按需把 workspace 回收排进 Effects。
   * - PR 还开着时默认拒绝（Engine 的保护），只有 force 才走 stopTicket 强制关闭；
   * - remove_workspace=false 时只结束 worker，不删 worktree。
   */
  close(args: Record<string, unknown>, ctx: ToolContext): unknown {
    if (!ctx.canMutate) return { error: 'permission:not-authorized', hint: '关单要求发送人在准入名单内，且消息是 @ 机器人或私聊' }
    if (!this.engine) return { error: 'operator:unavailable' }

    const ticketId = String(args.ticket_id ?? '').trim()
    if (!ticketId) return { error: 'router_ticket_close:missing-ticket_id' }
    const reason = String(args.reason ?? '').trim() || '用户要求关闭'
    const force = args.force === true
    const removeWorkspace = args.remove_workspace !== false

    const before = this.store.getTicket(ticketId)
    if (!before) return { error: 'ticket:not-found' }

    let ticket = before
    if (before.stage !== 'closed') {
      try {
        ticket = force
          ? this.engine.stopTicket(ticketId, `ops:${reason}`)
          : this.engine.closeTicket(ticketId, `ops:${reason}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === 'pr:open') {
          return { error: 'pr:open', hint: 'PR 还开着。请让用户确认是否仍要关闭，确认后再传 force=true。' }
        }
        return { error: message }
      }
    }

    const queued: string[] = []
    if (removeWorkspace) {
      queued.push(this.queueCleanup(ticket))
    } else {
      queued.push(this.queueStopWorker(ticket))
    }

    return {
      ticket: {
        id: ticket.id,
        title: ticket.title,
        stage: ticket.stage,
        prUrl: ticket.prUrl,
        closedAt: ticket.closedAt,
      },
      alreadyClosed: before.stage === 'closed',
      forced: force && before.stage !== 'closed',
      queued,
    }
  }

  /** 只回收已关闭工单的 workspace；active 工单必须先关单，避免留下“开着但没有 workspace”的状态。 */
  removeWorkspace(args: Record<string, unknown>, ctx: ToolContext): unknown {
    if (!ctx.canMutate) return { error: 'permission:not-authorized', hint: '回收 workspace 要求发送人在准入名单内，且消息是 @ 机器人或私聊' }
    const ticketId = String(args.ticket_id ?? '').trim()
    if (!ticketId) return { error: 'router_workspace_remove:missing-ticket_id' }
    const ticket = this.store.getTicket(ticketId)
    if (!ticket) return { error: 'ticket:not-found' }
    if (ticket.stage !== 'closed') {
      return { error: 'ticket:not-closed', hint: '先关闭工单（router_ticket_close），再回收 workspace。' }
    }
    const assignment = this.store.latestAssignment(ticket.id)
    if (!assignment?.workdir) return { queued: false, reason: 'no-workspace', ticketId: ticket.id }

    return {
      ticketId: ticket.id,
      workdir: assignment.workdir,
      queued: this.queueCleanup(ticket),
    }
  }

  /** 解析并校验 router_decide 的参数，只返回提案，不触碰 Engine。 */
  propose(args: Record<string, unknown>, defaults: { strength?: Strength; triggerId?: string } = {}): ProposeOutcome {
    const triggerId = defaults.triggerId ?? String(args.trigger_id ?? '')
    if (!triggerId) return { error: 'router_decide:missing-trigger_id' }
    const trigger = this.store.getTrigger(triggerId)
    if (!trigger) return { error: 'trigger:not-found' }
    const decision = String(args.decision ?? '') as Decision
    if (!['accept', 'stop', 'ignore', 'unavailable'].includes(decision)) return { error: 'router_decide:invalid-decision' }
    const strength = defaults.strength ?? ((args.strength === 'explicit' ? 'explicit' : 'inferred') as Strength)

    return {
      proposal: {
        triggerId: trigger.id,
        decision,
        strength,
        reason: String(args.reason ?? ''),
        rules: Array.isArray(args.rules) ? args.rules.map(String) : [],
        ...(args.title === undefined ? {} : { title: String(args.title) }),
        ...(args.scope === undefined ? {} : { scope: String(args.scope) }),
        ...(args.repo === undefined ? {} : { repo: String(args.repo).trim() }),
        ...(args.branch === undefined ? {} : { branch: String(args.branch).trim() }),
      },
    }
  }

  private queueCleanup(ticket: Ticket): string {
    const now = this.clock.now()
    const suffix = (ticket.closedAt ?? now).replace(/[^0-9a-zA-Z]/g, '')
    this.store.enqueueEffect({
      id: `ef_ops_cleanup_${ticket.id}_${suffix}`,
      key: `cleanup-workspace:${ticket.id}:${ticket.closedAt ?? now}`,
      kind: 'cleanup-workspace',
      payload: { ticketId: ticket.id },
      now,
    })
    return 'cleanup-workspace'
  }

  private queueStopWorker(ticket: Ticket): string {
    this.store.enqueueEffect({
      id: `ef_ops_stop_${ticket.id}`,
      key: `stop:${ticket.id}`,
      kind: 'stop-worker',
      payload: { ticketId: ticket.id },
      now: this.clock.now(),
    })
    return 'stop-worker'
  }
}

function clampLimit(raw: unknown, fallback: number): number {
  const value = Number(raw ?? fallback)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), MAX_LIST_LIMIT)
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
