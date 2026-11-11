import type { CommandRunner } from '../infra/process.js'
import { errorMessage, noopLogger, type Logger } from '../infra/logger.js'

/**
 * 飞书身份条目解析器。
 *
 * 允许名单里的条目有两种写法：邮箱（推荐）或 `ou_` 开头的 open_id（兼容）。
 * 这里把条目解析成 open_id 与通讯录显示名，并严格区分两类失败：
 *
 * - `invalid`：确认解析不出来（格式不对 / 查无此人 / open_id 跨应用）→ 条目丢弃；
 * - `pending`：暂时查不了（权限缺失 / lark-cli 不可用 / 超时）→ **条目保留**，下次重试。
 *
 * 把权限问题当成「查无此人」会让整份允许名单被清空，机器人突然谁都不理——
 * 那正是这次改造要消灭的静默失效，所以两类必须分开。
 */

export type IdentityKind = 'email' | 'open_id' | 'invalid'
export type IdentityStatus = 'resolved' | 'invalid' | 'pending'

export interface IdentityEntry {
  /** 用户原样填写的条目。 */
  entry: string
  kind: IdentityKind
  /** 解析出的 open_id；没解析出来时为空。 */
  openId: string
  /** 通讯录显示名；取不到时为空。 */
  name: string
  status: IdentityStatus
  /** 失败原因（邮箱已掩码）。 */
  detail: string
}

export interface IdentityResolution {
  entries: IdentityEntry[]
  /** 解析成功的 open_id，去重。 */
  openIds: string[]
  /** open_id → 显示名。 */
  names: Map<string, string>
  invalid: IdentityEntry[]
  pending: IdentityEntry[]
}

/** 解析结果缓存；键里带 appId，换应用后自然失效。 */
export interface IdentityCache {
  get(appId: string, kind: 'email' | 'open_id', value: string): { openId: string; name: string } | null
  set(appId: string, kind: 'email' | 'open_id', value: string, openId: string, name: string): void
}

/** open_id 跨应用：当前应用查不到这个 id。 */
const CODE_CROSS_APP = '99992361'
/** open_id 无效 / 不存在。 */
const CODE_NOT_FOUND = '99992351'

/** 通讯录调用超时；超时按「暂时查不了」处理，条目保留待重试。 */
const CONTACT_TIMEOUT_MS = 20_000

/**
 * `batch_get_id` 单次请求的邮箱数量上限。
 *
 * 飞书 `contact/v3/users/batch_get_id` 对 `emails` 数组有数量上限（本项目未实测，
 * 这里按 50 取保守值）。超限时接口会直接报错，整批条目都会变成「待重试」，
 * 下游按 open_ids 重建名单时等于被清空——和这次要消灭的故障是同一种表现，
 * 所以必须分片请求，单片失败只影响该片。
 */
const BATCH_GET_ID_EMAIL_LIMIT = 50

/** 错误详情最多保留这么多个字符，避免日志被长文本撑爆。 */
const DETAIL_MAX = 200

/** 判定条目形态：邮箱 / open_id / 非法。 */
export function classifyEntry(raw: string): { kind: IdentityKind; value: string } {
  const value = String(raw ?? '').trim()
  if (!value) return { kind: 'invalid', value }
  if (value.includes('@')) return { kind: 'email', value }
  if (value.startsWith('ou_')) return { kind: 'open_id', value }
  return { kind: 'invalid', value }
}

/** 邮箱掩码：只留首字符，域名保留（`p***@dewu.com`）。 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return email
  const local = email.slice(0, at)
  return `${local.slice(0, 1)}***${email.slice(at)}`
}

/** 解析 `batch_get_id` 的返回：email（小写）→ open_id。查无此人的条目不会出现在映射里。 */
export function parseBatchGetId(stdout: string): Map<string, string> {
  return parseBatchPayload(stdout).map
}

/** 解析 `contact +get-user` 的返回；拿不到用户时返回 null。 */
export function parseContactUser(stdout: string): { openId: string; userId: string; name: string; email: string } | null {
  const payload = parseContactPayload(stdout)
  return payload.user
}

export class IdentityResolver {
  private readonly lark: CommandRunner
  private readonly appId: string
  private readonly cache?: IdentityCache
  private readonly logger: Logger

  constructor(opts: { lark: CommandRunner; appId?: string; cache?: IdentityCache; logger?: Logger }) {
    this.lark = opts.lark
    this.appId = opts.appId ?? ''
    this.cache = opts.cache
    this.logger = opts.logger ?? noopLogger
  }

