/**
 * 确定性准入：任何消息先过这里，再决定是否交给决策层（Jev / LLM）。
 *
 * 规则只做形态判断与身份分流，语义判断一律交给决策模型。
 * 管理员在这里被分走、直进 RouterAgent；纯寒暄在这里被忽略，不产生模型调用。
 */

export type AdmissionOutcome = 'drop' | 'bypass' | 'pass'

export type AdmissionRuleName =
  | 'bot'
  | 'media-only'
  | 'command'
  | 'active-intake'
  | 'bound-ticket'
  | 'identity-split'
  | 'noise'
  | 'pass'

export interface AdmissionContext {
  /** 消息文本；纯附件消息也是占位文本，靠 mediaOnly 判断。 */
  text: string
  mediaOnly?: boolean
  isBot?: boolean
  /** 发送人是否在管理员名单；是则直进 RouterAgent。 */
  isAdmin?: boolean
  /** 该发起人已有活跃需求会话：续接分析，不重复决策。 */
  hasActiveIntake?: boolean
  /** 话题已绑定在办工单：走工单相关路径，不做需求分类。 */
  hasBoundTicket?: boolean
  /** 命令口令（/new、确认派单、驳回等）：由 Router 处理。 */
  isCommand?: boolean
}

export interface AdmissionVerdict {
  outcome: AdmissionOutcome
  rule: AdmissionRuleName
  /** 稳定的机器可读原因，进日志与审计。 */
  reason: string
}

/** 显式 @ 也可能是寒暄/测试；只匹配纯寒暄，不误伤简短需求（如「修个 bug」）。 */
const SMALL_TALK_PATTERN = /^(?:你好|您好|hi|hello|hey|在吗|在不在|在么|谢谢|thanks|辛苦了|收到|好的|ok|早上好|晚上好|测试一下|测试|test|哈+|嗯+|哦+|在)+$/i

/** 去掉标点与空白后只由寒暄词组成才算闲聊（容许「你好在吗」这类拼接）。 */
export function isSmallTalk(text: string): boolean {
  const normalized = text.replace(/[\s!！。.，,~～?？、:：]+/g, '').toLowerCase()
  if (!normalized || normalized.length > 20) return false
  return SMALL_TALK_PATTERN.test(normalized)
}

/**
 * 准入判定：按固定顺序走规则，命中即返回，不再继续。
 * 顺序即优先级：bot > 媒体 > 口令 > 活跃会话 > 绑定工单 > 身份分流 > 噪声。
 */
export function admissionOf(ctx: AdmissionContext): AdmissionVerdict {
  if (ctx.isBot) return { outcome: 'drop', rule: 'bot', reason: 'bot:messages-ignored' }
  if (ctx.mediaOnly) return { outcome: 'bypass', rule: 'media-only', reason: 'media:needs-text' }
  if (ctx.isCommand) return { outcome: 'bypass', rule: 'command', reason: 'command:router-handles' }
  if (ctx.hasActiveIntake) return { outcome: 'bypass', rule: 'active-intake', reason: 'intake:continue-session' }
  if (ctx.hasBoundTicket) return { outcome: 'bypass', rule: 'bound-ticket', reason: 'ticket:bound-path' }
  // 身份分流：管理员直进 RouterAgent，普通成员才进决策层。
  if (ctx.isAdmin) return { outcome: 'bypass', rule: 'identity-split', reason: 'identity:admin-direct' }
  // 噪声门槛：纯寒暄不进决策层，直接忽略（默认宽松：不确定就放行）。
  if (isSmallTalk(ctx.text)) return { outcome: 'drop', rule: 'noise', reason: 'noise:small-talk' }
  return { outcome: 'pass', rule: 'pass', reason: 'pass:to-decision' }
}
