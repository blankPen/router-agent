/**
 * 模型调用失败的分类与对外文案。
 *
 * 背景：模型不可用时（没额度 / 限流 / 超时 / 鉴权失败），Router 原本会退回一句
 * 「还没看出具体要做什么」的兜底话术，把「服务挂了」说成「需求不明确」，
 * 用户既看不到原因，也不知道该做什么。这里统一把失败原因翻译成能直接告知用户的中文，
 * 同时保留原始原因用于日志与面板排查。
 */

/** 失败类型。 */
export type ModelFailureKind =
  | 'quota'
  | 'rate-limit'
  | 'auth'
  | 'timeout'
  | 'budget'
  | 'network'
  | 'config'
  | 'output'
  | 'unknown'

/** 失败发生在哪个环节：研判（决定开不开单）还是回复（寒暄 / 追问的一句话）。 */
export type ModelFailureAction = 'assess' | 'reply'

export interface ModelFailure {
  kind: ModelFailureKind
  /** 原始原因（截断），给日志与面板排查用。 */
  detail: string
  /** 从原始错误里抽出的服务方说明（例如额度提示原文），没有则为空。 */
  hint: string
}

const MAX_DETAIL = 300
const MAX_HINT = 200

const QUOTA_PATTERN = /用量上限|额度不足|额度已用完|额度已耗尽|quota|insufficient_quota|积分不足|余额不足|用量已达|超出.{0,4}额度/i
const RATE_LIMIT_PATTERN = /rate_limit|\b429\b|too many requests|请求过于频繁|限流/i
const AUTH_PATTERN = /\b(401|403)\b|unauthorized|forbidden|api[_ -]?key|鉴权|认证失败|密钥/i
const TIMEOUT_PATTERN = /timeout|timed out|超时|ETIMEDOUT/i
const BUDGET_PATTERN = /token[-_ ]?budget|context[_ -]?length|上下文.{0,6}超|超出最大|too many tokens/i
const NETWORK_PATTERN = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|fetch failed|network|网络|连接失败|dns/i
const CONFIG_PATTERN = /model-config-missing|model-not-found|未配置|缺少\s*baseUrl/i
const OUTPUT_PATTERN = /no-decision|empty-reply|未产出决定|未给出可解析|非法决定|invalid-json/i

/**
 * 把一次模型失败归类。
 *
 * 判定顺序有讲究：
 * - 额度耗尽通常也带 429 / rate_limit，额度是最可操作的原因，排在最前；
 * - 没配置好也会提到 apiKey，比「鉴权失败」更具体，排在鉴权之前；
 * - 超时与 token 预算都比网络错误更具体，也都排在网络之前。
 */
export function classifyModelFailure(reason: string): ModelFailure {
  const text = reason.trim()
  const detail = truncate(text, MAX_DETAIL)
  const hint = extractProviderMessage(text)
  const kind = detectKind(text)
  return { kind, detail, hint }
}

/**
 * 直接拿到可以发给用户的一句话。
 *
 * @param reason  原始失败原因（引擎抛出的 message 或 unavailableReason）。
 * @param action  失败发生的环节，决定文案里说的是「没开工」还是「没回复」。
 */
export function modelFailureMessage(reason: string, action: ModelFailureAction = 'assess'): string {
  const failure = classifyModelFailure(reason)
  const verb = action === 'assess' ? '这轮没能开工，也没有建单' : '这轮没能回复你'
  switch (failure.kind) {
    case 'quota':
      return `模型额度已经用完了${failure.hint ? `（${failure.hint}）` : ''}，${verb}。请给模型账号充值或升级套餐，然后再发一次。`
    case 'rate-limit':
      return `模型接口现在限流了，${verb}。稍等一会儿再发一次就行。`
    case 'auth':
      return `模型接口鉴权没通过（API Key 无效或没有权限），${verb}。请检查 llm.apiKey 配置。`
    case 'timeout':
      return `模型接口这次超时了，${verb}。可以稍后再发一次。`
    case 'budget':
      return `这次请求超出了模型允许的上下文或额度上限，${verb}。可以把需求拆短一点再试。`
    case 'network':
      return `连不上模型服务（网络问题），${verb}。稍后再试一次。`
    case 'config':
      return `模型没配置好（缺少 baseUrl / apiKey / model），${verb}。请先补全 llm 配置。`
    case 'output':
      return `模型这次没给出能用的结论，${verb}。可以再发一次。`
    default:
      return `模型这次调用失败，${verb}。原始原因：${failure.detail || '没有更多细节'}`
  }
}

function detectKind(text: string): ModelFailureKind {
  if (QUOTA_PATTERN.test(text)) return 'quota'
  if (CONFIG_PATTERN.test(text)) return 'config'
  if (RATE_LIMIT_PATTERN.test(text)) return 'rate-limit'
  if (AUTH_PATTERN.test(text)) return 'auth'
  if (TIMEOUT_PATTERN.test(text)) return 'timeout'
  if (BUDGET_PATTERN.test(text)) return 'budget'
  if (NETWORK_PATTERN.test(text)) return 'network'
  if (OUTPUT_PATTERN.test(text)) return 'output'
  return 'unknown'
}

/** 从 `"message":"..."` 形态的错误里抽出服务方的原始说明。 */
function extractProviderMessage(text: string): string {
  const match = text.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (!match) return ''
  try {
    const parsed = JSON.parse(`"${match[1]}"`) as unknown
    return typeof parsed === 'string' ? truncate(parsed, MAX_HINT) : ''
  } catch {
    return truncate(match[1] ?? '', MAX_HINT)
  }
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max)}…` : single
}