  async resolveEntries(entries: readonly string[]): Promise<IdentityResolution> {
    const raw = entries.map(entry => String(entry ?? ''))
    const kinds = raw.map(entry => classifyEntry(entry).kind)
    const result: IdentityEntry[] = raw.map((entry, index) => ({
      entry,
      kind: kinds[index] ?? 'invalid',
      openId: '',
      name: '',
      status: 'invalid',
      detail: '',
    }))

    await this.resolveInvalid(result, kinds)
    await this.resolveOpenIds(result, kinds)
    await this.resolveEmails(result, kinds)

    const openIds: string[] = []
    const names = new Map<string, string>()
    const invalid: IdentityEntry[] = []
    const pending: IdentityEntry[] = []
    for (const entry of result) {
      // 只要拿到了 open_id 就进名单：用户手填的 ou_xxx 即使这次没验证成，
      // 也不会匹配到别人（open_id 是应用内唯一的），先保住名单再等下次重试。
      if (entry.openId && !openIds.includes(entry.openId)) openIds.push(entry.openId)
      if (entry.openId && entry.name) names.set(entry.openId, entry.name)
      if (entry.status === 'invalid') invalid.push(entry)
      else if (entry.status === 'pending') pending.push(entry)
    }
    return { entries: result, openIds, names, invalid, pending }
  }

  /** 非法条目：不是邮箱也不是 open_id，直接判 invalid。 */
  private async resolveInvalid(result: IdentityEntry[], kinds: IdentityKind[]): Promise<void> {
    for (let index = 0; index < result.length; index += 1) {
      if (kinds[index] !== 'invalid') continue
      const entry = result[index]!
      entry.status = 'invalid'
      entry.detail = '不是邮箱，也不是 ou_ 开头的 open_id'
      this.logger.warn('identity:resolve-failed', { entry: entry.entry, detail: entry.detail })
    }
  }

  /** open_id 条目：查缓存 → 查通讯录拿名字。 */
  private async resolveOpenIds(result: IdentityEntry[], kinds: IdentityKind[]): Promise<void> {
    for (let index = 0; index < result.length; index += 1) {
      if (kinds[index] !== 'open_id') continue
      const entry = result[index]!
      const openId = entry.entry.trim()

      const cached = this.readCache('open_id', openId)
      if (cached) {
        entry.status = 'resolved'
        entry.openId = cached.openId || openId
        entry.name = cached.name
        this.logResolved(entry)
        continue
      }

      const payload = await this.fetchContactUser(openId)
      if (payload.status === 'ok' && payload.user) {
        entry.status = 'resolved'
        entry.openId = payload.user.openId || openId
        entry.name = payload.user.name
        // 只有名字也拿到了才写缓存：只缓存空名字会让下次解析直接命中一个没有名字的缓存。
        if (entry.name) this.writeCache('open_id', openId, entry.openId, entry.name)
        this.logResolved(entry)
        continue
      }
      if (payload.status === 'invalid') {
        entry.status = 'invalid'
        entry.detail = payload.detail
        this.logger.warn('identity:resolve-failed', { entry: entry.entry, detail: entry.detail })
        continue
      }
      // 暂时查不了：条目保留，open_id 就是用户填的值，先按它继续匹配。
      entry.status = 'pending'
      entry.openId = openId
      entry.detail = payload.detail
      this.logger.warn('identity:resolve-deferred', { entry: entry.entry, detail: entry.detail })
    }
  }

  /** 邮箱条目：查缓存 → 分批 batch_get_id → 补通讯录显示名。 */
  private async resolveEmails(result: IdentityEntry[], kinds: IdentityKind[]): Promise<void> {
    const needBatch: number[] = []
    for (let index = 0; index < result.length; index += 1) {
      if (kinds[index] !== 'email') continue
      const entry = result[index]!
      const email = entry.entry.trim()
      const cached = this.readCache('email', email)
      if (cached) {
        entry.status = 'resolved'
        entry.openId = cached.openId
        entry.name = cached.name
        this.logResolved(entry)
        continue
      }
      needBatch.push(index)
    }
    if (needBatch.length === 0) return

    // 同一个邮箱只查一次；分片时单片失败只影响该片的条目。
    const wanted = new Map<string, { original: string; indexes: number[] }>()
    for (const index of needBatch) {
      const original = result[index]!.entry.trim()
      const key = original.toLowerCase()
      const found = wanted.get(key)
      if (found) found.indexes.push(index)
      else wanted.set(key, { original, indexes: [index] })
    }

    for (const shard of chunk([...wanted.values()], BATCH_GET_ID_EMAIL_LIMIT)) {
      const batch = await this.fetchBatch(shard.map(item => item.original), shard.length)
      if (!batch.ok) {
        // 这一片查不了：片内条目全部保留待重试，不能当成查无此人。
        for (const item of shard) {
          for (const index of item.indexes) {
            const entry = result[index]!
            entry.status = 'pending'
            entry.detail = batch.detail
            this.logger.warn('identity:resolve-deferred', { entry: maskEntry(entry.entry), detail: entry.detail })
          }
        }
        continue
      }
      for (const item of shard) {
        const key = item.original.toLowerCase()
        const openId = batch.map.get(key)
        if (!openId) {
          // 响应结构完好（条数对得上、每条都有邮箱），却查不到 user_id：
          // 这才是「确认查无此人」，条目丢弃。
          for (const index of item.indexes) {
            const entry = result[index]!
            entry.status = 'invalid'
            entry.detail = `查无此人：通讯录里没有 ${maskEmail(item.original)}`
            this.logger.warn('identity:resolve-failed', { entry: maskEmail(item.original), detail: entry.detail })
          }
          continue
        }
        for (const index of item.indexes) await this.resolveEmailEntry(result[index]!, openId)
      }
    }
  }

