import { join } from 'node:path'
import { Engine } from '../core/engine.js'
import type { AddressMode, DecisionRecord, SourceKind, Ticket, Trigger } from '../core/model.js'
import { policyOf, type AppConfig } from '../config.js'
import { Store } from '../store/db.js'
import type { LlmClient } from '../router/llm.js'
import { AgentLoop } from '../router/agent-loop.js'
import { dispatchSettingsOf } from '../router/dispatch.js'

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
  /** 这一轮排进 Outbox 的回复（ack / 话题开场 / 礼貌回复），便于本地验证话术。 */
  replies: string[]
}

/**
 * 不经过飞书消息、也不派工，直接跑一轮 Gate + 研判，
 * 用来验证策略、提示词与模型配置是否正确。
 */
export async function simulate(deps: { home: string; config: AppConfig; llm: LlmClient }, opts: SimulateOptions): Promise<SimulateResult> {
  const store = new Store(opts.dryRun ? ':memory:' : join(deps.home, 'state.db'))
  try {
    const engine = new Engine({ store, policy: policyOf(deps.config) })
    const loop = new AgentLoop({ engine, llm: deps.llm, batchWindowMs: 0, dispatch: dispatchSettingsOf(deps.config) })
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
    return { trigger: stored, decision, replies, ...(ticket ? { ticket } : {}) }
  } finally {
    store.close()
  }
}