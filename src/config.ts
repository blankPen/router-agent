import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { DEFAULT_ADMISSION, type AcceptMode, type AdmissionTable, type Policy } from './core/policy.js'
import type { WorkerSpecMode } from './worker/spec/index.js'

export type ChatMode = 'all' | 'mention'

/**
 * 一个被监控的群：接收方式、派工绑定、历史补拉都写在这一条里，
 * 不再需要同时在 chats / otherChats / syncChat / chatBindings 四处登记。
 */
export interface ChatSettings {
  chat: string
  /** all：全部消息；mention：只收 @机器人。 */
  mode: ChatMode
  /** 群级派工绑定：项目名或仓库选择器；空表示开工前追问。 */
  repo: string
  /** 群级派工绑定：起始分支；空表示开工前追问。 */
  branch: string
  /** 启动时补拉该群历史。 */
  sync: boolean
  /** 本群只允许这些 open_id 操作；空表示沿用全局 feishu.allowed。 */
  allowed: string[]
}

export function chatEntry(chat: string, over: Partial<Omit<ChatSettings, 'chat'>> = {}): ChatSettings {
  return { chat, mode: 'all', repo: '', branch: '', sync: false, allowed: [], ...over }
}

export interface FeishuSettings {
  /** 独立 lark-cli 配置目录；空表示复用当前 lark-cli profile。 */
  larkHome: string
  /** 专属机器人的 App ID（App Secret 只写进 lark-cli 的加密存储）。 */
  appId: string
  /** 收到消息后立即回的确认表情（飞书 emoji_type），空字符串表示关闭。 */
  reaction: string
  chats: ChatSettings[]
  directMessages: boolean
  allowed: string[]
  bots: string[]
  botOpenIds: string[]
  botNames: string[]
}

export interface PolicySettings {
  acceptMode: AcceptMode
  maxWorkers: number
  admission: AdmissionTable
}

/** 一个可派工的项目。name 是用户/模型口中引用的名字，repo 是交给 Orca 的选择器。 */
export interface ProjectConfig {
  name: string
  repo: string
  /** 允许作为起始分支的白名单；空数组表示不限制。 */
  branches: string[]
  /** 工单未指定分支时的默认起始分支；空字符串表示必须问用户。 */
  defaultBranch: string
}

/** 群级绑定视图：派工解析只需要这三项。 */
export interface ChatBinding {
  chat: string
  repo: string
  branch: string
}

/** 工单进展的定时同步策略。 */
export interface ProgressSettings {
  /** 轮询间隔（毫秒）：把这段时间内的 progress 上报合并成一条消息同步到话题；0 表示关闭。 */
  syncMs: number
}

export interface AppConfig {
  home: string
  projects: ProjectConfig[]
  feishu: FeishuSettings
  policy: PolicySettings
  progress: ProgressSettings
  workerSpec: { mode: WorkerSpecMode }
  backend: { default: 'orca' }
  server: { port: number }
  llm?: { baseUrl?: string; apiKey?: string; model?: string; temperature?: number }
}

export function defaultConfig(): AppConfig {
  return {
    home: '',
    projects: [],
    feishu: {
      larkHome: '',
      appId: '',
      reaction: 'Typing',
      chats: [],
      directMessages: true,
      allowed: [],
      bots: [],
      botOpenIds: [],
      botNames: [],
    },
    policy: {
      acceptMode: 'auto',
      maxWorkers: 4,
      admission: { ...DEFAULT_ADMISSION },
    },
    progress: { syncMs: 60_000 },
    workerSpec: { mode: 'prompt' },
    backend: { default: 'orca' },
    server: { port: 3083 },
  }
}