  /** 邮箱已经换成 open_id，再补上通讯录显示名。 */
  private async resolveEmailEntry(entry: IdentityEntry, openId: string): Promise<void> {
    const email = entry.entry.trim()
    entry.status = 'resolved'
    entry.openId = openId
    const nameHit = this.readCache('open_id', openId)
    if (nameHit) {
      entry.name = nameHit.name
    } else {
      const contact = await this.fetchContactUser(openId)
      if (contact.status === 'ok' && contact.user) {
        entry.name = contact.user.name
        if (entry.name) this.writeCache('open_id', openId, openId, entry.name)
      } else {
        // 身份已经确定，只是名字暂时没取到：不影响进名单，记录下来等下次补。
        entry.name = ''
        entry.detail = `名字暂未取到：${contact.detail}`
        this.logger.warn('identity:resolve-deferred', { entry: maskEmail(email), actor: openId, detail: entry.detail })
      }
    }
    // 名字没取到时不写缓存，下次解析会重试，把名字补上。
    if (entry.name) this.writeCache('email', email, openId, entry.name)
    this.logResolved(entry)
  }

  /** 调 `contact +get-user` 查单个用户。 */
  private async fetchContactUser(openId: string): Promise<ContactPayload> {
    const argv = ['contact', '+get-user', '--user-id', openId, '--as', 'bot', '--format', 'json']
    try {
      const result = await this.lark.run(argv, { timeoutMs: CONTACT_TIMEOUT_MS })
      if (result.code !== 0) {
        return { status: 'unknown', user: null, detail: `contact +get-user 调用失败（code=${result.code}）：${detailText(result.stderr)}` }
      }
      return parseContactPayload(result.stdout)
    } catch (error) {
      return { status: 'unknown', user: null, detail: `contact +get-user 调用异常：${detailText(errorMessage(error))}` }
    }
  }

  /** 调 `batch_get_id` 批量把邮箱换成 open_id；一批的邮箱数量不能超过接口上限。 */
  private async fetchBatch(emails: string[], expectedCount: number): Promise<BatchPayload> {
    const argv = [
      'api', 'POST', '/open-apis/contact/v3/users/batch_get_id',
      '--params', JSON.stringify({ user_id_type: 'open_id' }),
      '--data', JSON.stringify({ emails }),
      '--as', 'bot', '--format', 'json',
    ]
    try {
      const result = await this.lark.run(argv, { timeoutMs: CONTACT_TIMEOUT_MS })
      if (result.code !== 0) {
        return { ok: false, map: new Map(), detail: `batch_get_id 调用失败（code=${result.code}）：${detailText(result.stderr)}` }
      }
      return parseBatchPayload(result.stdout, expectedCount)
    } catch (error) {
      return { ok: false, map: new Map(), detail: `batch_get_id 调用异常：${detailText(errorMessage(error))}` }
    }
  }

  private readCache(kind: 'email' | 'open_id', value: string): { openId: string; name: string } | null {
    // 没有 appId 就没有可用的缓存作用域，直接不查也不写，避免跨应用污染。
    if (!this.cache || !this.appId) return null
    try {
      return this.cache.get(this.appId, kind, kind === 'email' ? value.toLowerCase() : value)
    } catch (error) {
      this.logger.warn('identity:cache-failed', { kind, detail: `缓存读取失败：${detailText(errorMessage(error))}` })
      return null
    }
  }

  private writeCache(kind: 'email' | 'open_id', value: string, openId: string, name: string): void {
    if (!this.cache || !this.appId) return
    try {
      this.cache.set(this.appId, kind, kind === 'email' ? value.toLowerCase() : value, openId, name)
    } catch (error) {
      this.logger.warn('identity:cache-failed', { kind, detail: `缓存写入失败：${detailText(errorMessage(error))}` })
    }
  }

