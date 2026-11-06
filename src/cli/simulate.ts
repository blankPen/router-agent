import { join } from 'node:path'
import { Engine } from '../core/engine.js'
import type { AddressMode, DecisionRecord, SourceKind, Ticket, Trigger } from '../core/model.js'
import { policyOf, replyAlwaysChatsOf, type AppConfig } from '../config.js'
import { Store } from '../store/db.js'
import { AgentLoop } from '../router/agent-loop.js'
import { dispatchSettingsOf } from '../router/dispatch.js'
import type { DecisionAudit, DecisionEngine } from '../router/decision-engine.js'

export interface SimulateOptions {
  text: string
  chatId?: string
  actorId?: string
  /** 默认 mention（走显式路径）；--infer 时用 none 走 LLM 研判。 */
  addressed?: AddressMode
  source?: SourceKind
  /** 用内存库，不落盘。 */
  dryRun?: boolean
}

export interface SimulateResult {
  trigger: Trigger
  decision: DecisionRecord | null
  ticket?: Ticket
  /** 这一轮排进 Outbox 的回复（话题开场 / 礼貌回复），便于本地验证话术。 */
  replies: string[]
  /** 本轮研判审计（含耗时 / token / 工具调用）。 */
  audits: DecisionAudit[]
}

/**
 * 不经过飞书消息、也不派工，直接跑一轮 Gate + 研判，
 * 用来验证策略、提示词、Pi 引擎与模型配置是否正确。
 */
export async function simulate(
  deps: {
    home: string
    config: AppConfig
    /** 引擎可以直接给，也可以按本次的内存库现建（Pi 的 toolbox 需要绑定同一个 Store）。 */
    decisionEngine: DecisionEngine | ((store: Store) => DecisionEngine)
  },
  opts: SimulateOptions,
): Promise<SimulateResult> {
  const store = new Store(opts.dryRun ? ':memory:' : join(deps.home, 'state.db'))
  try {
    const engine = new Engine({ store, policy: policyOf(deps.config) })
    const decisionEngine = typeof deps.decisionEngine === 'function' ? deps.decisionEngine(store) : deps.decisionEngine
    const audits: DecisionAudit[] = []
    const loop = new AgentLoop({
      engine,
      decisionEngine,
      batchWindowMs: 0,
      dispatch: dispatchSettingsOf(deps.config),
      replyAlwaysChats: replyAlwaysChatsOf(deps.config),
      onAudit: audit => audits.push(audit),
    })
    const now = new Date()
    const trigger: Trigger = {
      id: `sim_${now.getTime()}`,
      source: opts.source ?? 'feishu',
      externalId: `sim_${now.getTime()}`,
      threadId: `feishu:${opts.chatId ?? deps.config.feishu.chats[0]?.chat ?? 'oc_sim'}:${now.getTime()}`,
      chatId: opts.chatId ?? deps.config.feishu.chats[0]?.chat ?? 'oc_sim',
      chatName: '',
      actorId: opts.actorId ?? deps.config.feishu.allowed[0] ?? 'ou_sim',
      actorName: '',
      isBot: false,
      text: opts.text,
      addressed: opts.addressed ?? 'mention',
      receivedAt: now.toISOString(),
      disposition: 'pending',
    }
    const before = new Set(store.listTickets({ limit: 500 }).map(ticket => ticket.id))
    const beforeOutbox = new Set(store.listOutbox(200).map(item => item.id))
    engine.ingest(trigger)
    await loop.tick()

    const stored = store.getTrigger(trigger.id)!
    const decision = stored.decisionId ? store.getDecision(stored.decisionId) : null
    const ticket = store.listTickets({ limit: 500 }).find(item => !before.has(item.id))
    const replies = store.listOutbox(200)
      .filter(item => !beforeOutbox.has(item.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(item => item.text)
    return { trigger: stored, decision, replies, audits, ...(ticket ? { ticket } : {}) }
  } finally {
    store.close()
  }
}