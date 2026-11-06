import { realRunner, type CommandRunner } from '../infra/process.js'

/** 为 lark-cli 子进程构造环境：独立配置目录靠 HOME 隔离。 */
export function larkEnv(home?: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  if (home) env.HOME = home
  return env
}

/** 给已有 runner 注入固定环境，调用方再传 env 时以后者为准。 */
export function withEnv(runner: CommandRunner, env: NodeJS.ProcessEnv): CommandRunner {
  return {
    run: (argv, opts = {}) => runner.run(argv, { ...opts, env: { ...env, ...(opts.env ?? {}) } }),
  }
}

/** 绑定 lark-cli 的 runner；传入 larkHome 时使用独立配置目录。 */
export function createLarkRunner(opts: { home?: string; bin?: string; baseEnv?: NodeJS.ProcessEnv } = {}): CommandRunner {
  return withEnv(realRunner(opts.bin ?? 'lark-cli'), larkEnv(opts.home, opts.baseEnv ?? process.env))
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