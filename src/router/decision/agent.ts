/**
 * DecisionAgent：普通成员消息的决策装配层。
 *
 * 链路：确定性准入（admissionOf）→ 决策 Provider（Jev 优先，LLM 兜底）→
 * 内核派生动作与 toolScope → 审计。
 * 规则命中（bot / 媒体 / 口令 / 会话 / 工单 / 身份分流 / 噪声）不产生任何模型调用。
 */
import type { Trigger } from '#core/model.js'
import { admissionOf, type AdmissionContext, type AdmissionVerdict } from '#core/admission.js'
import {
  fallbackVerdict,
  routeVerdict,
  validateAnswers,
  MEMBER_MESSAGE_KINDS,
  type DecisionAnswers,
  type DecisionVerdict,
} from '#core/decision.js'
import { toolScopeFor } from '#core/tool-scope.js'
import { preview } from '#core/events.js'
import { noopLogger, errorMessage, type Logger } from '#infra/logger.js'
import { JevClient, type JevClientDeps, type JevConfig } from '#infra/decision/jev-client.js'
import type { IntakeEngine } from '../intake-engine.js'
import { extractJsonObject } from '../model-config.js'
import { readRouterPrompt } from '../../specs/index.js'

/** 决策 Provider：对一个已通过准入的普通成员消息产出 0~1 答案。 */
export interface DecisionProvider {
  readonly name: string
  ask(ctx: DecisionProviderContext): Promise<DecisionAnswers>
}

export interface DecisionProviderContext {
  trigger: Trigger
  admission: AdmissionVerdict
}

export interface DecisionAudit {
  triggerId: string
  provider: string
  outcome: 'dropped' | 'bypassed' | 'verdict' | 'failed'
  rule?: string
  answers?: DecisionAnswers
  verdict?: DecisionVerdict
  latencyMs?: number
  error?: string
}

export type DecisionOutcome =
  | { kind: 'dropped'; reason: string; rule: string }
  | { kind: 'bypassed'; reason: string; rule: string }
  | { kind: 'verdict'; verdict: DecisionVerdict }

export interface DecisionAgentOptions {
  provider: DecisionProvider
  /** 未启用时一律 bypass（保持现有行为，不接管消息）。 */
  enabled?: boolean
  /** 发送人是否为管理员（可查当前会话的名单，所以传入整个 trigger）。 */
  isAdmin: (trigger: Trigger) => boolean
  hasActiveIntake?: (trigger: Trigger) => boolean
  hasBoundTicket?: (trigger: Trigger) => boolean
  /** 命令口令（/new、确认派单、驳回等）；缺省只认 /new 与 intake 口令。 */
  isCommand?: (text: string) => boolean
  logger?: Logger
  onAudit?: (audit: DecisionAudit) => void
  /** 毫秒时钟，测试注入；缺省用 Date.now。 */
  now?: () => number
}

export class DecisionAgent {
  private provider: DecisionProvider
  private enabled: boolean
  private isAdminOf: (trigger: Trigger) => boolean
  private hasActiveIntakeOf?: (trigger: Trigger) => boolean
  private hasBoundTicketOf?: (trigger: Trigger) => boolean
  private isCommandOf: (text: string) => boolean
  private logger: Logger
  private onAudit?: (audit: DecisionAudit) => void
  private now: () => number

  constructor(opts: DecisionAgentOptions) {
    this.provider = opts.provider
    this.enabled = opts.enabled !== false
    this.isAdminOf = opts.isAdmin
    this.hasActiveIntakeOf = opts.hasActiveIntake
    this.hasBoundTicketOf = opts.hasBoundTicket
    this.isCommandOf = opts.isCommand ?? (text => /^\s*(?:@\S+\s+)?\/new\s*$/.test(text))
    this.logger = opts.logger ?? noopLogger
    this.onAudit = opts.onAudit
    this.now = opts.now ?? Date.now
  }

  async decide(trigger: Trigger): Promise<DecisionOutcome> {
    if (!this.enabled) {
      return { kind: 'bypassed', reason: 'decision:disabled', rule: 'disabled' }
    }
    const admission = admissionOf(this.contextOf(trigger))
    if (admission.outcome === 'drop') {
      this.audit({ triggerId: trigger.id, provider: this.provider.name, outcome: 'dropped', rule: admission.rule })
      return { kind: 'dropped', reason: admission.reason, rule: admission.rule }
    }
    if (admission.outcome === 'bypass') {
      this.audit({ triggerId: trigger.id, provider: this.provider.name, outcome: 'bypassed', rule: admission.rule })
      return { kind: 'bypassed', reason: admission.reason, rule: admission.rule }
    }

    const started = this.now()
    try {
      const answers = await this.provider.ask({ trigger, admission })
      const invalid = validateAnswers(answers)
      if (invalid) throw new Error(`decision:invalid:${invalid}`)
      const verdict = routeVerdict(answers, toolScopeFor(false))
      this.logger.info('decision:verdict', {
        triggerId: trigger.id,
        chat: trigger.chatId,
        provider: this.provider.name,
        action: verdict.action,
        msgType: verdict.msgType,
        confidence: verdict.confidence,
      })
      this.audit({ triggerId: trigger.id, provider: this.provider.name, outcome: 'verdict', rule: admission.rule, answers, verdict, latencyMs: this.now() - started })
      return { kind: 'verdict', verdict }
    } catch (error) {
      const verdict = fallbackVerdict(toolScopeFor(false))
      this.logger.warn('decision:failed', {
        triggerId: trigger.id,
        chat: trigger.chatId,
        provider: this.provider.name,
        detail: errorMessage(error),
      })
      this.audit({ triggerId: trigger.id, provider: this.provider.name, outcome: 'failed', rule: admission.rule, verdict, latencyMs: this.now() - started, error: errorMessage(error) })
      return { kind: 'verdict', verdict }
    }
  }

