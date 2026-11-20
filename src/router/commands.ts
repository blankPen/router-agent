/**
 * Router 指令口令的解析。
 *
 * 这里只放「一句话是不是某条口令」的判定，**不放任何 prompt 构造或 JSON 解析**——
 * 那两类在 intake.ts 里，与本文件是不相关的职责。
 *
 * 所有口令都是**精确匹配整条消息**（去掉首尾空白后），不做子串匹配：
 * 口令出现在一段解释里不应该被当成指令。
 */

/** 归一化：去首尾空白、去掉内部连续空白。 */
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, '')
}

/**
 * 终审关键词：管理员在需求单话题里回复这些词即视为通过。
 *
 * 不收「ok」「好」这类通用应答：一句「好」很容易是随口附和，
 * 把它当成派单确认等于让需求单在没人真正拍板的时候进了排期。
 */
export function isApprovalCommand(text: string): boolean {
  const normalized = normalize(text)
  if (!normalized || normalized.length > 20) return false
  if (/不(用|需要|要)(派单|开单|处理|确认)|别(派单|开单)|驳回|拒绝|不用了|算了/.test(normalized)) return false
  return /^(确认派单|确认开单|确认|通过|同意|可以派单|派单|开工|开单|approve)$/i.test(normalized)
}

/** 驳回关键词；只认短句，避免把管理员的一段解释误判成驳回。 */
export function isRejectionCommand(text: string): boolean {
  const normalized = normalize(text)
  if (!normalized || normalized.length > 30) return false
  return /^(驳回|拒绝|不需要|不用处理|不用派单|不派单|关闭|reject|close)$/i.test(normalized)
}

/** 发起人主动放弃澄清。 */
export function isDismissCommand(text: string): boolean {
  const normalized = normalize(text)
  if (!normalized || normalized.length > 20) return false
  return /^(不用了|算了|没事了|不用管了|不问了|取消|cancel|nevermind|never mind)$/i.test(normalized)
}

/** `/new`：只有整条消息就是命令时才生效，允许前面带一个 @机器人。 */
export function parseSessionResetCommand(text: string): boolean {
  return /^\s*(?:@\S+\s+)?\/new\s*$/.test(text)
}

/** 已关闭话题里，用户明确要求继续的关键词。 */
const REOPEN_PATTERN = /重新开工|重新开单|重开|继续做|继续干|接着做|接着干|继续|reopen|retry|continue/i

/** 用户是否要求在已关闭的话题里重开。 */
export function isReopenRequest(text: string): boolean {
  const normalized = text.trim()
  // 先排除「不用继续 / 别重开」这类否定表达，避免把收尾消息当成重开。
  if (/不(用|需要|想|必)(继续|重开|重新)|别(继续|重开|重新)|不要(继续|重开|重新)/.test(normalized)) return false
  return REOPEN_PATTERN.test(normalized)
}
