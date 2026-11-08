import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { DEFAULT_ADMISSION, type AcceptMode, type AdmissionTable, type Policy } from './core/policy.js'
import type { WorkerSpecMode } from './worker/spec/index.js'
import type { ToolPolicy } from './worker/port.js'

export type ChatMode = 'all' | 'mention'

/** worker 的默认工具策略：只允许上报/文档/git/gh，默认无网络。 */
export const DEFAULT_WORKER_TOOLS: ToolPolicy = {
  fileAccess: 'read-write',
  shell: 'allowlist',
  shellAllow: [
    'ra report', 'ra doc', 'git', 'gh',
    'pnpm', 'npm', 'npx', 'node', 'yarn', 'bun',
    'python', 'python3', 'pytest', 'cargo', 'go', 'make', 'mvn', 'gradle',
  ],
  allowNetwork: false,
}

/**
 * 一个被监控的群：接收方式、派工绑定、历史补拉都写在这一条里，
 * 不再需要同时在 chats / otherChats / syncChat / chatBindings 四处登记。
 */
export interface ChatSettings {
  chat: string
  /** all：全部消息，且不 @ 也会回复；mention：只收 @机器人。 */
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
  images: ImageSettings
}

/** 飞书图片转文本：下载 image_key 后交给多模态模型识别，再进入研判。 */
export interface ImageSettings {
  /** 关闭后图片仍按纯附件处理（回一句请补充文字）。 */
  enabled: boolean
  /** 单张图片转写结果的最大字符数。 */
  maxChars: number
  /** 单张图片识别的硬超时。 */
  timeoutMs: number
}

export interface PolicySettings {
  acceptMode: AcceptMode
  maxWorkers: number
  admission: AdmissionTable
}

/** 会话复用：一个飞书会话（按人隔离）对应一个落盘的 Pi session。 */
export interface SessionSettings {
  /** false 时退回旧行为：每次研判新建 in-memory session。 */
  enabled: boolean
  /** user：chat + 人；thread：chat + 话题 + 人。 */
  keyScope: 'user' | 'thread'
  /** session 落盘根目录；空表示 ~/.router-agent/sessions。 */
  dir: string
  /** 多久没有新消息就回收内存（文件保留）。 */
  idleTtlMs: number
  /** 同时驻留内存的 session 上限，超出按 LRU 回收。 */
  maxActive: number
  /** /new 之后旧 session 文件保留天数；0 表示不清理。 */
  retentionDays: number
  /** 清理任务间隔（小时）。 */
  cleanupIntervalHours: number
  /** 带会话的一轮硬超时（包含压缩耗时）。 */
  turnTimeoutMs: number
  /** 会话内的 token 预算；0 表示不限制（交给 compaction）。 */
  tokenBudget: number
  /** Pi 自动压缩配置。 */
  compaction: {
    enabled: boolean
    reserveTokens: number
    keepRecentTokens: number
  }
}

/** Router 的人格配置；只影响语气与表达，不影响工具权限。 */
export interface PersonaSettings {
  name: string
  /** 自定义 soul 文件；空表示用内置 prompts/soul.md。 */
  soulFile: string
  style: 'friendly' | 'concise' | 'professional'
  language: string
}