const DEFAULT_CONFIG_YAML = `# router-agent 全局配置
feishu:
  # 监控的群：一条配置同时决定「收什么消息 + 派工绑定 + 是否补拉历史」
  chats: []
  #  - chat: oc_xxx
  #    mode: all          # all=全部消息；mention=只收 @机器人
  #    repo: router-agent # 可选：群绑定项目（项目名或仓库选择器），开工不再追问
  #    branch: main       # 可选：群绑定起始分支
  #    sync: false        # 可选：启动时补拉该群历史
  #    allowed: [ou_xxx]  # 可选：本群只允许这些人操作（空=沿用全局 allowed）
  directMessages: true
  allowed: []          # 允许发起工作的 open_id
  bots: []             # 允许产生推断候选的机器人 open_id
  botOpenIds: []       # 机器人自己的 open_id
  botNames: []         # 机器人显示名

policy:
  acceptMode: auto     # off / observe / auto
  maxWorkers: 4

progress:
  syncMs: 60000        # 工单进展合并同步间隔（毫秒）；0 = 关闭定时同步

workerSpec:
  mode: prompt         # prompt | agent

backend:
  default: orca

# 项目清单：开单前必须明确「哪个项目 + 哪个起始分支」
projects: []
#  - name: router-agent            # 用户/模型引用的项目名
#    repo: name:dsh/router-agent   # 交给 Orca 的仓库选择器
#    defaultBranch: main           # 未指定分支时使用；留空则必须问用户
#    branches: [main, release]     # 可选：允许的起始分支白名单

server:
  port: 3083

# 模型配置可留空，自动复用 ~/.trove/config.json 里的 llm 段
# llm:
#   baseUrl: https://api.deepseek.com/v1
#   model: deepseek-v4-flash
#   apiKey: sk-xxx
`

/** 创建 ~/.router-agent 目录结构；不覆盖已有配置。 */
export function ensureHome(home: string): void {
  for (const sub of ['', 'logs', 'workers']) mkdirSync(join(home, sub), { recursive: true })
  const configPath = join(home, 'config.yaml')
  if (!existsSync(configPath)) writeFileSync(configPath, DEFAULT_CONFIG_YAML, 'utf8')
}

export function defaultHome(): string {
  return process.env.RA_HOME ?? join(homedir(), '.router-agent')
}

export function loadConfig(home: string = defaultHome(), env: NodeJS.ProcessEnv = process.env): AppConfig {
  ensureHome(home)
  const base = defaultConfig()
  const configPath = join(home, 'config.yaml')
  let doc: Record<string, any> = {}
  if (existsSync(configPath)) {
    try {
      doc = (parseYaml(readFileSync(configPath, 'utf8')) as Record<string, any>) ?? {}
    } catch {
      doc = {}
    }
  }

  const acceptMode = pickAcceptMode(doc.policy?.acceptMode, base.policy.acceptMode)
  const mode = pickMode(doc.workerSpec?.mode, base.workerSpec.mode)
  const port = Number(doc.server?.port)
  const progressSyncMs = Number(doc.progress?.syncMs)

  const admissionDoc = doc.policy?.admission ?? {}
  const admission: AdmissionTable = {
    listedNotAddressed: pickAdmission(admissionDoc.listedNotAddressed, base.policy.admission.listedNotAddressed, ['inferred', 'ignore']) as never,
    unlistedAddressed: pickAdmission(admissionDoc.unlistedAddressed, base.policy.admission.unlistedAddressed, ['explicit', 'inferred', 'ignore']) as never,
    unlistedNotAddressed: pickAdmission(admissionDoc.unlistedNotAddressed, base.policy.admission.unlistedNotAddressed, ['inferred', 'ignore']) as never,
  }

  return {
    home,
    projects: parseProjects(doc.projects),
    feishu: {
      larkHome: env.RA_LARK_HOME ?? stringOr(doc.feishu?.larkHome, base.feishu.larkHome),
      appId: stringOr(doc.feishu?.appId, base.feishu.appId),
      reaction: stringOr(doc.feishu?.reaction, base.feishu.reaction),
      chats: parseChats(doc),
      directMessages: booleanOr(doc.feishu?.directMessages, base.feishu.directMessages),
      allowed: stringArray(doc.feishu?.allowed, base.feishu.allowed),
      bots: stringArray(doc.feishu?.bots, base.feishu.bots),
      botOpenIds: stringArray(doc.feishu?.botOpenIds, base.feishu.botOpenIds),
      botNames: stringArray(doc.feishu?.botNames, base.feishu.botNames),
    },
    policy: {
      acceptMode,
      maxWorkers: Number.isFinite(Number(doc.policy?.maxWorkers)) && Number(doc.policy?.maxWorkers) > 0 ? Number(doc.policy.maxWorkers) : base.policy.maxWorkers,
      admission,
    },
    progress: {
      syncMs: Number.isInteger(progressSyncMs) && progressSyncMs >= 0 && progressSyncMs <= 3_600_000 ? progressSyncMs : base.progress.syncMs,
    },
    workerSpec: { mode },
    backend: { default: 'orca' },
    server: { port: Number.isFinite(port) && port >= 0 && port < 65536 ? port : base.server.port },
    ...(doc.llm ? { llm: doc.llm } : {}),
  }
}

