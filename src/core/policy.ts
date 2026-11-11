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
  /** 允许发起工作的原始条目（邮箱或 open_id）。 */
  allowed: string[]
  /** 名单条目解析出的 open_id；缺省时回退到 allowed（旧库兼容）。 */
  allowedOpenIds?: string[]
  /** 群级白名单：非空时该群只允许这些人操作，覆盖全局 allowed。 */
  allowedByChat?: Record<string, string[]>
  /** 群级白名单解析出的 open_id；缺省时回退到 allowedByChat。 */
  allowedByChatOpenIds?: Record<string, string[]>
  /** open_id → 通讯录显示名；只用于展示（喂给模型时写成「名字(ou_xxx)」），不参与匹配。 */
  names?: Record<string, string>
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
 * 生效的全局名单：优先用解析出的 open_id，没有解析结果时回退到原始条目
 * （旧 `state.db` 里的 policy 行没有新字段，回退即旧行为）。
 */
export function effectiveAllowed(policy: Policy): string[] {
  return policy.allowedOpenIds ?? policy.allowed
}

/**
 * 生效的群级名单。
 *
 * 返回值有三种形态，调用方必须分清：
 * - `undefined`：该群没配名单 → 沿用全局名单；
 * - 非空数组：该群生效的 open_id 列表；
 * - 空数组：配了名单但一个都没解析出来 → **该群拒绝所有人**，
 *   绝不能退回全局名单（那比用户原意更宽松，是安全倒退）。
 */
export function effectiveAllowedByChat(policy: Policy, chatId: string): string[] | undefined {
  const scoped = policy.allowedByChat?.[chatId]
  if (!scoped || scoped.length === 0) return undefined
  return policy.allowedByChatOpenIds?.[chatId] ?? scoped
}

/**
 * 三层路由的第一层：确定性 Gate。
 * 不调用任何模型，只看名单、寻址方式、机器人名单与 accept mode。
 */
export function gate(trigger: Trigger, policy: Policy): GateResult {
  const addressed = trigger.addressed !== 'none'
  // 群级白名单：配置了就只认这一份，名单外的人在该群完全无效（不接单、不回复）。
  const scoped = effectiveAllowedByChat(policy, trigger.chatId)
  // 配了群名单但一个都没解析出来：这个群谁都不许进，也不能退回全局名单。
  if (scoped && scoped.length === 0) {
    return { action: 'ignore', reason: 'admission:chat-allowlist-empty' }
  }
  const listed = (scoped ?? effectiveAllowed(policy)).includes(trigger.actorId)

  if (trigger.isBot) {
    // 机器人永远不能构成显式请求：要么被列入 bots 成为推断候选，要么直接忽略。
    if (!policy.bots.includes(trigger.actorId)) return { action: 'ignore', reason: 'bot:not-listed' }
    if (!addressed && !policy.receiveAll) return { action: 'ignore', reason: 'bot:not-receive-all' }
    return applyAcceptMode({ action: 'infer', strength: 'inferred' }, policy)
  }

  if (scoped && !listed) {
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

/**
 * 是否给收到的消息加「收到」表情。
 *
 * 两个条件同时成立才加：
 * 1. 确实在跟机器人说话：@ / 私聊，或所在群配置为全量接收；
 * 2. 准入 Gate 不会静默忽略：被群白名单拦截、`admission: ignore` 的消息不加。
 *
 * 否则用户会先看到「Typing」，然后永远等不到回复，表情也不会被撤销。
 */
export function shouldAcknowledge(trigger: Trigger, policy: Policy, replyAlwaysChats: ReadonlySet<string>): boolean {
  if (trigger.addressed === 'none' && !replyAlwaysChats.has(trigger.chatId)) return false
  return gate(trigger, policy).action !== 'ignore'
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
  const scoped = effectiveAllowedByChat(policy, mandate.chatId)
  const allowed = scoped ?? effectiveAllowed(policy)
  if (!allowed.includes(mandate.actorId)) return { valid: false, reason: 'sender:not-allowed' }
  return { valid: true }
}