  private logResolved(entry: IdentityEntry): void {
    this.logger.info('identity:resolved', { entry: maskEntry(entry.entry), actor: entry.openId, name: entry.name })
  }
}

interface ContactPayload {
  status: 'ok' | 'invalid' | 'unknown'
  user: { openId: string; userId: string; name: string; email: string } | null
  detail: string
}

interface BatchPayload {
  /** 响应结构是否完好到可以据此判断「查无此人」。结构对不上时为 false，条目按待重试处理。 */
  ok: boolean
  /** email（小写）→ open_id。 */
  map: Map<string, string>
  detail: string
}

/**
 * 解析 `batch_get_id` 的返回。
 *
 * 只有响应结构完好（条数与请求一致、每条都能认出 email）时，缺 `user_id` 的邮箱才算是
 * 「确认查无此人」；结构对不上（字段改名、条数对不上）一律按「暂时查不了」处理，
 * 避免接口形状一变就把允许名单静默清空。
 */
function parseBatchPayload(stdout: string, expectedCount?: number): BatchPayload {
  let doc: Record<string, any> | null = null
  try {
    doc = JSON.parse(stdout) as Record<string, any>
  } catch {
    return { ok: false, map: new Map(), detail: 'batch_get_id 输出无法解析' }
  }
  if (doc?.ok === false) {
    return { ok: false, map: new Map(), detail: `batch_get_id 调用失败：${describeError(doc)}` }
  }
  const list = doc?.data?.user_list
  if (!Array.isArray(list)) {
    return { ok: false, map: new Map(), detail: 'batch_get_id 返回里没有 user_list' }
  }
  const items = list as Record<string, any>[]
  const map = new Map<string, string>()
  for (const item of items) {
    const email = typeof item?.email === 'string' ? item.email.trim() : ''
    // 条目认不出邮箱：响应结构与预期不符，不能据此判断谁查无此人。
    if (!email.includes('@')) {
      return { ok: false, map: new Map(), detail: 'batch_get_id 返回的条目里没有可识别的 email' }
    }
    const userId = typeof item?.user_id === 'string' ? item.user_id.trim() : ''
    // 缺 user_id 表示这个邮箱查无此人，不进映射（调用方据此判定 invalid）。
    if (userId) map.set(email.toLowerCase(), userId)
  }
  if (expectedCount !== undefined && items.length !== expectedCount) {
    return { ok: false, map: new Map(), detail: `batch_get_id 返回的条数与请求不一致（请求 ${expectedCount} 条，返回 ${items.length} 条）` }
  }
  return { ok: true, map, detail: '' }
}

/** 解析 `contact +get-user` 的返回，并按错误码区分「查无此人」与「暂时查不了」。 */
function parseContactPayload(stdout: string): ContactPayload {
  let doc: Record<string, any> | null = null
  try {
    doc = JSON.parse(stdout) as Record<string, any>
  } catch {
    return { status: 'unknown', user: null, detail: 'contact +get-user 输出无法解析' }
  }
  if (doc?.ok === false) {
    const code = String(doc?.error?.code ?? '')
    if (code === CODE_CROSS_APP) {
      return { status: 'invalid', user: null, detail: `open_id 跨应用，当前应用查不到这个 id（code=${code}）` }
    }
    if (code === CODE_NOT_FOUND) {
      return { status: 'invalid', user: null, detail: `查无此人：open_id 无效或不存在（code=${code}）` }
    }
    return { status: 'unknown', user: null, detail: `通讯录查询失败：${describeError(doc)}` }
  }
  const user = doc?.data?.user
  if (!user || typeof user !== 'object') {
    return { status: 'unknown', user: null, detail: 'contact +get-user 返回里没有 user' }
  }
  return {
    status: 'ok',
    user: {
      openId: String(user.open_id ?? user.openId ?? ''),
      userId: String(user.user_id ?? user.userId ?? ''),
      name: String(user.name ?? ''),
      email: String(user.email ?? ''),
    },
    detail: '',
  }
}

/** 从错误响应里取一句可读原因。 */
function describeError(doc: Record<string, any>): string {
  const text = doc?.error?.msg ?? doc?.error?.message ?? doc?.msg ?? doc?.message ?? '未知错误'
  return detailText(String(text))
}

/** 错误详情截断，并顺手把里面出现的邮箱掩码掉。 */
function detailText(text: string): string {
  const masked = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, match => maskEmail(match))
  return masked.length > DETAIL_MAX ? `${masked.slice(0, DETAIL_MAX)}…` : masked
}

/** 入日志 / 进 detail 的条目：邮箱要掩码，open_id 与非法条目原样保留。 */
function maskEntry(entry: string): string {
  return entry.includes('@') ? maskEmail(entry.trim()) : entry
}

/** 按固定大小切片。 */
function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size))
  return out
}