/** 把配置折算成领域 Policy；版本号是规则的指纹。 */
export function policyOf(config: AppConfig): Policy {
  const admission = config.policy.admission
  const allowedByChat = Object.fromEntries(
    config.feishu.chats.filter(chat => chat.allowed.length > 0).map(chat => [chat.chat, chat.allowed]),
  )
  const body = {
    acceptMode: config.policy.acceptMode,
    maxWorkers: config.policy.maxWorkers,
    admission,
    allowed: config.feishu.allowed,
    allowedByChat,
    bots: config.feishu.bots,
    receiveAll: config.feishu.chats.some(chat => chat.mode === 'all'),
  }
  return {
    version: createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 12),
    ...body,
  }
}

function pickAcceptMode(value: unknown, fallback: AcceptMode): AcceptMode {
  return value === 'off' || value === 'observe' || value === 'auto' ? value : fallback
}

function pickMode(value: unknown, fallback: WorkerSpecMode): WorkerSpecMode {
  return value === 'prompt' || value === 'agent' ? value : fallback
}

function pickAdmission(value: unknown, fallback: string, allowed: string[]): string {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

function stringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.map(String) : fallback
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function parseProjects(value: unknown): ProjectConfig[] {
  if (!Array.isArray(value)) return []
  const projects: ProjectConfig[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const repo = typeof entry.repo === 'string' ? entry.repo.trim() : ''
    if (!repo) continue
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : projectNameOf(repo)
    projects.push({
      name,
      repo,
      branches: stringArray(entry.branches, []).map(branch => branch.trim()).filter(Boolean),
      defaultBranch: typeof entry.defaultBranch === 'string' ? entry.defaultBranch.trim() : '',
    })
  }
  return projects
}

/**
 * 统一的群配置解析：
 * - 新写法 `feishu.chats: [{ chat, mode, repo, branch, sync }]`（字符串条目等价于 mode=all）
 * - 兼容旧写法 `otherChats`（mention）、`syncChat`（sync=true）、顶层 `chatBindings`（补 repo/branch，
 *   且只要绑定了就视为监控该群——避免「绑定了却收不到消息」的割裂）。
 */
function parseChats(doc: Record<string, any>): ChatSettings[] {
  const byChat = new Map<string, ChatSettings>()
  const ensure = (chat: string): ChatSettings => {
    const existing = byChat.get(chat)
    if (existing) return existing
    const created = chatEntry(chat)
    byChat.set(chat, created)
    return created
  }
  const feishu = doc.feishu ?? {}
  const explicit = new Set<string>()

  for (const item of Array.isArray(feishu.chats) ? feishu.chats : []) {
    if (typeof item === 'string') {
      const chat = item.trim()
      if (!chat) continue
      ensure(chat)
      explicit.add(chat)
      continue
    }
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const chat = typeof entry.chat === 'string' ? entry.chat.trim() : typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!chat) continue
    const settings = ensure(chat)
    settings.mode = entry.mode === 'mention' ? 'mention' : 'all'
    if (typeof entry.repo === 'string') settings.repo = entry.repo.trim()
    if (typeof entry.branch === 'string') settings.branch = entry.branch.trim()
    if (entry.sync === true) settings.sync = true
    settings.allowed = stringArray(entry.allowed, settings.allowed).map(id => id.trim()).filter(Boolean)
    explicit.add(chat)
  }

  for (const chat of stringArray(feishu.otherChats, [])) {
    if (!chat || explicit.has(chat)) continue
    ensure(chat).mode = 'mention'
  }
  for (const chat of stringArray(feishu.syncChat, [])) {
    if (!chat) continue
    ensure(chat).sync = true
  }
  for (const binding of parseLegacyBindings(doc.chatBindings)) {
    const settings = ensure(binding.chat)
    if (binding.repo) settings.repo = binding.repo
    if (binding.branch) settings.branch = binding.branch
  }

  return [...byChat.values()]
}

