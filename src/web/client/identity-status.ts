/**
 * 允许名单解析状态的展示逻辑。
 *
 * 服务端把名单里的「邮箱 / open_id」解析成 open_id 后，把每个条目的状态回传给面板；
 * 这里只做纯展示计算（掩码、汇总），不引 React，方便单测覆盖。
 *
 * 语义约束：
 * - 邮箱只以掩码形态出现在界面上（`p***@dewu.com`），不渲染完整邮箱；
 * - 解析失败不阻断保存，提示只是提醒，不是「保存失败」。
 */

/** 条目形态：邮箱 / open_id / 非法。 */
export type IdentityKind = 'email' | 'open_id' | 'invalid'
/** 条目状态：已解析 / 确认失败 / 待重试。 */
export type IdentityStatus = 'resolved' | 'invalid' | 'pending'

export interface IdentityEntryView {
  /** 用户原样填写的条目。 */
  entry: string
  kind: IdentityKind
  status: IdentityStatus
  /** 通讯录显示名，取不到时为空。 */
  name: string
  /** 失败原因（服务端已掩码邮箱）。 */
  detail: string
}

export interface IdentityStatusView {
  /** 全局名单 + 群级名单的条目状态。 */
  entries: IdentityEntryView[]
  bot: { botOpenIds: string[]; botNames: string[]; resolved: boolean; detail: string }
  invalidCount: number
  pendingCount: number
}

/** 提示条：与面板里其它提示（如保存结果）同一种形态。 */
export interface IdentitySummary {
  kind: 'ok' | 'warn' | 'error'
  text: string
}

/**
 * 把服务端快照归一成结构完整的小对象。
 *
 * `identity` 字段本身是可选的（兼容旧服务端），但旧 / 异常服务端可能只返回 `{}` 或缺 `bot`。
 * 面板不能因为缺字段在渲染期抛错、拖垮整个配置页，所以统一在这里兜底：
 * - 缺 `entries` 当空数组；
 * - 缺 `bot` 当一个良性缺省 bot（`resolved: true`，未启用/无需识别不是失败）；
 * - 缺计数当 0。
 */
export function normalizeIdentityStatus(status: Partial<IdentityStatusView> | null | undefined): IdentityStatusView {
  const source = status ?? {}
  const bot = (source.bot ?? {}) as Partial<IdentityStatusView['bot']>
  return {
    entries: Array.isArray(source.entries) ? source.entries : [],
    bot: {
      botOpenIds: Array.isArray(bot.botOpenIds) ? bot.botOpenIds : [],
      botNames: Array.isArray(bot.botNames) ? bot.botNames : [],
      resolved: typeof bot.resolved === 'boolean' ? bot.resolved : true,
      detail: typeof bot.detail === 'string' ? bot.detail : '',
    },
    invalidCount: typeof source.invalidCount === 'number' ? source.invalidCount : 0,
    pendingCount: typeof source.pendingCount === 'number' ? source.pendingCount : 0,
  }
}

/** 邮箱掩码：只留首字符，域名保留（`p***@dewu.com`），与后端保持一致。 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return email
  return `${email.slice(0, 1)}***${email.slice(at)}`
}

/** 条目的展示文本：邮箱只显示掩码后的形态，其余原样。 */
export function describeEntry(entry: IdentityEntryView): string {
  const label = entry.kind === 'email' ? maskEmail(entry.entry) : entry.entry
  const parts = [label]
  if (entry.name) parts.push(entry.name)
  if (entry.status === 'invalid') parts.push(`解析失败${entry.detail ? `：${entry.detail}` : ''}`)
  if (entry.status === 'pending') parts.push(`待重试${entry.detail ? `：${entry.detail}` : ''}`)
  return parts.join(' · ')
}

/**
 * 名单解析状态汇总。
 *
 * 没拿到状态（旧版服务端）时返回正常提示，不打扰用户；
 * 解析失败是错误级提醒——这些人的消息确实收不到；
 * 待重试只是警告——通讯录暂时查不到，稍后会再试。
 */
export function summarizeIdentity(status: IdentityStatusView | undefined): IdentitySummary {
  if (!status) return { kind: 'ok', text: '尚未获取到允许名单的解析状态。' }
  const normalized = normalizeIdentityStatus(status)
  if (normalized.invalidCount > 0) {
    return { kind: 'error', text: `有 ${normalized.invalidCount} 个允许名单条目没能解析到，这些人的消息不会被接收。` }
  }
  if (normalized.pendingCount > 0) {
    return { kind: 'warn', text: `有 ${normalized.pendingCount} 个允许名单条目还在待重试，稍后会自动再解析。` }
  }
  if (normalized.entries.length === 0) return { kind: 'ok', text: '允许名单为空，没有配置任何成员。' }
  return { kind: 'ok', text: `允许名单 ${normalized.entries.length} 项都已解析成功。` }
}

/**
 * 机器人身份汇总。
 *
 * 机器人身份没识别出来时，@ 模式的消息收不到——这正是这次事故的形态，所以按错误级提示。
 *
 * 不再从草稿里的群配置反推「有没有 @ 模式」：后端快照按**已保存配置**计算，
 * 「无需识别」已经被表达成 `resolved: true`，前端只要看到 `resolved === false` 就是真失败。
 */
export function summarizeBot(status: IdentityStatusView | undefined): IdentitySummary {
  if (!status) return { kind: 'ok', text: '尚未获取到机器人身份状态。' }
  const normalized = normalizeIdentityStatus(status)
  if (!normalized.bot.resolved) {
    const detail = normalized.bot.detail ? `（${normalized.bot.detail}）` : ''
    return { kind: 'error', text: `机器人身份没识别出来，@ 模式的消息不会被接收${detail}。` }
  }
  const names = normalized.bot.botNames.join('、')
  const label = names || normalized.bot.botOpenIds.join('、')
  return { kind: 'ok', text: label ? `机器人身份已识别：${label}` : '机器人身份已识别。' }
}

/** 有问题的条目（解析失败 / 待重试），供面板逐条列出。 */
export function problemEntries(status: IdentityStatusView | undefined): IdentityEntryView[] {
  if (!status) return []
  return normalizeIdentityStatus(status).entries.filter(entry => entry.status !== 'resolved')
}