  private contextOf(trigger: Trigger): AdmissionContext {
    return {
      text: trigger.text,
      mediaOnly: trigger.mediaOnly,
      isBot: trigger.isBot,
      isAdmin: this.isAdminOf(trigger),
      hasActiveIntake: this.hasActiveIntakeOf?.(trigger),
      hasBoundTicket: this.hasBoundTicketOf?.(trigger),
      isCommand: this.isCommandOf(trigger.text),
    }
  }

  private audit(audit: DecisionAudit): void {
    this.onAudit?.(audit)
  }
}

/** 给 Jev 的 state：只放必要字段，不塞完整 prompt。 */
export function jevStateOf(trigger: Trigger): unknown {
  return {
    message: { text: trigger.text, addressed: trigger.addressed, at: trigger.receivedAt },
    chat: { id: trigger.chatId, name: trigger.chatName },
    actor: { id: trigger.actorId, name: trigger.actorName },
  }
}

/** Jev Provider：把 UserMsgDecision 的问题映射成 Jev 的 questions，再把答案归一化回内核。 */
export class JevDecisionProvider implements DecisionProvider {
  readonly name = 'jev'
  private client: JevClient

  constructor(config: JevConfig, deps: JevClientDeps = {}) {
    this.client = new JevClient(config, deps)
  }

  async ask(ctx: DecisionProviderContext): Promise<DecisionAnswers> {
    const answers = await this.client.ask(jevStateOf(ctx.trigger), {
      needs_followup: { type: 'noul', instructions: '这条普通成员消息是否需要 Router 跟进处理？' },
      msg_type: { type: 'score', instructions: '这条消息属于哪一类？', criteria: ['chitchat 闲聊', 'grumble 吐槽', 'consult 咨询', 'feedback 需求反馈'] },
      project_related: { type: 'noul', instructions: '这条消息是否与本群绑定的项目相关？' },
      urgency: { type: 'noul', instructions: '这条消息的紧迫程度（0=不紧急，1=非常紧急）？' },
    })
    // extractAnswers 按 questions 的 key 全量返回，缺 key 已在 JevClient 抛 malformed；
    // 这里显式收窄 undefined，避免 noUncheckedIndexedAccess 下的类型污染。
    const needsFollowup = answers.needs_followup
    const msgTypeScore = answers.msg_type
    const projectRelated = answers.project_related
    const urgency = answers.urgency
    if (needsFollowup === undefined || msgTypeScore === undefined || projectRelated === undefined || urgency === undefined) {
      throw new Error('decision:answer-missing')
    }
    return {
      needsFollowup,
      msgTypeScore,
      projectRelated,
      urgency,
    }
  }
}

/** LLM Provider：按同一份 spec 由 LLM 模拟决策输出，作为 Jev 不可用时的兜底。 */
export class LlmDecisionProvider implements DecisionProvider {
  readonly name = 'llm'
  private llm: IntakeEngine
  private home?: string

  constructor(llm: IntakeEngine, home?: string) {
    this.llm = llm
    this.home = home
  }

  async ask(ctx: DecisionProviderContext): Promise<DecisionAnswers> {
    const text = await this.llm.run({
      systemPrompt: readRouterPrompt(this.home, 'decision.md'),
      userPrompt: JSON.stringify({
        message: { text: ctx.trigger.text, addressed: ctx.trigger.addressed, at: ctx.trigger.receivedAt },
        chat: { id: ctx.trigger.chatId, name: ctx.trigger.chatName },
      }, null, 2),
      readCode: false,
    })
    const json = extractJsonObject(text)
    if (!json) throw new Error('decision:llm-invalid')
    return {
      needsFollowup: probabilityOf(json.needs_followup),
      msgTypeScore: scoreOf(json.msg_type),
      projectRelated: probabilityOf(json.project_related),
      urgency: probabilityOf(json.urgency),
    }
  }
}

function probabilityOf(value: unknown): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(number)) throw new Error('decision:answer-missing')
  return number
}

/** msg_type 枚举 → 档位下标归一化（0~1），非枚举值直接抛错。 */
function scoreOf(value: unknown): number {
  const index = MEMBER_MESSAGE_KINDS.indexOf(value as (typeof MEMBER_MESSAGE_KINDS)[number])
  if (index < 0) throw new Error('decision:answer-missing')
  return index / (MEMBER_MESSAGE_KINDS.length - 1)
}