/** 旧版顶层 chatBindings：数组或 `oc_xxx: { repo, branch }` 映射。 */
function parseLegacyBindings(value: unknown): ChatBinding[] {
  if (Array.isArray(value)) {
    return value.flatMap(item => {
      if (!item || typeof item !== 'object') return []
      const entry = item as Record<string, unknown>
      const chat = typeof entry.chat === 'string' ? entry.chat.trim() : ''
      return chat
        ? [{ chat, repo: typeof entry.repo === 'string' ? entry.repo.trim() : '', branch: typeof entry.branch === 'string' ? entry.branch.trim() : '' }]
        : []
    })
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([chat, raw]) => {
      const entry = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      return {
        chat,
        repo: typeof entry.repo === 'string' ? entry.repo.trim() : '',
        branch: typeof entry.branch === 'string' ? entry.branch.trim() : '',
      }
    })
  }
  return []
}

/** 从选择器里取一个可读的项目名：name:dsh/router-agent → dsh/router-agent。 */
export function projectNameOf(repo: string): string {
  return repo.trim().replace(/^(id|name|path):/, '')
}

/** 把配置写回 config.yaml；保留所有可选字段当前值，方便用 `ra config` 继续调。 */
export function writeConfig(home: string, config: AppConfig): void {
  mkdirSync(home, { recursive: true })
  const doc: Record<string, unknown> = {
    feishu: {
      larkHome: config.feishu.larkHome,
      appId: config.feishu.appId,
      reaction: config.feishu.reaction,
      chats: config.feishu.chats.map(chat => ({
        chat: chat.chat,
        mode: chat.mode,
        ...(chat.repo ? { repo: chat.repo } : {}),
        ...(chat.branch ? { branch: chat.branch } : {}),
        ...(chat.sync ? { sync: true } : {}),
        ...(chat.allowed.length > 0 ? { allowed: chat.allowed } : {}),
      })),
      directMessages: config.feishu.directMessages,
      allowed: config.feishu.allowed,
      bots: config.feishu.bots,
      botOpenIds: config.feishu.botOpenIds,
      botNames: config.feishu.botNames,
    },
    policy: {
      acceptMode: config.policy.acceptMode,
      maxWorkers: config.policy.maxWorkers,
      admission: config.policy.admission,
    },
    progress: { syncMs: config.progress.syncMs },
    workerSpec: { mode: config.workerSpec.mode },
    backend: { default: config.backend.default },
    projects: config.projects,
    server: { port: config.server.port },
  }
  if (config.llm) doc.llm = config.llm
  const header = [
    '# router-agent 配置',
    '# 必填项由 ra init 引导生成；其余可用 `ra config set <key> <value>` 或直接编辑本文件。',
    '',
  ].join('\n')
  writeFileSync(join(home, 'config.yaml'), `${header}${stringifyYaml(doc, { lineWidth: 0 })}`, 'utf8')
}

const ACCEPT_MODES = ['off', 'observe', 'auto']
const WORKER_MODES = ['prompt', 'agent']
const ADMISSION_LISTED = ['inferred', 'ignore']
const ADMISSION_UNLISTED_ADDRESSED = ['explicit', 'inferred', 'ignore']

/** `repo@branch` → [repo, branch]；没有 @ 时分支为空。 */
function splitBranch(value: string): [string, string] {
  const at = value.lastIndexOf('@')
  if (at <= 0) return [value.trim(), '']
  return [value.slice(0, at).trim(), value.slice(at + 1).trim()]
}

/** 取到某个群的配置条目，没有就新建（默认 all、未绑定）。 */
function ensureChat(config: AppConfig, chat: string): ChatSettings {
  const existing = config.feishu.chats.find(item => item.chat === chat)
  if (existing) return existing
  const created = chatEntry(chat)
  config.feishu.chats.push(created)
  return created
}

