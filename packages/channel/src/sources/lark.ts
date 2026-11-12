import { homedir } from 'node:os'
import { join } from 'node:path'
import { realRunner, type CommandRunner } from '#infra/process.js'

/**
 * router-agent 专属的 lark-cli profile。
 *
 * 固定目录，不接受任何配置项覆盖：router-agent 的机器人凭据与使用者终端里
 * 的 lark-cli 完全隔离，面板也无法把它指到别的 HOME。
 */
export const LARK_PROFILE_HOME = join(homedir(), '.router-agent-lark')

/** 为 lark-cli 子进程构造环境：HOME 固定指向专属 profile。 */
export function larkEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, HOME: LARK_PROFILE_HOME }
}

/** 给已有 runner 注入固定环境，调用方再传 env 时以后者为准。 */
export function withEnv(runner: CommandRunner, env: NodeJS.ProcessEnv): CommandRunner {
  return {
    run: (argv, opts = {}) => runner.run(argv, { ...opts, env: { ...env, ...(opts.env ?? {}) } }),
  }
}

/** 绑定 lark-cli 的 runner；始终使用固定 profile。 */
export function createLarkRunner(opts: { bin?: string; baseEnv?: NodeJS.ProcessEnv } = {}): CommandRunner {
  return withEnv(realRunner(opts.bin ?? 'lark-cli'), larkEnv(opts.baseEnv ?? process.env))
}

export interface LarkChat {
  chatId: string
  name: string
}

export interface LarkMember {
  openId: string
  name: string
  type: 'user' | 'bot'
  appId?: string
}

/** 解析 `lark-cli im +chat-list --format json`。 */
export function parseLarkChats(stdout: string): LarkChat[] {
  const data = parseData(stdout)
  const list = (data?.chats ?? data?.items ?? []) as Record<string, unknown>[]
  if (!Array.isArray(list)) return []
  return list.map(raw => ({ chatId: String(raw.chat_id ?? raw.chatId ?? ''), name: String(raw.name ?? '') })).filter(c => c.chatId)
}

/** 解析 `lark-cli im +chat-members-list --format json`，保留用户与机器人两种成员。 */
export function parseLarkMembers(stdout: string): LarkMember[] {
  const data = parseData(stdout)
  const users = (data?.users ?? []) as Record<string, unknown>[]
  const bots = (data?.bots ?? []) as Record<string, unknown>[]
  const out: LarkMember[] = []
  if (Array.isArray(users)) {
    for (const raw of users) {
      const openId = String(raw.member_id ?? raw.open_id ?? '')
      if (openId) out.push({ openId, name: String(raw.name ?? ''), type: 'user' })
    }
  }
  if (Array.isArray(bots)) {
    for (const raw of bots) {
      const openId = String(raw.member_id ?? raw.open_id ?? '')
      if (openId) out.push({ openId, name: String(raw.name ?? ''), type: 'bot', ...(raw.app_id ? { appId: String(raw.app_id) } : {}) })
    }
  }
  return out
}

export interface LarkUser {
  available: boolean
  openId: string
}

/** 解析 `lark-cli auth status` 里的用户身份是否可用。 */
export function parseAuthUser(stdout: string): LarkUser {
  try {
    const doc = JSON.parse(stdout) as Record<string, any>
    const user = doc?.identities?.user ?? {}
    return {
      available: Boolean(user.available) || user.status === 'ready',
      openId: String(user.openId ?? user.open_id ?? ''),
    }
  } catch {
    return { available: false, openId: '' }
  }
}

/** 解析机器人身份是否可用。 */
export function parseBotAvailable(stdout: string): boolean {
  try {
    const doc = JSON.parse(stdout) as Record<string, any>
    const bot = doc?.identities?.bot ?? {}
    return Boolean(bot.available) || bot.status === 'ready'
  } catch {
    return false
  }
}

export interface EventPrecheck {
  ready: boolean
  detail: string
}

/** 解析 `lark-cli event consume <key> --dry-run` 的前置条件。 */
export function parseEventPrecheck(stdout: string): EventPrecheck {
  try {
    const doc = JSON.parse(stdout) as Record<string, any>
    const decision = doc?.data?.decision ?? {}
    const preconditions = (decision.preconditions ?? []) as { name?: string; status?: string }[]
    const failed = preconditions.filter(item => item.status && item.status !== 'ok')
    return {
      ready: decision.status === 'ready' && failed.length === 0,
      detail: failed.length > 0
        ? `未通过：${failed.map(item => item.name ?? '?').join(', ')}`
        : `status=${decision.status ?? 'unknown'}`,
    }
  } catch {
    return { ready: false, detail: '输出无法解析' }
  }
}

