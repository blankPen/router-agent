import type { Decision, Mandate, Strength, Trigger } from './model.js'

export type AcceptMode = 'off' | 'observe' | 'auto'

/**
 * worker 被服务重启打断后的恢复策略。
 *
 * auto：自动补一条输入让 worker 从中断处接着做。
 * notify：只发飞书提醒，等用户回复才恢复。
 * off：完全不处理。
 */
export type InterruptedRecoveryMode = 'auto' | 'notify' | 'off'

/**
 * 群级消息处理范围：谁的消息算数、要不要 @ 机器人。
 *
 * - `admins`：仅接受管理员消息。普通成员说什么都不处理。
 * - `mention`：接受普通用户 @ 消息。普通成员必须 @ 机器人，管理员不受限制。
 * - `all`：接受所有消息。普通成员的普通消息也进流程，由决策层判断要不要跟进。
 */
export type ChatScope = 'admins' | 'mention' | 'all'

export const CHAT_SCOPES: readonly ChatScope[] = ['admins', 'mention', 'all']

export interface Policy {
  version: string
  acceptMode: AcceptMode
  maxWorkers: number
  /** 默认管理员（邮箱或 open_id）：所有群的基线名单。 */
  allowed: string[]
  /** 名单条目解析出的 open_id；缺省时回退到 allowed（旧库兼容）。 */
  allowedOpenIds?: string[]
  /** 群级管理员扩充：非空时在默认管理员之外再加这些人。 */
  allowedByChat?: Record<string, string[]>
  /** 群级名单解析出的 open_id；缺省时回退到 allowedByChat。 */
  allowedByChatOpenIds?: Record<string, string[]>
  /** open_id → 通讯录显示名；只用于展示（喂给模型时写成「名字(ou_xxx)」），不参与匹配。 */
  names?: Record<string, string>
  /** 允许产生推断候选的机器人身份。 */
  bots: string[]
  /** 群级消息处理范围；没配的群按 `mention`。 */
  scopeByChat?: Record<string, ChatScope>
}

export type GateResult =
  | { action: 'explicit'; strength: Extract<Strength, 'explicit'> }
  | { action: 'infer'; strength: Extract<Strength, 'inferred'> }
  | { action: 'reply-only'; strength: Extract<Strength, 'inferred'>; reason: string }
  | { action: 'ignore'; reason: string }

/**
 * 生效的默认管理员名单：优先用解析出的 open_id，没有解析结果时回退到原始条目
 * （旧 `state.db` 里的 policy 行没有新字段，回退即旧行为）。
 */
export function effectiveAllowed(policy: Policy): string[] {
  return policy.allowedOpenIds ?? policy.allowed
}

/**
 * 该群的管理员：默认管理员 + 群内扩充（并集）。
 *
 * 群名单只扩充、不覆盖：没配就用默认名单，配了就把群里额外的人加进来。
 * 群名单配了却一个都没解析出来时，只按默认名单算（解析失败是配置问题，不是安全边界）。
 */
export function effectiveAdmins(policy: Policy, chatId: string): string[] {
  const base = effectiveAllowed(policy)
  const extra = policy.allowedByChatOpenIds?.[chatId] ?? policy.allowedByChat?.[chatId] ?? []
  if (extra.length === 0) return base
  return [...new Set([...base, ...extra])]
}

/** 该群的消息处理范围；没配的群按 `mention`（只认 @ 机器人）。 */
export function scopeOf(policy: Policy, chatId: string): ChatScope {
  return policy.scopeByChat?.[chatId] ?? 'mention'
}

/**
 * 按范围判断一条消息要不要处理。
 *
 * 管理员在任何范围里都算数；普通成员只在 `mention`（必须 @）或 `all` 里算数。
 */
export function admitsByScope(scope: ChatScope, isAdmin: boolean, addressed: boolean): boolean {
  if (isAdmin) return true
  if (scope === 'admins') return false
  if (scope === 'mention') return addressed
  return true
}

/**
 * 三层路由的第一层：确定性 Gate。
 * 不调用任何模型，只看群范围、管理员名单、机器人名单与 accept mode。
 */
export function gate(trigger: Trigger, policy: Policy): GateResult {
  const addressed = trigger.addressed !== 'none'
  const scope = scopeOf(policy, trigger.chatId)
  const listed = effectiveAdmins(policy, trigger.chatId).includes(trigger.actorId)

  if (trigger.isBot) {
    // 机器人永远不能构成显式请求：要么被列入 bots 成为推断候选，要么直接忽略。
    if (!policy.bots.includes(trigger.actorId)) return { action: 'ignore', reason: 'bot:not-listed' }
    if (!addressed && scope !== 'all') return { action: 'ignore', reason: 'bot:not-addressed' }
    return applyAcceptMode({ action: 'infer', strength: 'inferred' }, policy)
  }

  // 设计文档 2.3：私聊 bot 进入研判，不构成显式授权；只有 @机器人 才是显式。
  if (trigger.addressed === 'direct') {
    return applyAcceptMode({ action: 'infer', strength: 'inferred' }, policy)
  }

  if (!admitsByScope(scope, listed, addressed)) {
    return {
      action: 'ignore',
      reason: scope === 'admins' ? 'admission:not-admin' : 'admission:not-addressed',
    }
  }
  // 管理员：@ 了机器人是显式请求，没 @ 只是推断候选。
  if (listed) {
    return addressed ? { action: 'explicit', strength: 'explicit' } : applyAcceptMode({ action: 'infer', strength: 'inferred' }, policy)
  }
  // 普通成员：一律按推断候选，不给显式授权（工具层也没有开单权限）。
  return applyAcceptMode({ action: 'infer', strength: 'inferred' }, policy)
}

/**
 * 未 @ 机器人的消息要不要处理（回话 / 记录会话）。
 *
 * 只有「接受所有消息」的群才回话：没 @ 机器人时也要接上话。
 * 其它群里没 @ 的消息只进决策层（管理员的需求照样能被研判），但不主动插话。
 */
export function handlesUnaddressed(policy: Policy, chatId: string): boolean {
  return scopeOf(policy, chatId) === 'all'
}

/**
 * 是否给收到的消息加「收到」表情。
 *
 * 两个条件同时成立才加：
 * 1. 确实在跟机器人说话：@ / 私聊，或本来就会回话（接受所有消息的群）；
 * 2. 准入 Gate 不会静默忽略：被群范围拦下的消息不加。
 *
 * 否则用户会先看到「Typing」，然后永远等不到回复，表情也不会被撤销。
 */
export function shouldAcknowledge(trigger: Trigger, policy: Policy): boolean {
  const verdict = gate(trigger, policy)
  if (verdict.action === 'ignore') return false
  if (trigger.addressed !== 'none') return true
  // 未 @ 但被放行的消息（tk-59）Router 一定会处理（投给工单的 worker），表情必须跟着走。
  if (trigger.unaddressedAdmitted) return true
  return handlesUnaddressed(policy, trigger.chatId)
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
  // 名单改成邮箱后，这里必须按解析结果判定，否则在途工单会被判成 sender:not-allowed 直接失效。
  if (!effectiveAdmins(policy, mandate.chatId).includes(mandate.actorId)) {
    return { valid: false, reason: 'sender:not-allowed' }
  }
  return { valid: true }
}
