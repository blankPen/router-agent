import type { Store } from '../store/db.js'
import type { Decision, Strength } from '../core/model.js'
import type { DecisionProposal } from './decision-engine.js'

export interface RouterToolboxDeps {
  store: Store
}

export type ProposeOutcome =
  | { proposal: DecisionProposal }
  | { error: string }

/**
 * Pi 研判工具的实现。
 * 只读上下文 + 产出 proposal；这里没有任何写库路径。
 */
export class RouterToolbox {
  private store: Store

  constructor(deps: RouterToolboxDeps) {
    this.store = deps.store
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
    return this.store.listTickets({ stage: args.stage as never, limit: Number(args.limit ?? 50) })
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
}