/** 解析或解析 `orca status` 的 key: value 输出。 */
export function parseOrcaStatus(stdout: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const match = line.match(/^([A-Za-z][\w.]*)\s*:\s*(.+)$/)
    if (match) out[match[1]!] = match[2]!.trim()
  }
  return out
}

/** 解析 `lark-cli auth status` 里的当前用户 open_id。 */
export function parseSelfOpenId(stdout: string): string {
  try {
    const doc = JSON.parse(stdout) as Record<string, any>
    return String(doc?.identities?.user?.openId ?? doc?.identities?.user?.open_id ?? doc?.openId ?? '')
  } catch {
    return ''
  }
}

/** 解析 `lark-cli config show` 里的 appId。 */
export function parseAppId(stdout: string): string {
  try {
    const doc = JSON.parse(stdout) as Record<string, any>
    return String(doc?.appId ?? doc?.data?.appId ?? '')
  } catch {
    return ''
  }
}

export interface LarkAuthStatus {
  appId: string
  bot: { available: boolean; status: string; message: string }
  user: { available: boolean; status: string; message: string; openId: string; userName: string }
}

/** 解析 `lark-cli auth status --json`，同时给出机器人身份与用户授权状态。 */
export function parseAuthStatus(stdout: string): LarkAuthStatus {
  try {
    const doc = JSON.parse(stdout) as Record<string, any>
    const identities = doc?.identities ?? {}
    const bot = identities.bot ?? {}
    const user = identities.user ?? {}
    return {
      appId: String(doc?.appId ?? doc?.app_id ?? ''),
      bot: {
        available: Boolean(bot.available) || bot.status === 'ready',
        status: String(bot.status ?? ''),
        message: String(bot.message ?? ''),
      },
      user: {
        available: Boolean(user.available) || user.status === 'ready',
        status: String(user.status ?? ''),
        message: String(user.message ?? ''),
        openId: String(user.openId ?? user.open_id ?? ''),
        userName: String(user.userName ?? user.user_name ?? user.name ?? ''),
      },
    }
  } catch {
    return {
      appId: '',
      bot: { available: false, status: '', message: '授权状态输出无法解析' },
      user: { available: false, status: '', message: '', openId: '', userName: '' },
    }
  }
}

export interface LarkDeviceLogin {
  deviceCode: string
  verificationUrl: string
  userCode: string
}

/**
 * 解析 `lark-cli auth login --no-wait --json`。
 *
 * lark-cli 的 JSON 字段使用 snake_case；不同版本可能把结果包在 `data` 里，
 * 解析失败时再从 stderr 兜底提取验证链接，避免直接让用户手敲命令。
 */
export function parseDeviceLogin(stdout: string, stderr = ''): LarkDeviceLogin {
  let doc: Record<string, any> | null = null
  try {
    doc = JSON.parse(stdout) as Record<string, any>
  } catch {
    doc = null
  }
  const pick = (key: string, camel: string): string => {
    const value = doc?.[key] ?? doc?.[camel] ?? doc?.data?.[key] ?? doc?.data?.[camel]
    return value === undefined || value === null ? '' : String(value)
  }
  const text = `${stdout}\n${stderr}`
  const verificationUrl = pick('verification_url', 'verificationUrl')
    || pick('verification_uri', 'verificationUri')
    || firstMatch(text, /(https?:\/\/[^\s"'<>]+)/)
  return {
    deviceCode: pick('device_code', 'deviceCode') || firstMatch(text, /device[_-]?code["'\s:=]+([\w-]+)/i),
    verificationUrl,
    userCode: pick('user_code', 'userCode')
      || firstMatch(text, /user[_-]?code["'\s:=]+([\w-]+)/i)
      || firstMatch(verificationUrl, /[?&]user_code=([^&]+)/),
  }
}

function firstMatch(text: string, pattern: RegExp): string {
  return pattern.exec(text)?.[1] ?? ''
}

/** 解析 `orca repo list --json`，只返回能创建 worktree 的 git 仓库。 */
export function parseOrcaRepos(stdout: string): { name: string; path: string; kind: string }[] {
  try {
    const doc = JSON.parse(stdout) as Record<string, any>
    const repos = (doc?.result?.repos ?? doc?.repos ?? []) as Record<string, unknown>[]
    return repos
      .map(raw => ({ name: String(raw.displayName ?? raw.name ?? ''), path: String(raw.path ?? ''), kind: String(raw.kind ?? 'git') }))
      .filter(repo => repo.name && repo.kind === 'git')
  } catch {
    return []
  }
}

function parseData(stdout: string): Record<string, any> | null {
  try {
    const doc = JSON.parse(stdout) as Record<string, any>
    return (doc?.data ?? doc) as Record<string, any>
  } catch {
    return null
  }
}