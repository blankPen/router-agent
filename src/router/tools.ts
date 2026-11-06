import type { Store } from '../store/db.js'
import { deriveTitle, type Engine } from '../core/engine.js'
import type { Decision, Strength } from '../core/model.js'
import type { DecisionProposal } from './decision-engine.js'
import type { LlmToolSchema } from './llm.js'
import { ROUTER_TOOL_SPECS, toOpenAiTool } from './tool-spec.js'

/** 兼容既有调用方：工具 schema 统一由 tool-spec 的 TypeBox 定义生成。 */
export const ROUTER_TOOLS: LlmToolSchema[] = ROUTER_TOOL_SPECS.map(toOpenAiTool)

export interface RouterToolboxDeps {
  engine: Engine
  store: Store
  /** 影子引擎用：禁止任何领域副作用（订阅等），只允许读与产出 proposal。 */
  readOnly?: boolean
}

export interface ToolOutcome {
  applied: boolean
  result: unknown
}

export type ProposeOutcome =
  | { proposal: DecisionProposal }
  | { error: string }

/** 执行模型发来的工具调用。所有写操作仍然经过 Engine。 */
export class RouterToolbox {
  private engine: Engine
  private store: Store
  private readOnly: boolean

  constructor(deps: RouterToolboxDeps) {
    this.engine = deps.engine
    this.store = deps.store
    this.readOnly = Boolean(deps.readOnly)
  }

  async call(name: string, rawArgs: string, defaults: { strength?: Strength; triggerId?: string } = {}): Promise<ToolOutcome> {
    let args: Record<string, unknown>
    try {
      args = rawArgs.trim() ? (JSON.parse(rawArgs) as Record<string, unknown>) : {}
    } catch {
      return { applied: false, result: { error: 'invalid-json-arguments' } }
    }
    switch (name) {
      case 'router_read':
        return { applied: false, result: this.read(args) }
      case 'router_decide': {
        // 方案约束：工具只产出 proposal，不写库；Engine.decide 由 AgentLoop 统一调用。
        const outcome = this.propose(args, defaults)
        return { applied: 'proposal' in outcome, result: 'proposal' in outcome ? outcome.proposal : { error: outcome.error } }
      }
      case 'router_reply':
        return { applied: false, result: this.reply(args) }
      case 'router_ticket':
        return { applied: false, result: this.ticket(args) }
      case 'router_subscribe':
        return { applied: false, result: this.subscribe(args) }
      default:
        return { applied: false, result: { error: `unknown-tool:${name}` } }
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

  private read(args: Record<string, unknown>): unknown {
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

  private reply(_args: Record<string, unknown>): unknown {
    // 回复由系统自动发送（ack / 话题开场 / 礼貌回复），这里不再二次入队，避免重复消息。
    return { skipped: true, reason: 'replies are sent automatically by the router' }
  }

  private ticket(args: Record<string, unknown>): unknown {
    if (args.ticket_id) return this.store.getTicket(String(args.ticket_id)) ?? { error: 'ticket:not-found' }
    return this.store.listTickets({ stage: args.stage as never, limit: Number(args.limit ?? 50) })
  }

  private subscribe(args: Record<string, unknown>): unknown {
    if (this.readOnly) return { skipped: true, reason: 'shadow-engine-is-read-only' }
    const threadId = String(args.thread_id ?? '')
    const ticketId = String(args.ticket_id ?? '')
    if (!threadId || !ticketId) return { error: 'router_subscribe:missing-args' }
    if (args.action === 'unsubscribe') {
      this.engine.unsubscribe(threadId, ticketId)
      return { subscribed: false }
    }
    this.engine.subscribe(threadId, ticketId, Boolean(args.context_only))
    return { subscribed: true }
  }
}

/** 只接受真实飞书 om_ 消息 id；模型常把内部 id（feishu_om_xxx）传进来。 */
export function normalizeMessageId(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const stripped = raw.startsWith('feishu_') ? raw.slice('feishu_'.length) : raw
  return /^om_[A-Za-z0-9]+$/.test(stripped) ? stripped : ''
}

/** 从模型决定里取标题时用；导出便于测试与复用。 */
export function titleFrom(args: Record<string, unknown>, triggerText: string): string {
  const title = String(args.title ?? '').trim()
  return title || deriveTitle(triggerText)
}