/** 按点路径设置一个已知配置项；未知路径或非法值返回 false。 */
export function setConfigValue(config: AppConfig, path: string, raw: string): boolean {
  const value = raw.trim()
  const list = (): string[] => value.split(',').map(v => v.trim()).filter(Boolean)
  const int = (min: number, max: number): number | null => {
    const n = Number(value)
    return Number.isInteger(n) && n >= min && n <= max ? n : null
  }
  const bool = (): boolean | null => (value === 'true' ? true : value === 'false' ? false : null)

  // 多项目：`ra config set project.<name> <repo>[@<defaultBranch>]`
  if (path.startsWith('project.')) {
    const name = path.slice('project.'.length).trim()
    const [repo, defaultBranch] = splitBranch(value)
    if (!name || !repo) return false
    const project: ProjectConfig = { name, repo, branches: [], defaultBranch }
    const index = config.projects.findIndex(item => item.name === name)
    if (index >= 0) config.projects[index] = { ...config.projects[index]!, ...project, branches: config.projects[index]!.branches }
    else config.projects.push(project)
    return true
  }

  // 群级绑定：`ra config set chatBinding.<chatId> <repo>[@<branch>]`（绑定同时意味着监控这个群）
  if (path.startsWith('chatBinding.')) {
    const chat = path.slice('chatBinding.'.length).trim()
    const [repo, branch] = splitBranch(value)
    if (!chat || !repo) return false
    const entry = ensureChat(config, chat)
    entry.repo = repo
    entry.branch = branch
    return true
  }

  // 群成员白名单：`ra config set chatAllow.<chatId> <open_id,...>`（空值表示沿用全局 allowed）
  if (path.startsWith('chatAllow.')) {
    const chat = path.slice('chatAllow.'.length).trim()
    if (!chat) return false
    ensureChat(config, chat).allowed = list()
    return true
  }

  // 群接收方式：`ra config set chatMode.<chatId> all|mention`
  if (path.startsWith('chatMode.')) {
    const chat = path.slice('chatMode.'.length).trim()
    if (!chat || (value !== 'all' && value !== 'mention')) return false
    ensureChat(config, chat).mode = value
    return true
  }

  // 群历史补拉：`ra config set chatSync.<chatId> true|false`
  if (path.startsWith('chatSync.')) {
    const chat = path.slice('chatSync.'.length).trim()
    const v = bool()
    if (!chat || v === null) return false
    ensureChat(config, chat).sync = v
    return true
  }

  switch (path) {
    case 'feishu.larkHome':
      config.feishu.larkHome = value
      return true
    case 'feishu.appId':
      config.feishu.appId = value
      return true
    case 'feishu.reaction':
      config.feishu.reaction = value
      return true
    case 'feishu.chats': {
      // 逗号分隔的 chat_id 列表；已有条目的 mode/绑定/sync 保留，新条目默认 all
      const existing = new Map(config.feishu.chats.map(chat => [chat.chat, chat]))
      config.feishu.chats = list().map(chat => existing.get(chat) ?? chatEntry(chat))
      return true
    }
    case 'feishu.allowed':
      config.feishu.allowed = list()
      return true
    case 'feishu.bots':
      config.feishu.bots = list()
      return true
    case 'feishu.botOpenIds':
      config.feishu.botOpenIds = list()
      return true
    case 'feishu.botNames':
      config.feishu.botNames = list()
      return true
    case 'feishu.directMessages': {
      const v = bool()
      if (v === null) return false
      config.feishu.directMessages = v
      return true
    }
    case 'policy.acceptMode':
      if (!ACCEPT_MODES.includes(value)) return false
      config.policy.acceptMode = value as AcceptMode
      return true
    case 'policy.maxWorkers': {
      const v = int(1, 64)
      if (v === null) return false
      config.policy.maxWorkers = v
      return true
    }
    case 'progress.syncMs': {
      // 0 表示关闭工单进展定时同步
      const n = Number(value)
      if (!Number.isInteger(n) || n < 0 || n > 3_600_000) return false
      config.progress.syncMs = n
      return true
    }
    case 'policy.admission.listedNotAddressed':
      if (!ADMISSION_LISTED.includes(value)) return false
      config.policy.admission.listedNotAddressed = value as never
      return true
    case 'policy.admission.unlistedAddressed':
      if (!ADMISSION_UNLISTED_ADDRESSED.includes(value)) return false
      config.policy.admission.unlistedAddressed = value as never
      return true
    case 'policy.admission.unlistedNotAddressed':
      if (!ADMISSION_LISTED.includes(value)) return false
      config.policy.admission.unlistedNotAddressed = value as never
      return true
    case 'workerSpec.mode':
      if (!WORKER_MODES.includes(value)) return false
      config.workerSpec.mode = value as WorkerSpecMode
      return true
    case 'server.port': {
      const v = int(0, 65535)
      if (v === null) return false
      config.server.port = v
      return true
    }
    case 'backend.default':
      if (value !== 'orca') return false
      config.backend.default = 'orca'
      return true
    case 'llm.baseUrl':
    case 'llm.apiKey':
    case 'llm.model': {
      const key = path.split('.')[1] as 'baseUrl' | 'apiKey' | 'model'
      config.llm = { ...(config.llm ?? {}), [key]: value }
      return true
    }
    default:
      return false
  }
}