/** 研判层配置：Pi 的超时、预算、独立配置目录、会话与人格。 */
export interface RouterSettings {
  /** 每次研判的硬超时。 */
  timeoutMs: number
  /** 单次研判 token 预算；0 表示不限制。 */
  tokenBudget: number
  /** Pi 的独立配置目录；空表示 ~/.router-agent/pi。 */
  agentDir: string
  session: SessionSettings
  persona: PersonaSettings
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

/** 工单进展的定时同步与主动巡检策略。 */
export interface ProgressSettings {
  /** 轮询间隔（毫秒）：把这段时间内的 progress 上报合并成一条消息同步到话题；0 表示关闭。 */
  syncMs: number
  /** 主动巡检间隔（毫秒）：读取 worker 终端并同步进展到话题；0 表示关闭。 */
  probeMs: number
  /** 多久没有新上报 / 新输入才算「静默」，默认 10 分钟。 */
  silenceMs: number
  /** 同一静默期内重复提醒的最小间隔，默认 15 分钟。 */
  repeatMs: number
}

/**
 * 闲置工单治理：长时间没有新进展的工单先提醒，再自动关闭并回收 workspace。
 * 阈值按小时配置，更贴近日常表述；服务内部换算成毫秒。
 */
export interface RetentionSettings {
  /** 总开关；关闭后不再扫描、不提醒、不自动关单。 */
  enabled: boolean
  /** 工单多久没有任何新进展就发一次关单提醒。 */
  idleHours: number
  /** 提醒后多久没有回复就自动关闭。 */
  closeGraceHours: number
  /** 显示在执行、但多久没有上报/终端输出算僵尸进程。 */
  zombieHours: number
  /** 扫描间隔（分钟）。 */
  sweepMinutes: number
}

export interface AppConfig {
  home: string
  projects: ProjectConfig[]
  feishu: FeishuSettings
  policy: PolicySettings
  router: RouterSettings
  progress: ProgressSettings
  retention: RetentionSettings
  workerSpec: { mode: WorkerSpecMode }
  worker: { tools: ToolPolicy }
  backend: { default: string; options?: Record<string, unknown> }
  server: { port: number }
  llm?: { baseUrl?: string; apiKey?: string; model?: string; temperature?: number; contextWindow?: number }
}

/**
 * 「全量接收」的会话：配置了 `mode: all` 的群。
 *
 * 语义对齐：收了就要回。这些群里即使没 @ 机器人，研判后也要正常回一句，
 * 只是判不接单时不开工单。`mode: mention` 的群本来就只收 @，无需处理。
 */
export function replyAlwaysChatsOf(config: AppConfig): string[] {
  return config.feishu.chats.filter(chat => chat.mode === 'all').map(chat => chat.chat)
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
      images: {
        enabled: true,
        maxChars: 2_000,
        timeoutMs: 60_000,
      },
    },
    policy: {
      acceptMode: 'auto',
      maxWorkers: 4,
      admission: { ...DEFAULT_ADMISSION },
    },
    router: {
      timeoutMs: 60_000,
      tokenBudget: 32_000,
      agentDir: '',
      session: {
        enabled: true,
        keyScope: 'user',
        dir: '',
        idleTtlMs: 30 * 60_000,
        maxActive: 50,
        retentionDays: 7,
        cleanupIntervalHours: 24,
        turnTimeoutMs: 180_000,
        tokenBudget: 0,
        compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      },
      persona: {
        name: '阿罗',
        soulFile: '',
        style: 'friendly',
        language: 'zh-CN',
      },
    },
    progress: {
      syncMs: 60_000,
      // 用户口径：worker 可能长时间执行任务且不主动上报，Router 要自己读终端。
      probeMs: 120_000,
      silenceMs: 600_000,
      repeatMs: 900_000,
    },
    retention: {
      enabled: true,
      // 用户口径：1 天没有任何新进展先提醒，提醒后 6 小时没回复自动关闭。
      idleHours: 24,
      closeGraceHours: 6,
      zombieHours: 6,
      sweepMinutes: 5,
    },
    workerSpec: { mode: 'prompt' },
    worker: { tools: { ...DEFAULT_WORKER_TOOLS } },
    backend: { default: 'orca' },
    server: { port: 3083 },
  }
}

