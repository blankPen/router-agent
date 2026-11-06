import type { Decision, Mandate, Strength, Trigger } from './model.js'

export type AcceptMode = 'off' | 'observe' | 'auto'

/** 准入表：三列分别对应「名单内未寻址 / 名单外已寻址 / 名单外未寻址」。 */
export interface AdmissionTable {
  listedNotAddressed: 'inferred' | 'ignore'
  unlistedAddressed: 'explicit' | 'inferred' | 'ignore'
  unlistedNotAddressed: 'inferred' | 'ignore'
}

export interface Policy {
  version: string
  acceptMode: AcceptMode
  maxWorkers: number
  /** 允许发起工作的身份（飞书 open_id / GitHub login）。 */
  allowed: string[]
  /** 群级白名单：非空时该群只允许这些人操作，覆盖全局 allowed。 */
  allowedByChat?: Record<string, string[]>
  /** 允许产生推断候选的机器人身份。 */
  bots: string[]
  admission: AdmissionTable
  /** 该范围是否接收全部消息；false 表示只接收 @bot 与私聊。 */
  receiveAll: boolean
}

export type GateResult =
  | { action: 'explicit'; strength: Extract<Strength, 'explicit'> }
  | { action: 'infer'; strength: Extract<Strength, 'inferred'> }
  | { action: 'reply-only'; strength: Extract<Strength, 'inferred'>; reason: string }
  | { action: 'ignore'; reason: string }

export const DEFAULT_ADMISSION: AdmissionTable = {
  listedNotAddressed: 'inferred',
  unlistedAddressed: 'inferred',
  unlistedNotAddressed: 'ignore',
}

/**
 * 三层路由的第一层：确定性 Gate。
 * 不调用任何模型，只看名单、寻址方式、机器人名单与 accept mode。
 */
export function gate(trigger: Trigger, policy: Policy): GateResult {
  const addressed = trigger.addressed !== 'none'
  // 群级白名单：配置了就只认这一份，名单外的人在该群完全无效（不接单、不回复）。
  const scoped = policy.allowedByChat?.[trigger.chatId]
  const restricted = Boolean(scoped && scoped.length > 0)
  const listed = (restricted ? scoped! : policy.allowed).includes(trigger.actorId)

  if (trigger.isBot) {
    // 机器人永远不能构成显式请求：要么被列入 bots 成为推断候选，要么直接忽略。
    if (!policy.bots.includes(trigger.actorId)) return { action: 'ignore', reason: 'bot:not-listed' }
    if (!addressed && !policy.receiveAll) return { action: 'ignore', reason: 'bot:not-receive-all' }
    return applyAcceptMode({ action: 'infer', strength: 'inferred' }, policy)
  }

  if (restricted && !listed) {
    return { action: 'ignore', reason: 'admission:not-in-chat-allowlist' }
  }

  // 设计文档 2.3：私聊 bot 进入研判，不构成显式授权；只有 @机器人 才是显式。
  if (trigger.addressed === 'direct') {
    return applyAcceptMode({ action: 'infer', strength: 'inferred' }, policy)
  }

  let cell: 'explicit' | 'inferred' | 'ignore'
  if (addressed) {
    cell = listed ? 'explicit' : policy.admission.unlistedAddressed
  } else {
    cell = listed ? policy.admission.listedNotAddressed : policy.admission.unlistedNotAddressed
  }

  if (cell === 'ignore') {
    return { action: 'ignore', reason: addressed ? 'admission:unlisted-addressed' : listed ? 'admission:listed-not-addressed' : 'admission:unlisted-not-addressed' }
  }
  if (cell === 'explicit') return { action: 'explicit', strength: 'explicit' }
  return applyAcceptMode({ action: 'infer', strength: 'inferred' }, policy)
}

function applyAcceptMode(result: Extract<GateResult, { action: 'infer' }>, policy: Policy): GateResult {
  if (policy.acceptMode === 'off') {
    return { action: 'reply-only', strength: 'inferred', reason: 'accept-mode:off' }
  }
  return result
}

export interface Acceptance {
  decision: Decision
  wouldAccept: boolean
}

/** observe 模式下，推断候选的 accept 被降级为「记录但不开工」。 */
export function negotiateAcceptance(decision: Decision, strength: Strength, mode: AcceptMode): Acceptance {
  if (decision === 'accept' && strength === 'inferred' && mode === 'observe') {
    return { decision: 'ignore', wouldAccept: true }
  }
  return { decision, wouldAccept: false }
}

export type Revalidation = { valid: true } | { valid: false; reason: string }

/** 工单恢复前对当前策略做重新校验；不主动撤销在途 Mandate。 */
export function revalidateMandate(mandate: Mandate, policy: Policy): Revalidation {
  if (mandate.strength === 'explicit') return { valid: true }
  if (policy.acceptMode !== 'auto') return { valid: false, reason: 'accept-mode:not-auto' }
  const scoped = policy.allowedByChat?.[mandate.chatId]
  const allowed = scoped && scoped.length > 0 ? scoped : policy.allowed
  if (!allowed.includes(mandate.actorId)) return { valid: false, reason: 'sender:not-allowed' }
  return { valid: true }
}