const DEFAULT_CONFIG_YAML = `# router-agent 全局配置
feishu:
  # 监控的群：一条配置同时决定「收什么消息 + 派工绑定 + 是否补拉历史」
  chats: []
  #  - chat: oc_xxx
  #    mode: all          # all=全部消息且不 @ 也回复；mention=只收 @机器人
  #    repo: router-agent # 可选：群绑定项目（项目名或仓库选择器），开工不再追问
  #    branch: main       # 可选：群绑定起始分支
  #    sync: false        # 可选：启动时补拉该群历史
  #    allowed: [ou_xxx]  # 可选：本群只允许这些人操作（空=沿用全局 allowed）
  directMessages: true
  allowed: []          # 允许发起工作的 open_id
  bots: []             # 允许产生推断候选的机器人 open_id
  botOpenIds: []       # 机器人自己的 open_id
  botNames: []         # 机器人显示名
  # 图片消息：下载 image_key 后转成文本再进入研判
  images:
    enabled: true
    maxChars: 2000     # 单张图片转写结果的最大字符数
    timeoutMs: 60000   # 单张图片识别超时（毫秒）

policy:
  acceptMode: auto     # off / observe / auto
  maxWorkers: 4

# 研判层：Pi 单引擎；超时、token 预算与独立配置目录
router:
  timeoutMs: 60000
  tokenBudget: 32000
  agentDir: ""             # Pi 独立配置目录；空=~/.router-agent/pi

  # 会话复用：一个飞书会话按人一个 session，落盘、可恢复、自动压缩
  session:
    enabled: true
    keyScope: user         # user=群+人；thread=群+话题+人
    dir: ""                # 空=~/.router-agent/sessions
    idleTtlMs: 1800000     # 30 分钟无消息回收内存（文件保留）
    maxActive: 50          # 同时驻留内存的 session 上限
    retentionDays: 7       # /new 之后旧 session 文件保留天数；0=不清理
    cleanupIntervalHours: 24
    turnTimeoutMs: 180000  # 带会话的一轮硬超时（含压缩）
    tokenBudget: 0         # 会话 token 预算；0=不限制，交给压缩
    compaction:
      enabled: true
      reserveTokens: 16384
      keepRecentTokens: 20000

  # 人格：只影响语气与表达，不影响工具权限
  persona:
    name: "阿罗"
    soulFile: ""           # 空=内置 prompts/soul.md
    style: friendly        # friendly | concise | professional
    language: zh-CN

progress:
  syncMs: 60000        # 工单进展合并同步间隔（毫秒）；0 = 关闭定时同步
  probeMs: 120000      # 主动巡检间隔（毫秒）：读 worker 终端并同步进展；0 = 关闭
  silenceMs: 600000    # 多久没有新上报/新输入才算静默（毫秒）
  repeatMs: 900000     # 同一静默期内重复提醒的最小间隔（毫秒）

# 闲置工单治理：先提醒，宽限期后自动关闭并回收 workspace
retention:
  enabled: true
  idleHours: 24        # 多久没有新进展就发关单提醒
  closeGraceHours: 6   # 提醒后多久没回复就自动关闭
  zombieHours: 6       # 执行中但多久没上报/输出算僵尸
  sweepMinutes: 5      # 扫描间隔（分钟）

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
#   contextWindow: 128000    # 用于会话自动压缩的阈值计算
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
  const progressDoc = doc.progress ?? {}
  const progressSyncMs = Number(progressDoc.syncMs)
  const progressProbeMs = Number(progressDoc.probeMs)
  const progressSilenceMs = Number(progressDoc.silenceMs)
  const progressRepeatMs = Number(progressDoc.repeatMs)
  const retentionDoc = doc.retention ?? {}

  const admissionDoc = doc.policy?.admission ?? {}
  const admission: AdmissionTable = {
    listedNotAddressed: pickAdmission(admissionDoc.listedNotAddressed, base.policy.admission.listedNotAddressed, ['inferred', 'ignore']) as never,
    unlistedAddressed: pickAdmission(admissionDoc.unlistedAddressed, base.policy.admission.unlistedAddressed, ['explicit', 'inferred', 'ignore']) as never,
    unlistedNotAddressed: pickAdmission(admissionDoc.unlistedNotAddressed, base.policy.admission.unlistedNotAddressed, ['inferred', 'ignore']) as never,
  }

  // 安全参数只由 worker.tools 与 adapter 内置基线决定，不允许 backend.options 放宽。
  if (doc.backend?.options && typeof doc.backend.options === 'object') {
    const forbidden = new Set(['allowedTools', 'permissionMode', 'sandbox', 'shellAllow', 'allowNetwork', 'fileAccess'])
    for (const [id, options] of Object.entries(doc.backend.options as Record<string, unknown>)) {
      if (!options || typeof options !== 'object') continue
      const bad = Object.keys(options as Record<string, unknown>).filter(key => forbidden.has(key))
      if (bad.length > 0) {
        throw new Error(`backend.options.${id} 不允许覆盖安全参数: ${bad.join(', ')}`)
      }
    }
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
      images: {
        enabled: booleanOr(doc.feishu?.images?.enabled, base.feishu.images.enabled),
        maxChars: positiveIntOr(doc.feishu?.images?.maxChars, base.feishu.images.maxChars, 100, 20_000),
        timeoutMs: positiveIntOr(doc.feishu?.images?.timeoutMs, base.feishu.images.timeoutMs, 1_000, 300_000),
      },
    },
    policy: {
      acceptMode,
      maxWorkers: Number.isFinite(Number(doc.policy?.maxWorkers)) && Number(doc.policy?.maxWorkers) > 0 ? Number(doc.policy.maxWorkers) : base.policy.maxWorkers,
      admission,
    },
    router: parseRouter(doc.router, base.router),
    progress: {
      syncMs: msOr(progressSyncMs, base.progress.syncMs, 0),
      probeMs: msOr(progressProbeMs, base.progress.probeMs, 0),
      silenceMs: msOr(progressSilenceMs, base.progress.silenceMs, 1_000),
      repeatMs: msOr(progressRepeatMs, base.progress.repeatMs, 1_000),
    },
    retention: {
      enabled: booleanOr(retentionDoc.enabled, base.retention.enabled),
      idleHours: positiveNumberOr(retentionDoc.idleHours, base.retention.idleHours, 1, 24 * 365),
      closeGraceHours: positiveNumberOr(retentionDoc.closeGraceHours, base.retention.closeGraceHours, 1, 24 * 365),
      zombieHours: positiveNumberOr(retentionDoc.zombieHours, base.retention.zombieHours, 1, 24 * 365),
      sweepMinutes: positiveNumberOr(retentionDoc.sweepMinutes, base.retention.sweepMinutes, 1, 24 * 60),
    },
    workerSpec: { mode },
    worker: {
      tools: {
        fileAccess: doc.worker?.tools?.fileAccess === 'read-only' ? 'read-only' : base.worker.tools.fileAccess,
        shell: (['deny', 'allowlist', 'allow'].includes(String(doc.worker?.tools?.shell))
          ? String(doc.worker.tools.shell)
          : base.worker.tools.shell) as ToolPolicy['shell'],
        shellAllow: stringArray(doc.worker?.tools?.shellAllow, base.worker.tools.shellAllow ?? []),
        allowNetwork: booleanOr(doc.worker?.tools?.allowNetwork, base.worker.tools.allowNetwork),
      },
    },
    backend: {
      default: stringOr(doc.backend?.default, base.backend.default),
      ...(doc.backend?.options && typeof doc.backend.options === 'object' ? { options: doc.backend.options } : {}),
    },
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

function parseRouter(value: unknown, base: RouterSettings): RouterSettings {
  const doc = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const timeoutMs = Number(doc.timeoutMs)
  const tokenBudget = Number(doc.tokenBudget)
  const sessionDoc = (doc.session && typeof doc.session === 'object' ? doc.session : {}) as Record<string, unknown>
  const compactionDoc = (sessionDoc.compaction && typeof sessionDoc.compaction === 'object' ? sessionDoc.compaction : {}) as Record<string, unknown>
  const personaDoc = (doc.persona && typeof doc.persona === 'object' ? doc.persona : {}) as Record<string, unknown>
  const baseSession = base.session
  return {
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : base.timeoutMs,
    tokenBudget: Number.isFinite(tokenBudget) && tokenBudget >= 0 ? tokenBudget : base.tokenBudget,
    agentDir: stringOr(doc.agentDir, base.agentDir),
    session: {
      enabled: booleanOr(sessionDoc.enabled, baseSession.enabled),
      keyScope: pickKeyScope(sessionDoc.keyScope, baseSession.keyScope),
      dir: stringOr(sessionDoc.dir, baseSession.dir),
      idleTtlMs: positiveIntOr(sessionDoc.idleTtlMs, baseSession.idleTtlMs, 0, 86_400_000),
      maxActive: positiveIntOr(sessionDoc.maxActive, baseSession.maxActive, 1, 1_000),
      retentionDays: positiveIntOr(sessionDoc.retentionDays, baseSession.retentionDays, 0, 3_650),
      cleanupIntervalHours: positiveNumberOr(sessionDoc.cleanupIntervalHours, baseSession.cleanupIntervalHours, 1, 24 * 30),
      turnTimeoutMs: positiveIntOr(sessionDoc.turnTimeoutMs, baseSession.turnTimeoutMs, 1_000, 3_600_000),
      tokenBudget: positiveIntOr(sessionDoc.tokenBudget, baseSession.tokenBudget, 0, 10_000_000),
      compaction: {
        enabled: booleanOr(compactionDoc.enabled, baseSession.compaction.enabled),
        reserveTokens: positiveIntOr(compactionDoc.reserveTokens, baseSession.compaction.reserveTokens, 1_024, 1_000_000),
        keepRecentTokens: positiveIntOr(compactionDoc.keepRecentTokens, baseSession.compaction.keepRecentTokens, 1_024, 1_000_000),
      },
    },
    persona: {
      name: stringOr(personaDoc.name, base.persona.name),
      soulFile: stringOr(personaDoc.soulFile, base.persona.soulFile),
      style: pickPersonaStyle(personaDoc.style, base.persona.style),
      language: stringOr(personaDoc.language, base.persona.language),
    },
  }
}

function pickKeyScope(value: unknown, fallback: 'user' | 'thread'): 'user' | 'thread' {
  return value === 'user' || value === 'thread' ? value : fallback
}

function pickPersonaStyle(value: unknown, fallback: PersonaSettings['style']): PersonaSettings['style'] {
  return value === 'friendly' || value === 'concise' || value === 'professional' ? value : fallback
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function positiveIntOr(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback
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

/** 毫秒配置：非法值、越界值都退回默认值；min=0 的字段可以关闭。 */
function msOr(value: number, fallback: number, min: number): number {
  return Number.isInteger(value) && value >= min && value <= 3_600_000 ? value : fallback
}

/** 解析正数阈值：非法值、越界值都退回默认值，避免写错配置把清理时钟调成 0。 */
function positiveNumberOr(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback
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
      images: config.feishu.images,
    },
    policy: {
      acceptMode: config.policy.acceptMode,
      maxWorkers: config.policy.maxWorkers,
      admission: config.policy.admission,
    },
    router: {
      timeoutMs: config.router.timeoutMs,
      tokenBudget: config.router.tokenBudget,
      ...(config.router.agentDir ? { agentDir: config.router.agentDir } : {}),
      session: {
        ...config.router.session,
        ...(config.router.session.dir ? { dir: config.router.session.dir } : {}),
      },
      persona: {
        ...config.router.persona,
        ...(config.router.persona.soulFile ? { soulFile: config.router.persona.soulFile } : {}),
      },
    },
    progress: {
      syncMs: config.progress.syncMs,
      probeMs: config.progress.probeMs,
      silenceMs: config.progress.silenceMs,
      repeatMs: config.progress.repeatMs,
    },
    retention: {
      enabled: config.retention.enabled,
      idleHours: config.retention.idleHours,
      closeGraceHours: config.retention.closeGraceHours,
      zombieHours: config.retention.zombieHours,
      sweepMinutes: config.retention.sweepMinutes,
    },
    workerSpec: { mode: config.workerSpec.mode },
    worker: { tools: config.worker.tools },
    backend: {
      default: config.backend.default,
      ...(config.backend.options ? { options: config.backend.options } : {}),
    },
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
    case 'progress.probeMs': {
      // 0 表示关闭主动巡检
      const n = Number(value)
      if (!Number.isInteger(n) || n < 0 || n > 3_600_000) return false
      config.progress.probeMs = n
      return true
    }
    case 'progress.silenceMs': {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1_000 || n > 3_600_000) return false
      config.progress.silenceMs = n
      return true
    }
    case 'progress.repeatMs': {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1_000 || n > 3_600_000) return false
      config.progress.repeatMs = n
      return true
    }
    case 'retention.enabled': {
      const v = bool()
      if (v === null) return false
      config.retention.enabled = v
      return true
    }
    case 'retention.idleHours': {
      const v = int(1, 24 * 365)
      if (v === null) return false
      config.retention.idleHours = v
      return true
    }
    case 'retention.closeGraceHours': {
      const v = int(1, 24 * 365)
      if (v === null) return false
      config.retention.closeGraceHours = v
      return true
    }
    case 'retention.zombieHours': {
      const v = int(1, 24 * 365)
      if (v === null) return false
      config.retention.zombieHours = v
      return true
    }
    case 'retention.sweepMinutes': {
      const v = int(1, 24 * 60)
      if (v === null) return false
      config.retention.sweepMinutes = v
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
    case 'router.timeoutMs': {
      const v = int(1000, 600_000)
      if (v === null) return false
      config.router.timeoutMs = v
      return true
    }
    case 'router.tokenBudget': {
      const v = int(0, 10_000_000)
      if (v === null) return false
      config.router.tokenBudget = v
      return true
    }
    case 'router.agentDir':
      config.router.agentDir = value
      return true
    case 'server.port': {
      const v = int(0, 65535)
      if (v === null) return false
      config.server.port = v
      return true
    }
    case 'backend.default':
      if (!value.trim()) return false
      config.backend.default = value.trim()
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
