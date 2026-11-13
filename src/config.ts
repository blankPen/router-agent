import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { DEFAULT_ADMISSION, type AcceptMode, type AdmissionTable, type InterruptedRecoveryMode, type Policy } from '#core/policy.js'
import type { ToolPolicy } from '#runtime/port.js'
import { UI_EVIDENCE_MODES, type UiEvidenceMode } from '#runtime/evidence-gate.js'
import { ORCA_RUNTIME_ID, isWorkerRuntimeId, normalizeRuntimeId } from '#runtime/runtimes/catalog.js'
import { isProjectRepoPath } from '#runtime/runtimes/repo-path.js'
import { WORKER_RUNTIMES } from '#runtime/runtimes/catalog.js'
import { optionFieldOf, parseRuntimeOptionPath, validateRuntimeOption, type RuntimeOptionSpec } from '#runtime/runtimes/options.js'
import { DEFAULT_RUNTIME_PLUGINS } from '#runtime/plugins/loader.js'
import { DEFAULT_CHANNEL_PLUGINS } from '#channel/plugins/loader.js'
import { noopLogger, errorMessage, type Logger } from '#infra/logger.js'
import type { PluginEntry } from '#infra/plugin-loader.js'

const runtimePackage: Record<string, string> = { ...DEFAULT_RUNTIME_PLUGINS }
const channelPackage = (id: string): string | undefined => DEFAULT_CHANNEL_PLUGINS[id]

export type ChatMode = 'all' | 'mention'

/** Worker 启动方式：技能目录按需读取，或回退到 prompt 里的旧内联手册。 */
export type WorkerSkillMode = 'path' | 'inline'

/** 选择题的作答方式：按钮回调、序号回复，或自动探测。 */
export type AskMode = 'callback' | 'text' | 'auto'

/** 谁能作答：群内任何人，或仅工单发起人。 */
export type AskAllow = 'anyone' | 'requester'

/** worker 的默认工具策略：只允许上报/文档/git/gh/glab，默认无网络。 */
export const DEFAULT_WORKER_TOOLS: ToolPolicy = {
  fileAccess: 'read-write',
  shell: 'allowlist',
  shellAllow: [
    'ra reply', 'ra report', 'ra doc', 'git', 'gh', 'glab',
    'pnpm', 'npm', 'npx', 'node', 'yarn', 'bun',
    'python', 'python3', 'pytest', 'cargo', 'go', 'make', 'mvn', 'gradle',
  ],
  allowNetwork: false,
}

/**
 * 一个被监控的群：接收方式与派工绑定都写在这一条里，
 * 不再需要同时在 chats / otherChats / chatBindings 四处登记。
 */
export interface ChatSettings {
  chat: string
  /** all：全部消息，且不 @ 也会回复；mention：只收 @机器人。 */
  mode: ChatMode
  /** 群级派工绑定：项目名或仓库选择器；空表示开工前追问。 */
  repo: string
  /** 群级派工绑定：起始分支；空表示开工前追问。 */
  branch: string
  /** 本群只允许这些 open_id 操作；空表示沿用全局 feishu.allowed。 */
  allowed: string[]
  /** 本群的「需求分析助手」配置；默认关闭。 */
  intake: ChatIntakeSettings
}

export function chatEntry(chat: string, over: Partial<Omit<ChatSettings, 'chat'>> = {}): ChatSettings {
  const { intake, ...rest } = over
  return { chat, mode: 'all', repo: '', branch: '', allowed: [], ...rest, intake: defaultChatIntake(intake ?? {}) }
}

/**
 * 「需求分析助手」的群级配置。
 *
 * 默认关闭：开启后，群里的普通成员不 @ 机器人也能触发初筛；
 * 初筛判为故障 / 需求的消息进入多轮澄清，结构化结果必须经管理员终审才派单。
 */
export interface ChatIntakeSettings {
  /** 是否在这个群开启需求分析助手。 */
  enabled: boolean
  /** 最多主动追问几轮；达到上限后直接整理现有信息交给管理员终审。 */
  maxQuestions: number
  /**
   * 分析引擎是否读取当前群绑定项目的本地代码。
   * 关闭后只依据对话与业务知识作答，不碰文件系统。
   */
  codeAccess: boolean
  /** 终审管理员：邮箱（推荐）或 open_id；为空时回退到全局 allowed 名单。 */
  approvers: string[]
}

/** 需求分析助手的默认配置：关闭、最多追问 10 轮、允许只读项目代码。 */
export const DEFAULT_CHAT_INTAKE: ChatIntakeSettings = {
  enabled: false,
  maxQuestions: 10,
  codeAccess: true,
  approvers: [],
}

export function defaultChatIntake(over: Partial<ChatIntakeSettings> = {}): ChatIntakeSettings {
  return { ...DEFAULT_CHAT_INTAKE, ...over }
}

export interface FeishuSettings {
  /** 专属机器人的 App ID；App Secret 只写进 lark-cli 的加密存储。 */
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
  /**
   * worker 被服务重启打断后的恢复策略。
   *
   * auto：自动补一条输入让 worker 从中断处接着做（默认）。
   * notify：只发飞书提醒，等用户回复才恢复。
   * off：完全不处理。
   */
  interruptedRecovery: InterruptedRecoveryMode
  /** 同一工单最多自动恢复几次；超出后降级为飞书提醒。 */
  maxAutoRecover: number
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

/** 一个可派工的项目。name 是用户/模型口中引用的名字，repo 是交给后端的仓库定位。 */
export interface ProjectConfig {
  name: string
  repo: string
  /** 工单未指定分支时的默认起始分支；空字符串表示必须问用户。 */
  defaultBranch: string
}

/**
 * 按 runtime 隔离的项目清单。
 *
 * - `orca` 存在顶层 `projects`（兼容旧配置与旧工具）；
 * - 其它 runtime 存在 `runtime.projects.<runtimeId>`，只在该 runtime 作为默认 runtime 时使用。
 */
export type RuntimeProjects = Record<string, ProjectConfig[]>

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
 * 闲置工单治理：长时间没有新进展的工单先提醒，再自动关闭。
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

/**
 * 关单后的工作区回收：关单只停 worker、保留目录，目录由定时任务在保留期后回收，
 * 或者由用户在面板 / `router_workspace_remove` 手动回收。
 */
export interface WorkspaceSettings {
  /** 总开关；关闭后定时任务不再回收任何目录（只能手动回收）。 */
  enabled: boolean
  /** 关单后目录保留多久；0 表示下一个扫描周期就回收。 */
  keepHours: number
  /** 扫描间隔（分钟）。 */
  sweepMinutes: number
}

/** Router 支持的模型接口协议；默认 OpenAI 兼容。 */
export const LLM_APIS = ['openai-completions', 'anthropic-messages'] as const
export type LlmApi = typeof LLM_APIS[number]

export interface LlmSettings {
  baseUrl?: string
  apiKey?: string
  model?: string
  /** 接口协议；不写按 openai-completions 处理（兼容旧配置）。 */
  api?: LlmApi
  /** anthropic-messages 下是否把 apiKey 作为 Authorization: Bearer 发送（ANTHROPIC_AUTH_TOKEN）。 */
  authHeader?: boolean
  temperature?: number
  contextWindow?: number
  /** 图片转写单独指定时使用；只影响图片链路。 */
  imageModel?: string
  imageBaseUrl?: string
  imageApiKey?: string
}

export interface AppConfig {
  home: string
  projects: ProjectConfig[]
  feishu: FeishuSettings
  policy: PolicySettings
  router: RouterSettings
  progress: ProgressSettings
  retention: RetentionSettings
  workspace: WorkspaceSettings
  worker: {
    tools: ToolPolicy
    evidence: { ui: UiEvidenceMode }
    /** 技能化启动（path）或回退到旧的内联手册（inline）。 */
    skill: { mode: WorkerSkillMode }
  }
  /** Worker 选择题（--ask）的作答方式与权限。 */
  reply: {
    ask: { mode: AskMode; allow: AskAllow; timeoutMs: number }
  }
  runtime: {
    default: string
    options?: Record<string, unknown>
    projects?: RuntimeProjects
    /** 运行时插件入口；id 可覆盖内置包，也可以新增自定义 runtime。 */
    plugins?: Record<string, PluginEntry>
    /** 运行期发现的实例 id（createAll 多实例）；只用于校验，不写回配置文件。 */
    loadedIds?: string[]
    /** 插件声明的选项 schema；只用于面板渲染与校验，不写回配置文件。 */
    optionSpecs?: RuntimeOptionSpec[]
  }
  /** 通道插件入口；id 可覆盖内置飞书包，也可以新增自定义 channel。 */
  channels?: Record<string, PluginEntry>
  server: { port: number }
  llm?: LlmSettings
}

/** 某个 runtime 当前可用的项目清单；orca 兼容顶层 projects。 */
export function projectsForRuntime(config: AppConfig, runtimeId: string = config.runtime.default): ProjectConfig[] {
  const id = normalizeRuntimeId(runtimeId)
  if (id === ORCA_RUNTIME_ID) return config.projects
  return config.runtime.projects?.[id] ?? []
}

/** 写入某个 runtime 的项目清单；orca 同步顶层字段，保持旧配置与旧工具可读。 */
export function setProjectsForRuntime(config: AppConfig, runtimeId: string, projects: ProjectConfig[]): void {
  const id = normalizeRuntimeId(runtimeId)
  if (id === ORCA_RUNTIME_ID) {
    config.projects = projects
    return
  }
  config.runtime.projects = { ...(config.runtime.projects ?? {}), [id]: projects }
}

/**
 * 写入（或删除）一个运行时选项。
 *
 * 运行时选项走通用的 `runtime.options.<runtimeId>.<key>`：每个运行时自己声明能配什么，
 * 这里只负责按声明落盘。空串表示「不覆盖」，直接删掉这个键。
 */
export function setRuntimeOption(config: AppConfig, runtimeId: string, key: string, value: unknown): void {
  const options = { ...(config.runtime.options ?? {}) }
  const entry = { ...((options[runtimeId] as Record<string, unknown> | undefined) ?? {}) }
  if (value === '' || value === undefined || value === null) delete entry[key]
  else entry[key] = value
  if (Object.keys(entry).length === 0) delete options[runtimeId]
  else options[runtimeId] = entry
  // 全删光时连 options 段一起去掉，配置文件不留空壳。
  config.runtime.options = Object.keys(options).length > 0 ? options : undefined
}

/** 写入或删除 runtime 插件入口；空串表示移除该条目。 */
export function setRuntimePlugin(config: AppConfig, id: string, value: PluginEntry | ''): void {
  const plugins = { ...(config.runtime.plugins ?? {}) }
  if (value === '') delete plugins[id]
  else plugins[id] = value
  config.runtime.plugins = Object.keys(plugins).length > 0 ? plugins : undefined
}

/** 写入或删除 channel 插件入口；空串表示移除该条目。 */
export function setChannelPlugin(config: AppConfig, id: string, value: PluginEntry | ''): void {
  const channels = { ...(config.channels ?? {}) }
  if (value === '') delete channels[id]
  else channels[id] = value
  config.channels = Object.keys(channels).length > 0 ? channels : undefined
}

/** 当前配置里可用的 runtime id：SDK 内置 + 用户声明的插件 id + 插件声明的多实例 id。 */
export function isKnownRuntimeId(config: AppConfig, id: string): boolean {
  const value = normalizeRuntimeId(id)
  return isWorkerRuntimeId(value)
    || Boolean(config.runtime.plugins?.[value])
    || (config.runtime.loadedIds ?? []).includes(value)
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

/** 开启了「需求分析助手」的群；一个都没开时不装配需求识别链路。 */
export function intakeEnabledChats(config: AppConfig): string[] {
  return config.feishu.chats.filter(chat => chat.intake?.enabled).map(chat => chat.chat)
}

export function defaultConfig(): AppConfig {
  return {
    home: '',
    projects: [],
    feishu: {
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
      interruptedRecovery: 'auto',
      maxAutoRecover: 1,
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
    workspace: {
      enabled: true,
      // 用户口径：关单只停 worker，目录保留 1 天后由定时任务回收。
      keepHours: 24,
      sweepMinutes: 30,
    },
    worker: { tools: { ...DEFAULT_WORKER_TOOLS }, evidence: { ui: 'warn' }, skill: { mode: 'path' } },
    reply: { ask: { mode: 'auto', allow: 'anyone', timeoutMs: 30 * 60_000 } },
    runtime: { default: 'orca' },
    server: { port: 3083 },
  }
}

const DEFAULT_CONFIG_YAML = `# router-agent 全局配置
feishu:
  # 专属机器人 App ID；App Secret 只写入 lark-cli 加密存储，不落本文件。
  # lark-cli profile 固定为 ~/.router-agent-lark，不可配置。
  appId: ""
  # 监控的群：一条配置同时决定「收什么消息 + 派工绑定」
  chats: []
  #  - chat: oc_xxx
  #    mode: all          # all=全部消息且不 @ 也回复；mention=只收 @机器人
  #    repo: router-agent # 可选：群绑定项目（项目名或仓库选择器），开工不再追问
  #    branch: main       # 由项目默认分支自动决定
  #    allowed: [ou_xxx]  # 可选：本群只允许这些人操作（空=沿用全局 allowed）
  directMessages: true
  allowed: []          # 允许发起工作的 open_id
  bots: []             # 允许产生推断候选的机器人 open_id
  botOpenIds: []       # 机器人自己的 open_id
  botNames: []         # 机器人显示名
  # 图片消息：原图落盘并透传给 Worker，同时转成文本进入研判
  images:
    enabled: true
    maxChars: 2000     # 单张图片转写结果的最大字符数
    timeoutMs: 60000   # 单张图片识别超时（毫秒）

policy:
  acceptMode: auto     # off / observe / auto
  maxWorkers: 4
  # worker 被服务重启打断后的恢复策略：
  #   auto   = 自动补一条输入，让 worker 从中断处接着做
  #   notify = 只发飞书提醒，等用户回复才恢复
  #   off    = 不处理
  interruptedRecovery: auto
  maxAutoRecover: 1    # 同一工单最多自动恢复几次，超出后降级为飞书提醒

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
    style: friendly        # friendly | concise | professional
    language: zh-CN

progress:
  syncMs: 60000        # 工单进展合并同步间隔（毫秒）；0 = 关闭定时同步
  probeMs: 120000      # 主动巡检间隔（毫秒）：读 worker 终端并同步进展；0 = 关闭
  silenceMs: 600000    # 多久没有新上报/新输入才算静默（毫秒）
  repeatMs: 900000     # 同一静默期内重复提醒的最小间隔（毫秒）

# 闲置工单治理：先提醒，宽限期后自动关闭（workspace 不在关单时回收）
retention:
  enabled: true
  idleHours: 24        # 多久没有新进展就发关单提醒
  closeGraceHours: 6   # 提醒后多久没回复就自动关闭
  zombieHours: 6       # 执行中但多久没上报/输出算僵尸
  sweepMinutes: 5      # 扫描间隔（分钟）

# 关单后的工作区回收：关单只停 worker，目录保留一段时间后由定时任务回收
workspace:
  enabled: true
  keepHours: 24        # 关单后保留多久；0 = 下个扫描周期就回收
  sweepMinutes: 30     # 扫描间隔（分钟）

runtime:
  default: orca         # 新工单默认 runtime：orca | claude-code | acp | acp-claude | acp-codex ...
  # ACP 运行时（可选）：ra 启动时会探测本机可用的 ACP Agent，也可以在 Web 面板选择
  # 动态 id 为 acp-<agent>，例如 acp-claude / acp-codex / acp-opencode。
  # options:
  #   acp:                # 旧的自定义命令入口，兼容保留
  #     command: opencode
  #     args: [acp]
  #     env: {}
  #   acp-codex:          # 覆盖单个 ACP Agent 的命令/参数/环境变量
  #     command: /Users/me/.router-agent/runtimes/codex/node_modules/.bin/codex-acp
  #     args: ["--message-streaming"]
  #     env: {}
  #   codex-app:           # Codex App 运行时；CODEX_HOME 缺省为 ~/.codex，与桌面端一致
  #     env:
  #       CODEX_HOME: /Users/me/.codex
  # 非 orca runtime 用独立项目清单，和顶层 projects 互不影响
  # projects:
  #   claude-code:
  #     - name: router-agent
  #       repo: /Users/me/router-agent   # 所有 runtime 统一是本地仓库绝对路径
  #       defaultBranch: main

# orca 项目清单（顶层 projects 只属于 orca runtime）
projects: []
#  - name: router-agent            # 用户/模型引用的项目名
#    repo: /Users/me/router-agent   # 本地仓库绝对路径；派工时自动登记成 Orca 项目
#    defaultBranch: main           # 未指定分支时使用；留空则必须问用户

server:
  port: 3083

# 模型配置必填：baseUrl / model / apiKey 三项缺一不可，未配置时服务启动会直接报错；
# 也可以在 Web 面板「初始化 · LLM Provider」里填写，或从 Claude Code / CCSwitch / Pi / OpenCode / Magpie 的本地配置导入
# 环境变量 RA_LLM_BASE_URL / RA_LLM_API_KEY / RA_LLM_MODEL 优先级更高，可按需覆盖
# llm:
#   baseUrl: https://api.deepseek.com/v1
#   model: deepseek-v4-flash
#   apiKey: sk-xxx
#   api: openai-completions   # 或 anthropic-messages（Claude Code / CCSwitch 的 Anthropic 兼容网关）
#   authHeader: false         # anthropic-messages 用 ANTHROPIC_AUTH_TOKEN 时改成 true
#   contextWindow: 128000     # 用于会话自动压缩的阈值计算
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

/** loadConfig 的可选依赖；不传时所有诊断静默，兼容测试与嵌入用法。 */
export interface ConfigLoadOptions {
  /** 配置创建 / 解析失败 / 旧配置迁移 / 非法配置的日志出口。 */
  logger?: Logger
}

export function loadConfig(home: string = defaultHome(), env: NodeJS.ProcessEnv = process.env, options: ConfigLoadOptions = {}): AppConfig {
  const logger = options.logger ?? noopLogger
  const configPath = join(home, 'config.yaml')
  const configExisted = existsSync(configPath)
  ensureHome(home)
  // 首次启动会写一份默认配置；显式记一条，避免用户以为「我明明配过」。
  if (!configExisted) logger.info('config:created', { path: configPath })
  const base = defaultConfig()
  let doc: Record<string, any> = {}
  if (existsSync(configPath)) {
    try {
      doc = (parseYaml(readFileSync(configPath, 'utf8')) as Record<string, any>) ?? {}
    } catch (error) {
      // YAML 写坏时继续用默认值启动，但不能静默：否则配置看起来「没生效」却查不到原因。
      doc = {}
      logger.warn('config:parse-failed', { path: configPath, message: errorMessage(error) })
    }
  }

  // 旧版配置段名 backend 兼容：等价映射到 runtime，避免升级后静默丢失设置。
  if (doc.runtime === undefined && doc.backend !== undefined) {
    doc.runtime = doc.backend
    logger.info('config:legacy-backend', { path: configPath })
  }

  const acceptMode = pickAcceptMode(doc.policy?.acceptMode, base.policy.acceptMode)
  const port = Number(doc.server?.port)
  const progressDoc = doc.progress ?? {}
  const progressSyncMs = Number(progressDoc.syncMs)
  const progressProbeMs = Number(progressDoc.probeMs)
  const progressSilenceMs = Number(progressDoc.silenceMs)
  const progressRepeatMs = Number(progressDoc.repeatMs)
  const retentionDoc = doc.retention ?? {}
  const workspaceDoc = doc.workspace ?? {}
  const projectLists = parseProjectLists(doc.runtime?.projects)
  const runtimePlugins = parsePlugins(doc.runtime?.plugins)
  const channelPlugins = parsePlugins(doc.channels)

  const admissionDoc = doc.policy?.admission ?? {}
  const admission: AdmissionTable = {
    listedNotAddressed: pickAdmission(admissionDoc.listedNotAddressed, base.policy.admission.listedNotAddressed, ['inferred', 'ignore']) as never,
    unlistedAddressed: pickAdmission(admissionDoc.unlistedAddressed, base.policy.admission.unlistedAddressed, ['explicit', 'inferred', 'ignore']) as never,
    unlistedNotAddressed: pickAdmission(admissionDoc.unlistedNotAddressed, base.policy.admission.unlistedNotAddressed, ['inferred', 'ignore']) as never,
  }

  // 安全参数只由 worker.tools 与 adapter 内置基线决定，不允许 runtime.options 放宽。
  if (doc.runtime?.options && typeof doc.runtime.options === 'object') {
    const forbidden = new Set(['allowedTools', 'permissionMode', 'sandbox', 'shellAllow', 'allowNetwork', 'fileAccess'])
    for (const [id, options] of Object.entries(doc.runtime.options as Record<string, unknown>)) {
      if (!options || typeof options !== 'object') continue
      const bad = Object.keys(options as Record<string, unknown>).filter(key => forbidden.has(key))
      if (bad.length > 0) {
        logger.error('config:invalid-security-override', { path: configPath, runtime: id, keys: bad })
        throw new Error(`runtime.options.${id} 不允许覆盖安全参数: ${bad.join(', ')}`)
      }
    }
  }

  // 群配置先解析出来：旧版全局 intake 段要迁移到群条目上。
  const chats = parseChats(doc)
  migrateLegacyIntake(doc, chats, logger)

  const config: AppConfig = {
    home,
    projects: projectLists.orca ?? parseProjects(doc.projects),
    feishu: {
      appId: stringOr(doc.feishu?.appId, base.feishu.appId),
      reaction: stringOr(doc.feishu?.reaction, base.feishu.reaction),
      chats,
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
      interruptedRecovery: pickInterruptedRecovery(doc.policy?.interruptedRecovery, base.policy.interruptedRecovery),
      maxAutoRecover: positiveIntOr(doc.policy?.maxAutoRecover, base.policy.maxAutoRecover, 0, 100),
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
    workspace: {
      enabled: booleanOr(workspaceDoc.enabled, base.workspace.enabled),
      keepHours: positiveNumberOr(workspaceDoc.keepHours, base.workspace.keepHours, 0, 24 * 365),
      sweepMinutes: positiveNumberOr(workspaceDoc.sweepMinutes, base.workspace.sweepMinutes, 1, 24 * 60),
    },
    worker: {
      tools: {
        fileAccess: doc.worker?.tools?.fileAccess === 'read-only' ? 'read-only' : base.worker.tools.fileAccess,
        shell: (['deny', 'allowlist', 'allow'].includes(String(doc.worker?.tools?.shell))
          ? String(doc.worker.tools.shell)
          : base.worker.tools.shell) as ToolPolicy['shell'],
        shellAllow: stringArray(doc.worker?.tools?.shellAllow, base.worker.tools.shellAllow ?? []),
        allowNetwork: booleanOr(doc.worker?.tools?.allowNetwork, base.worker.tools.allowNetwork),
      },
      evidence: {
        ui: pickUiEvidenceMode(doc.worker?.evidence?.ui, base.worker.evidence.ui),
      },
      skill: {
        mode: doc.worker?.skill?.mode === 'inline' ? 'inline' : base.worker.skill.mode,
      },
    },
    reply: {
      ask: {
        mode: doc.reply?.ask?.mode === 'callback' || doc.reply?.ask?.mode === 'text'
          ? doc.reply.ask.mode
          : base.reply.ask.mode,
        allow: doc.reply?.ask?.allow === 'requester' ? 'requester' : base.reply.ask.allow,
        timeoutMs: positiveIntOr(doc.reply?.ask?.timeoutMs, base.reply.ask.timeoutMs, 60_000, 24 * 60 * 60_000),
      },
    },
runtime: {
      // 旧配置里的 claude-cli 自动归一成 claude-code，避免升级后启动失败。
      default: normalizeRuntimeId(stringOr(doc.runtime?.default, base.runtime.default)),
      ...(doc.runtime?.options && typeof doc.runtime.options === 'object' ? { options: doc.runtime.options } : {}),
      ...(Object.keys(projectLists.others).length > 0 ? { projects: projectLists.others } : {}),
      ...(Object.keys(runtimePlugins).length > 0 ? { plugins: runtimePlugins } : {}),
    },
    ...(Object.keys(channelPlugins).length > 0 ? { channels: channelPlugins } : {}),
    server: { port: Number.isFinite(port) && port >= 0 && port < 65536 ? port : base.server.port },
    ...(isRecord(doc.llm) ? { llm: parseLlm(doc.llm) } : {}),
  }
  // 群绑定分支始终跟随项目清单，避免 YAML 里残留的自定义分支与面板显示不一致。
  alignChatBranches(config)
  return config
}

/**
 * 只保留认识的 llm 字段，避免手写 YAML 里混入拼错或类型不对的键后，
 * 悄悄跟随运行期一路传进 Pi（尤其是 api / authHeader 会直接影响请求协议）。
 */
function parseLlm(value: unknown): LlmSettings {
  if (!isRecord(value)) return {}
  const out: LlmSettings = {}
  for (const key of ['baseUrl', 'apiKey', 'model', 'imageModel', 'imageBaseUrl', 'imageApiKey'] as const) {
    const raw = value[key]
    if (typeof raw === 'string' && raw.trim()) out[key] = raw.trim()
  }
  if (typeof value.api === 'string' && (LLM_APIS as readonly string[]).includes(value.api)) {
    out.api = value.api as LlmApi
  }
  if (typeof value.authHeader === 'boolean') out.authHeader = value.authHeader
  if (typeof value.temperature === 'number' && Number.isFinite(value.temperature)) {
    out.temperature = value.temperature
  }
  if (typeof value.contextWindow === 'number' && Number.isInteger(value.contextWindow) && value.contextWindow > 0) {
    out.contextWindow = value.contextWindow
  }
  return out
}

/**
 * 名单条目的解析结果（邮箱 → open_id）。
 *
 * 由解析层在运行时算好后注入：配置层负责把用户填的邮箱变成 open_id，
 * 运行时只按 open_id 匹配，不再查任何外部服务。
 */
export interface PolicyResolution {
  /** 全局名单解析出的 open_id。 */
  allowedOpenIds?: string[]
  /** 群级名单解析出的 open_id。 */
  allowedByChatOpenIds?: Record<string, string[]>
  /** open_id → 通讯录显示名；只用于展示。 */
  names?: Record<string, string>
}

/** 把配置折算成领域 Policy；版本号是规则的指纹。 */
export function policyOf(config: AppConfig, resolved?: PolicyResolution): Policy {
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
    // 解析结果不进版本指纹：解析抖动（缓存过期、通讯录临时查不通）不得触发 policy 变更。
    ...(resolved?.allowedOpenIds !== undefined ? { allowedOpenIds: resolved.allowedOpenIds } : {}),
    ...(resolved?.allowedByChatOpenIds !== undefined ? { allowedByChatOpenIds: resolved.allowedByChatOpenIds } : {}),
    ...(resolved?.names !== undefined ? { names: resolved.names } : {}),
  }
}

function pickAcceptMode(value: unknown, fallback: AcceptMode): AcceptMode {
  return value === 'off' || value === 'observe' || value === 'auto' ? value : fallback
}

function pickUiEvidenceMode(value: unknown, fallback: UiEvidenceMode): UiEvidenceMode {
  return value === 'off' || value === 'warn' || value === 'enforce' ? value : fallback
}

function pickInterruptedRecovery(value: unknown, fallback: InterruptedRecoveryMode): InterruptedRecoveryMode {
  return value === 'auto' || value === 'notify' || value === 'off' ? value : fallback
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
      defaultBranch: typeof entry.defaultBranch === 'string' ? entry.defaultBranch.trim() : '',
    })
  }
  return projects
}

/**
 * 解析插件入口表。
 *
 * 字符串与 `{ plugin | path | package, entry, enabled }` 都认；`enabled: false`
 * 表示显式禁用内置插件。非法值跳过而不是让整份配置启动失败。
 */
function parsePlugins(value: unknown): Record<string, PluginEntry> {
  if (!isRecord(value)) return {}
  const plugins: Record<string, PluginEntry> = {}
  for (const [rawId, item] of Object.entries(value)) {
    const id = rawId.trim()
    if (!id) continue
    if (typeof item === 'string') {
      if (item.trim()) plugins[id] = item.trim()
      continue
    }
    if (!isRecord(item)) continue
    const entry: Exclude<PluginEntry, string> = {
      ...(typeof item.plugin === 'string' && item.plugin.trim() ? { plugin: item.plugin.trim() } : {}),
      ...(typeof item.path === 'string' && item.path.trim() ? { path: item.path.trim() } : {}),
      ...(typeof item.package === 'string' && item.package.trim() ? { package: item.package.trim() } : {}),
      ...(typeof item.entry === 'string' && item.entry.trim() ? { entry: item.entry.trim() } : {}),
      ...(typeof item.enabled === 'boolean' ? { enabled: item.enabled } : {}),
    }
    if (Object.keys(entry).length > 0) plugins[id] = entry
  }
  return plugins
}

/**
 * 解析 `runtime.projects`：
 * - `orca` 键优先于顶层 `projects`（新配置写哪里都能读）；
 * - 其它运行时按 id 归一（旧键 claude-cli 也认）；
 * - 未知运行时直接忽略，避免拼错键名时静默生效。
 */
function parseProjectLists(value: unknown): { orca?: ProjectConfig[]; others: RuntimeProjects } {
  const others: RuntimeProjects = {}
  if (!isRecord(value)) return { others }
  let orca: ProjectConfig[] | undefined
  for (const [rawId, list] of Object.entries(value)) {
    const id = normalizeRuntimeId(rawId)
    if (!isWorkerRuntimeId(id)) continue
    if (id === ORCA_RUNTIME_ID) orca = parseProjects(list)
    else others[id] = parseProjects(list)
  }
  return { ...(orca ? { orca } : {}), others }
}

/**
 * 统一的群配置解析：
 * - 新写法 `feishu.chats: [{ chat, mode, repo, branch }]`（字符串条目等价于 mode=all）
 * - 兼容旧写法 `otherChats`（mention）与顶层 `chatBindings`（补 repo/branch，
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
    settings.allowed = stringArray(entry.allowed, settings.allowed).map(id => id.trim()).filter(Boolean)
    settings.intake = parseChatIntake(entry.intake, settings.intake)
    explicit.add(chat)
  }

  for (const chat of stringArray(feishu.otherChats, [])) {
    if (!chat || explicit.has(chat)) continue
    ensure(chat).mode = 'mention'
  }
  for (const binding of parseLegacyBindings(doc.chatBindings)) {
    const settings = ensure(binding.chat)
    if (binding.repo) settings.repo = binding.repo
    if (binding.branch) settings.branch = binding.branch
  }

  return [...byChat.values()]
}

/** 最多追问轮数的上限：再大就会让群里一直追问下去，反而收不敛。 */
const MAX_INTAKE_QUESTIONS = 50

/** 解析群级的需求分析配置；缺字段时沿用默认值。 */
function parseChatIntake(value: unknown, fallback: ChatIntakeSettings): ChatIntakeSettings {
  if (!isRecord(value)) return fallback
  return {
    enabled: booleanOr(value.enabled, fallback.enabled),
    maxQuestions: positiveIntOr(value.maxQuestions, fallback.maxQuestions, 0, MAX_INTAKE_QUESTIONS),
    codeAccess: booleanOr(value.codeAccess, fallback.codeAccess),
    approvers: stringArray(value.approvers, fallback.approvers).map(item => item.trim()).filter(Boolean),
  }
}

/**
 * 旧版全局 `intake:` 段迁移到群级配置。
 *
 * 旧配置是「一个总开关 + 生效群白名单」；新配置把开关与参数下沉到每个群。
 * 迁移规则：
 * - `intake.chats` 非空：只迁移到这些群；
 * - `intake.chats` 为空：迁移到所有已监控的群。
 *
 * 迁移只改内存里的配置，写回时全局段不再输出（见 `writeConfig`），
 * 所以用户下次保存配置就自动完成升级，不需要手工改 YAML。
 */
function migrateLegacyIntake(doc: Record<string, any>, chats: ChatSettings[], logger: Logger): void {
  const legacy = doc.intake
  if (!isRecord(legacy)) return
  const targets = new Set(stringArray(legacy.chats, []).map(chat => chat.trim()).filter(Boolean))
  const enabled = booleanOr(legacy.enabled, false)
  const approvers = stringArray(legacy.approvers, []).map(item => item.trim()).filter(Boolean)
  // 旧段里没有任何有效内容：直接按新默认值走，不必打扰用户。
  if (!enabled && approvers.length === 0 && targets.size === 0) return
  const maxQuestions = positiveIntOr(legacy.maxQuestions, DEFAULT_CHAT_INTAKE.maxQuestions, 0, MAX_INTAKE_QUESTIONS)
  const codeAccess = booleanOr(legacy.codeAccess, DEFAULT_CHAT_INTAKE.codeAccess)
  const scope = targets.size > 0 ? targets : new Set(chats.map(chat => chat.chat))
  // 已经写过群级配置的群不动：用户手写的比旧全局段更具体。
  const explicit = new Set<string>()
  for (const item of Array.isArray(doc.feishu?.chats) ? doc.feishu.chats : []) {
    if (item && typeof item === 'object' && isRecord((item as Record<string, unknown>).intake)) {
      const chat = typeof (item as Record<string, any>).chat === 'string' ? String((item as Record<string, any>).chat).trim() : ''
      if (chat) explicit.add(chat)
    }
  }
  const migrated: string[] = []
  for (const chat of chats) {
    if (!scope.has(chat.chat) || explicit.has(chat.chat)) continue
    chat.intake = { enabled, maxQuestions, codeAccess, approvers: [...approvers] }
    migrated.push(chat.chat)
  }
  logger.info('config:intake-migrated', { chats: migrated, enabled, maxQuestions })
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
  const raw = repo.trim().replace(/^(id|name|path):/, '').replace(/\/+$/, '')
  // 本地绝对路径取最后一段作为项目名，避免名字里出现整条路径。
  if (raw.startsWith('/')) return raw.split('/').filter(Boolean).at(-1) ?? raw
  return raw
}

/**
 * 群级需求分析配置的落盘形态。
 *
 * 与默认值完全一致时不写这一段：配置文件里只留下用户真正改过的项。
 */
function intakeDocOf(intake: ChatIntakeSettings): Record<string, unknown> | undefined {
  const same = intake.enabled === DEFAULT_CHAT_INTAKE.enabled
    && intake.maxQuestions === DEFAULT_CHAT_INTAKE.maxQuestions
    && intake.codeAccess === DEFAULT_CHAT_INTAKE.codeAccess
    && intake.approvers.length === 0
  if (same) return undefined
  return {
    enabled: intake.enabled,
    maxQuestions: intake.maxQuestions,
    codeAccess: intake.codeAccess,
    ...(intake.approvers.length > 0 ? { approvers: intake.approvers } : {}),
  }
}

/** 把配置写回 config.yaml；保留所有可选字段当前值，方便用 `ra config` 继续调。 */
export function writeConfig(home: string, config: AppConfig): void {
  mkdirSync(home, { recursive: true })
  const doc: Record<string, unknown> = {
    feishu: {
      appId: config.feishu.appId,
      reaction: config.feishu.reaction,
      chats: config.feishu.chats.map(chat => {
        const intake = intakeDocOf(chat.intake)
        return {
          chat: chat.chat,
          mode: chat.mode,
          ...(chat.repo ? { repo: chat.repo } : {}),
          ...(chat.branch ? { branch: chat.branch } : {}),
          ...(chat.allowed.length > 0 ? { allowed: chat.allowed } : {}),
          ...(intake ? { intake } : {}),
        }
      }),
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
      interruptedRecovery: config.policy.interruptedRecovery,
      maxAutoRecover: config.policy.maxAutoRecover,
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
    workspace: {
      enabled: config.workspace.enabled,
      keepHours: config.workspace.keepHours,
      sweepMinutes: config.workspace.sweepMinutes,
    },
    worker: { tools: config.worker.tools, evidence: config.worker.evidence, skill: config.worker.skill },
    reply: config.reply,
    runtime: {
      default: config.runtime.default,
      ...(config.runtime.options ? { options: config.runtime.options } : {}),
      ...(config.runtime.projects && Object.keys(config.runtime.projects).length > 0
        ? { projects: config.runtime.projects }
        : {}),
      ...(config.runtime.plugins && Object.keys(config.runtime.plugins).length > 0
        ? { plugins: config.runtime.plugins }
        : {}),
    },
    ...(config.channels && Object.keys(config.channels).length > 0 ? { channels: config.channels } : {}),
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

// ---------------------------------------------------------------------------
// Web 配置面板：安全视图 + 批量补丁
// ---------------------------------------------------------------------------

/** 配置补丁里的一项校验错误；path 是点路径，前端按它高亮字段。 */
export interface ConfigPatchError {
  path: string
  message: string
}

export interface ConfigPatchResult {
  /** 空数组表示全部通过，配置已写入入参对象。 */
  errors: ConfigPatchError[]
  /** 实际发生变化的点路径，用于日志与「哪些改动需要重启」提示。 */
  changed: string[]
}

/**
 * 立即生效的配置路径前缀；其余改动都需要重启 `ra start`。
 *
 * `feishu.allowed` 现在是热更新：面板保存后服务端会重解析名单并重建策略。
 * 群级 `allowed` 仍挂在 `feishu.chats` 下（同一条目里还有 mode / repo 等必须重启的字段），
 * 所以仍然按需要重启处理。
 */
export const HOT_CONFIG_PREFIXES = ['policy.', 'feishu.allowed'] as const

function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * 供 Web 面板读取的安全配置快照：深拷贝 + 去掉/遮蔽敏感字段。
 * 面板保存时只会提交白名单里的字段，不会把这份快照整体写回。
 */
export function publicConfig(config: AppConfig): Record<string, unknown> {
  const doc = clone(config) as unknown as Record<string, unknown>
  const runtimeDoc = doc.runtime as Record<string, unknown> | undefined
  // 运行期发现的数据不写回配置文件；实例 id 由 plugins 字段下发。
  if (runtimeDoc) delete runtimeDoc.loadedIds
  if (runtimeDoc) delete runtimeDoc.optionSpecs
  const runtime = runtimeDoc
  const llm = (doc.llm ?? {}) as Record<string, unknown>
  // 明文密钥不下发；apiKeySet 只用来告诉面板「已经配过」。
  doc.llm = {
    baseUrl: String(llm.baseUrl ?? ''),
    model: String(llm.model ?? ''),
    api: typeof llm.api === 'string' ? llm.api : 'openai-completions',
    authHeader: llm.authHeader === true,
    ...(typeof llm.contextWindow === 'number' ? { contextWindow: llm.contextWindow } : {}),
    apiKeySet: Boolean(llm.apiKey),
  }
  // ACP 适配器的 env 可能包含 API key：只下发 key 名，不下发明文。
  const options = runtime?.options
  if (runtime && options && typeof options === 'object' && !Array.isArray(options)) {
    const next: Record<string, unknown> = {}
    for (const [id, value] of Object.entries(options as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        next[id] = value
        continue
      }
      const entry = { ...(value as Record<string, unknown>) }
      if (entry.env && typeof entry.env === 'object') {
        entry.envKeys = Object.keys(entry.env as Record<string, unknown>)
        entry.envSet = true
        delete entry.env
      }
      next[id] = entry
    }
    runtime.options = next
  }
  return doc
}

/** 面板插件页需要的元数据；不包含任何密钥或实现细节。 */
export interface PluginConfigView {
  id: string
  kind: 'runtime' | 'channel'
  name?: string
  label?: string
  hint?: string
  installHint?: string
  installUrl?: string
  packageName?: string
  default?: boolean
  /** 当前配置里的入口；内置插件未显式配置时为空。 */
  entry?: PluginEntry
  /** 已加载的 id（runtime 插件可能一次注册多个，如 ACP）。 */
  loadedIds?: string[]
  /** 运行时插件声明的可配置项；Web 面板据此渲染设置弹窗。 */
  options?: RuntimeOptionSpec
  status: 'builtin' | 'configured' | 'loaded' | 'failed'
  error?: string
  /** 失败时实际尝试加载的包名 / 路径。 */
  specifier?: string
}

interface LoadedPluginMeta {
  id: string
  name: string
  label: string
  hint: string
  installHint?: string
  installUrl?: string
  packageName?: string
  deprecated?: boolean
  loadedIds?: string[]
}

interface LoadedChannelMeta {
  id: string
  name: string
  hint: string
  default?: boolean
  packageName?: string
  loadedIds?: string[]
}

/** 插件在面板里的完整视图：插件自身元数据 + 宿主加载状态。 */
export function publicPlugins(config: AppConfig, loaded?: {
  runtimes?: LoadedPluginMeta[]
  channels?: LoadedChannelMeta[]
  failures?: Array<{ kind: 'runtime' | 'channel'; id: string; specifier: string; message: string }>
}): PluginConfigView[] {
  const failures = loaded?.failures ?? []
  // createAll() 的实例 id（如 ACP 的 acp-claude）不是独立插件：面板只列插件本身，
  // 实例挂在 loadedIds 下；运行时候选仍由 ACP 目录单独提供。
  const ownerOf = (id: string): string | undefined => {
    return loaded?.runtimes?.find(item => item.loadedIds?.includes(id) && item.id !== id)?.id
  }
  const hasExplicitEntry = (id: string): boolean => config.runtime.plugins?.[id] !== undefined
  const runtimeIds = new Set([
    ...WORKER_RUNTIMES.map(runtime => runtime.id),
    ...Object.keys(config.runtime.plugins ?? {}),
    ...(loaded?.runtimes ?? [])
      .flatMap(runtime => runtime.loadedIds ?? [runtime.id])
      .filter(id => ownerOf(id) === undefined || hasExplicitEntry(id)),
  ])
  const channelOwnerOf = (id: string): string | undefined =>
    loaded?.channels?.find(item => item.loadedIds?.includes(id) && item.id !== id)?.id
  const channelIds = new Set([
    'feishu',
    ...Object.keys(config.channels ?? {}),
    ...(loaded?.channels ?? [])
      .flatMap(channel => channel.loadedIds ?? [channel.id])
      .filter(id => channelOwnerOf(id) === undefined || config.channels?.[id] !== undefined),
  ])
  const views: PluginConfigView[] = []
  for (const id of runtimeIds) {
    const meta = loaded?.runtimes?.find(item => item.id === id || item.loadedIds?.includes(id))
    const builtin = WORKER_RUNTIMES.find(item => item.id === id)
    const failure = failures.find(item => item.kind === 'runtime' && item.id === id)
    const entry = config.runtime.plugins?.[id]
    const packageName = meta?.packageName ?? runtimePackage[id]
    const spec = config.runtime.optionSpecs?.find(item => item.runtimeId === id)
    views.push({
      id,
      kind: 'runtime',
      ...(meta?.name ?? builtin?.name ? { name: meta?.name ?? builtin?.name } : {}),
      ...(meta?.label ?? builtin?.label ? { label: meta?.label ?? builtin?.label } : {}),
      ...(meta?.hint ?? builtin?.hint ? { hint: meta?.hint ?? builtin?.hint } : {}),
      ...(meta?.installHint ?? builtin?.installHint ? { installHint: meta?.installHint ?? builtin?.installHint } : {}),
      ...(meta?.installUrl ?? builtin?.installUrl ? { installUrl: meta?.installUrl ?? builtin?.installUrl } : {}),
      ...(packageName ? { packageName } : {}),
      ...(meta?.loadedIds ? { loadedIds: meta.loadedIds } : {}),
      ...(spec ? { options: spec } : {}),
      ...(entry !== undefined ? { entry } : {}),
      status: failure ? 'failed' : entry !== undefined ? 'configured' : meta ? 'loaded' : 'builtin',
      ...(failure ? { error: failure.message } : {}),
      ...(failure ? { specifier: failure.specifier } : {}),
    })
  }
  for (const id of channelIds) {
    const meta = loaded?.channels?.find(item => item.id === id || item.loadedIds?.includes(id))
    const failure = failures.find(item => item.kind === 'channel' && item.id === id)
    const entry = config.channels?.[id]
    const packageName = meta?.packageName ?? channelPackage(id)
    views.push({
      id,
      kind: 'channel',
      ...(meta?.name ? { name: meta.name } : {}),
      ...(meta?.hint ? { hint: meta.hint } : {}),
      ...(packageName ? { packageName } : {}),
      ...(meta?.loadedIds ? { loadedIds: meta.loadedIds } : {}),
      ...(meta?.default ? { default: true } : {}),
      ...(entry !== undefined ? { entry } : {}),
      status: failure ? 'failed' : entry !== undefined ? 'configured' : meta ? 'loaded' : 'builtin',
      ...(failure ? { error: failure.message } : {}),
      ...(failure ? { specifier: failure.specifier } : {}),
    })
  }
  return views
}

/** 面板「恢复默认值」用的基准：只保留可编辑口径，避免泄露模板之外的内容。 */
export function publicDefaults(): Record<string, unknown> {
  const base = defaultConfig()
  return {
    feishu: {
      appId: base.feishu.appId,
      reaction: base.feishu.reaction,
      directMessages: base.feishu.directMessages,
      images: base.feishu.images,
    },
    policy: base.policy,
    router: base.router,
    progress: base.progress,
    retention: base.retention,
    workspace: base.workspace,
    worker: base.worker,
    runtime: base.runtime,
    server: base.server,
  }
}

function getPath(doc: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => {
    if (!node || typeof node !== 'object') return undefined
    return (node as Record<string, unknown>)[part]
  }, doc)
}

function setPath(doc: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let node: Record<string, unknown> = doc
  for (const part of parts.slice(0, -1)) {
    const next = node[part]
    if (!next || typeof next !== 'object') node[part] = {}
    node = node[part] as Record<string, unknown>
  }
  node[parts.at(-1)!] = value
}

interface Validator {
  check(value: unknown): string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const stringValue: Validator = {
  check: value => (typeof value === 'string' ? null : '需要字符串'),
}

/** 面板写入密钥时不允许空串：留空在 UI 层表示「保持原密钥」，不会走到这里。 */
const secretValue: Validator = {
  check: value => {
    if (typeof value !== 'string') return '需要字符串'
    return value.trim() ? null : 'API Key 不能为空'
  },
}

function enumValue(allowed: readonly string[]): Validator {
  return { check: value => (typeof value === 'string' && allowed.includes(value) ? null : `只能是 ${allowed.join(' / ')}`) }
}

/** 运行时 id 校验：内置运行时 + ACP 目录 + 当前配置声明的插件。 */
function runtimeIdValueFor(config: AppConfig, declared?: ReadonlySet<string>): Validator {
  return {
    check: value => (typeof value === 'string' && (
      isKnownRuntimeId(config, normalizeRuntimeId(value)) || declared?.has(normalizeRuntimeId(value))
    )
      ? null
      : '未知 runtime：只接受内置运行时，或先在 runtime.plugins 里声明插件'),
  }
}

/** 插件声明的选项；内置声明优先，未知运行时回退到加载器带来的 schema。 */
function optionFieldFor(config: AppConfig, runtimeId: string, key: string) {
  return optionFieldOf(runtimeId, key)
    ?? config.runtime.optionSpecs?.find(spec => spec.runtimeId === runtimeId)?.fields.find(field => field.key === key)
    ?? null
}

function intValue(min: number, max: number, unit = ''): Validator {
  return {
    check: value => {
      if (typeof value !== 'number' || !Number.isInteger(value)) return '需要整数'
      if (value < min || value > max) return `取值范围 ${min}–${max}${unit}`
      return null
    },
  }
}

function parsePluginConfigPath(path: string): { kind: PluginKind; id: string } | null {
  const runtime = /^runtime\.plugins\.([^.]+)$/.exec(path)
  if (runtime) return { kind: 'runtime', id: runtime[1]! }
  const channel = /^channels\.([^.]+)$/.exec(path)
  return channel ? { kind: 'channel', id: channel[1]! } : null
}

function validatePluginEntry(value: unknown): PluginEntry | null {
  if (typeof value === 'string') return value.trim() || ''
  if (!isRecord(value)) return null
  const entry: Exclude<PluginEntry, string> = {
    ...(typeof value.plugin === 'string' && value.plugin.trim() ? { plugin: value.plugin.trim() } : {}),
    ...(typeof value.path === 'string' && value.path.trim() ? { path: value.path.trim() } : {}),
    ...(typeof value.package === 'string' && value.package.trim() ? { package: value.package.trim() } : {}),
    ...(typeof value.entry === 'string' && value.entry.trim() ? { entry: value.entry.trim() } : {}),
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
  }
  return Object.keys(entry).length > 0 ? entry : null
}

type PluginKind = 'runtime' | 'channel'

function boolValue(): Validator {
  return { check: value => (typeof value === 'boolean' ? null : '需要 true / false') }
}

function stringListValue(): Validator {
  return {
    check: value => {
      if (!Array.isArray(value)) return '需要字符串数组'
      if (value.some(item => typeof item !== 'string')) return '数组里只能放字符串'
      return null
    },
  }
}

const ACCEPT_MODES = ['off', 'observe', 'auto']
const INTERRUPTED_RECOVERY_MODES = ['auto', 'notify', 'off']
const ADMISSION_LISTED = ['inferred', 'ignore']
const ADMISSION_UNLISTED_ADDRESSED = ['explicit', 'inferred', 'ignore']

/**
 * 一份显式的路径白名单：校验规则跟着路径走，不再让请求体直接 merge 进配置。
 * 这样做的好处是 API 永远不会因为面板拼错字段名而把 config.yaml 写成垃圾。
 */
const CONFIG_VALIDATORS: Record<string, Validator> = {
  'feishu.appId': stringValue,
  'feishu.reaction': stringValue,
  'feishu.directMessages': boolValue(),
  'feishu.allowed': stringListValue(),
  'feishu.bots': stringListValue(),
  'feishu.botOpenIds': stringListValue(),
  'feishu.botNames': stringListValue(),
  'feishu.images.enabled': boolValue(),
  'feishu.images.maxChars': intValue(100, 20_000, ' 字'),
  'feishu.images.timeoutMs': intValue(1_000, 300_000, ' 毫秒'),

  'policy.acceptMode': enumValue(ACCEPT_MODES),
  'policy.maxWorkers': intValue(1, 64),
  'policy.interruptedRecovery': enumValue(INTERRUPTED_RECOVERY_MODES),
  'policy.maxAutoRecover': intValue(0, 100),
  'policy.admission.listedNotAddressed': enumValue(ADMISSION_LISTED),
  'policy.admission.unlistedAddressed': enumValue(ADMISSION_UNLISTED_ADDRESSED),
  'policy.admission.unlistedNotAddressed': enumValue(ADMISSION_LISTED),

  'router.timeoutMs': intValue(1_000, 600_000, ' 毫秒'),
  'router.tokenBudget': intValue(0, 10_000_000),
  'router.agentDir': stringValue,
  'router.session.enabled': boolValue(),
  'router.session.keyScope': enumValue(['user', 'thread']),
  'router.session.dir': stringValue,
  'router.session.idleTtlMs': intValue(0, 86_400_000, ' 毫秒'),
  'router.session.maxActive': intValue(1, 1_000),
  'router.session.retentionDays': intValue(0, 3_650, ' 天'),
  'router.session.cleanupIntervalHours': intValue(1, 720, ' 小时'),
  'router.session.turnTimeoutMs': intValue(1_000, 3_600_000, ' 毫秒'),
  'router.session.tokenBudget': intValue(0, 10_000_000),
  'router.session.compaction.enabled': boolValue(),
  'router.session.compaction.reserveTokens': intValue(1_024, 1_000_000),
  'router.session.compaction.keepRecentTokens': intValue(1_024, 1_000_000),
  'router.persona.name': stringValue,
  'router.persona.style': enumValue(['friendly', 'concise', 'professional']),
  'router.persona.language': stringValue,

  'progress.syncMs': intValue(0, 3_600_000, ' 毫秒'),
  'progress.probeMs': intValue(0, 3_600_000, ' 毫秒'),
  'progress.silenceMs': intValue(1_000, 3_600_000, ' 毫秒'),
  'progress.repeatMs': intValue(1_000, 3_600_000, ' 毫秒'),

  'retention.enabled': boolValue(),
  'retention.idleHours': intValue(1, 8_760, ' 小时'),
  'retention.closeGraceHours': intValue(1, 8_760, ' 小时'),
  'retention.zombieHours': intValue(1, 8_760, ' 小时'),
  'retention.sweepMinutes': intValue(1, 1_440, ' 分钟'),

  'workspace.enabled': boolValue(),
  'workspace.keepHours': intValue(0, 8_760, ' 小时'),
  'workspace.sweepMinutes': intValue(1, 1_440, ' 分钟'),

  'worker.evidence.ui': enumValue(UI_EVIDENCE_MODES),
  'server.port': intValue(1, 65_535),

  'llm.baseUrl': stringValue,
  'llm.model': stringValue,
  'llm.apiKey': secretValue,
  'llm.api': enumValue(LLM_APIS),
  'llm.authHeader': boolValue(),
  'llm.contextWindow': intValue(1_000, 10_000_000),
}

/** 整段替换的复杂字段（项目、群、白名单这类不适合逐项点路径编辑的配置）。 */
const LIST_PATHS = ['projects', 'feishu.chats'] as const

/** 本地仓库绝对路径：接受 `/abs` 与 `path:/abs`，不接受 Orca 的 name:/id: 选择器。 */
export function isLocalRepoPath(repo: string): boolean {
  return isProjectRepoPath(repo)
}

function validateProjects(value: unknown): { error: string | null; value: ProjectConfig[] } {
  if (!Array.isArray(value)) return { error: '需要项目数组', value: [] }
  const projects: ProjectConfig[] = []
  const names = new Set<string>()
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) return { error: `第 ${index + 1} 项不是对象`, value: [] }
    const repo = typeof item.repo === 'string' ? item.repo.trim() : ''
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (!repo) return { error: `第 ${index + 1} 项缺少 repo`, value: [] }
    const finalName = name || projectNameOf(repo)
    if (names.has(finalName)) return { error: `项目名重复：${finalName}`, value: [] }
    names.add(finalName)
    // 所有 runtime 统一用本地绝对路径，避免把 Orca 的 name:/id: 选择器当路径用。
    if (!isLocalRepoPath(repo)) {
      return {
        error: `项目 ${finalName} 的 repo 必须是本地仓库绝对路径（例如 /Users/me/project），Orca 的 name:/id: 选择器不再支持`,
        value: [],
      }
    }
    const defaultBranch = typeof item.defaultBranch === 'string' ? item.defaultBranch.trim() : ''
    projects.push({ name: finalName, repo, defaultBranch })
  }
  return { error: null, value: projects }
}

function validateChats(value: unknown): { error: string | null; value: ChatSettings[] } {
  if (!Array.isArray(value)) return { error: '需要群数组', value: [] }
  const chats: ChatSettings[] = []
  const seen = new Set<string>()
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) return { error: `第 ${index + 1} 项不是对象`, value: [] }
    const chat = typeof item.chat === 'string' ? item.chat.trim() : ''
    if (!chat) return { error: `第 ${index + 1} 项缺少 chat_id`, value: [] }
    if (seen.has(chat)) return { error: `群重复：${chat}`, value: [] }
    seen.add(chat)
    const mode = item.mode === 'mention' ? 'mention' : 'all'
    const allowed = Array.isArray(item.allowed) ? item.allowed.map(String).map(id => id.trim()).filter(Boolean) : []
    const intake = validateChatIntake(item.intake)
    if (intake.error) return { error: `第 ${index + 1} 项：${intake.error}`, value: [] }
    chats.push(chatEntry(chat, {
      mode,
      repo: typeof item.repo === 'string' ? item.repo.trim() : '',
      branch: typeof item.branch === 'string' ? item.branch.trim() : '',
      allowed,
      intake: intake.value,
    }))
  }
  return { error: null, value: chats }
}

/** 群级需求分析配置校验：轮数必须是 0–50 的整数，管理员按逗号分隔的条目列表存。 */
function validateChatIntake(value: unknown): { error: string | null; value: ChatIntakeSettings } {
  if (value === undefined || value === null) return { error: null, value: defaultChatIntake() }
  if (!isRecord(value)) return { error: '需求分析助手配置必须是对象', value: defaultChatIntake() }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    return { error: '需求分析助手的启用开关必须是布尔值', value: defaultChatIntake() }
  }
  if (value.codeAccess !== undefined && typeof value.codeAccess !== 'boolean') {
    return { error: '需求分析助手的代码读取开关必须是布尔值', value: defaultChatIntake() }
  }
  const maxQuestions = value.maxQuestions === undefined
    ? DEFAULT_CHAT_INTAKE.maxQuestions
    : Number(value.maxQuestions)
  if (!Number.isInteger(maxQuestions) || maxQuestions < 0 || maxQuestions > MAX_INTAKE_QUESTIONS) {
    return { error: `最大对话轮次必须是 0–${MAX_INTAKE_QUESTIONS} 的整数`, value: defaultChatIntake() }
  }
  const approvers = value.approvers === undefined
    ? []
    : (Array.isArray(value.approvers) ? value.approvers : String(value.approvers).split(','))
  return {
    error: null,
    value: {
      enabled: booleanOr(value.enabled, DEFAULT_CHAT_INTAKE.enabled),
      maxQuestions,
      codeAccess: booleanOr(value.codeAccess, DEFAULT_CHAT_INTAKE.codeAccess),
      approvers: approvers.map(item => String(item).trim()).filter(Boolean),
    },
  }
}

/**
 * 把面板提交的一批点路径改动写进配置对象。
 *
 * - 全部字段先校验，有任意一项不合法就整体拒绝（不会写一半）。
 * - `projects` / `feishu.chats` 走整段替换，并做项目名去重等交叉校验。
 * - 返回 changed 供调用方判断是否需要刷新策略 / 提示重启。
 */
export function applyConfigPatch(config: AppConfig, patch: Record<string, unknown>): ConfigPatchResult {
  const errors: ConfigPatchError[] = []
  const accepted: { path: string; value: unknown }[] = []
  // 同一次保存里可能先声明插件、再把它选为默认运行时：校验时把本批声明的 id 也算进来。
  const declared = new Set<string>()
  for (const [path, value] of Object.entries(patch)) {
    if (value === '') continue
    const pluginPath = parsePluginConfigPath(path)
    if (pluginPath?.kind === 'runtime') declared.add(pluginPath.id)
  }

  for (const [path, value] of Object.entries(patch)) {
    // 插件入口：runtime.plugins.<id> / channels.<id>
    const pluginPath = parsePluginConfigPath(path)
    if (pluginPath) {
      if (value === '') {
        accepted.push({ path, value: '' })
        continue
      }
      const entry = validatePluginEntry(value)
      if (!entry) errors.push({ path, message: '插件入口需要 npm 包名、本地路径或 { plugin, entry } 对象' })
      else accepted.push({ path, value: entry })
      continue
    }
    // 按运行时隔离的项目清单：runtime.projects.<runtimeId>
    const runtimeProjectPath = /^runtime\.projects\.([^.]+)$/.exec(path)
    if (runtimeProjectPath) {
      const id = normalizeRuntimeId(runtimeProjectPath[1]!)
      if (!isKnownRuntimeId(config, id) && !declared.has(id)) {
        errors.push({ path, message: `未知 runtime: ${runtimeProjectPath[1]}` })
      } else {
        const result = validateProjects(value)
        if (result.error) errors.push({ path, message: result.error })
        else accepted.push({ path, value: result.value })
      }
      continue
    }
    // 运行时自己的选项：runtime.options.<runtimeId>.<key>，按运行时声明校验。
    const runtimeOption = parseRuntimeOptionPath(path)
    if (runtimeOption) {
      const id = normalizeRuntimeId(runtimeOption.runtimeId)
      if (!isKnownRuntimeId(config, id) && !declared.has(id)) {
        errors.push({ path, message: `未知 runtime: ${runtimeOption.runtimeId}` })
      } else {
        const field = optionFieldFor(config, id, runtimeOption.key)
        if (!field) errors.push({ path, message: `未知选项: ${runtimeOption.key}` })
        else {
          const message = validateRuntimeOption(field, value)
          if (message) errors.push({ path, message })
          else accepted.push({ path, value })
        }
      }
      continue
    }
    if ((LIST_PATHS as readonly string[]).includes(path)) {
      if (path === 'projects') {
        const result = validateProjects(value)
        if (result.error) errors.push({ path, message: result.error })
        else accepted.push({ path, value: result.value })
      } else {
        const result = validateChats(value)
        if (result.error) errors.push({ path, message: result.error })
        else accepted.push({ path, value: result.value })
      }
      continue
    }
    const validator = path === 'runtime.default' ? runtimeIdValueFor(config, declared) : CONFIG_VALIDATORS[path]
    if (!validator) {
      errors.push({ path, message: '不是可编辑的配置项' })
      continue
    }
    // 旧值 claude-cli 在写入前归一成 claude-code；未知值仍由校验器拒绝。
    // LLM 连接信息统一去掉首尾空白，避免粘贴密钥时把换行带进 config.yaml。
    const next = typeof value !== 'string'
      ? value
      : path === 'runtime.default'
        ? normalizeRuntimeId(value)
        : path.startsWith('llm.')
          ? value.trim()
          : value
    const message = validator.check(next)
    if (message) errors.push({ path, message })
    else accepted.push({ path, value: next })
  }

  if (errors.length > 0) return { errors, changed: [] }

  const changed: string[] = []
  for (const { path, value } of accepted) {
    const before = getPath(config, path)
    if (JSON.stringify(before) === JSON.stringify(value)) continue
    if (path === 'projects') config.projects = value as ProjectConfig[]
    else if (path === 'feishu.chats') config.feishu.chats = value as ChatSettings[]
    else if (path.startsWith('runtime.projects.')) {
      setProjectsForRuntime(config, path.slice('runtime.projects.'.length), value as ProjectConfig[])
    } else if (path.startsWith('runtime.options.')) {
      const parsed = parseRuntimeOptionPath(path)!
      setRuntimeOption(config, normalizeRuntimeId(parsed.runtimeId), parsed.key, value)
    } else if (path.startsWith('runtime.plugins.')) {
      setRuntimePlugin(config, path.slice('runtime.plugins.'.length), value as PluginEntry | '')
    } else if (path.startsWith('channels.')) {
      setChannelPlugin(config, path.slice('channels.'.length), value as PluginEntry | '')
    } else setPath(config as unknown as Record<string, unknown>, path, value)
    changed.push(path)
  }

  // 群绑定只跟随项目清单：分支一律取项目的默认分支，不允许在群里单独自定义。
  const touchesBindings = 'feishu.chats' in patch
    || 'runtime.default' in patch
    || Object.keys(patch).some(path => path === 'projects' || path.startsWith('runtime.projects.'))
  if (touchesBindings) alignChatBranches(config)

  return { errors: [], changed }
}

/** 把群绑定的分支对齐到对应项目的默认分支；未绑定项目时清空分支。 */
function alignChatBranches(config: AppConfig): void {
  const projects = projectsForRuntime(config)
  for (const chat of config.feishu.chats) {
    if (!chat.repo) {
      chat.branch = ''
      continue
    }
    const project = projects.find(item => item.name === chat.repo || item.repo === chat.repo)
    if (project) chat.branch = project.defaultBranch
  }
}

/** 除了策略以外，配置都在服务启动时读入，保存后需要重启 `ra start` 才生效。 */
export function requiresRestart(changed: string[]): boolean {
  return changed.some(path => !HOT_CONFIG_PREFIXES.some(prefix => path.startsWith(prefix)))
}

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

  // 多项目：`ra config set project.<name> <repo>[@<defaultBranch>]`，写入当前默认运行时的清单
  if (path.startsWith('project.')) {
    const name = path.slice('project.'.length).trim()
    const [repo, defaultBranch] = splitBranch(value)
    if (!name || !repo) return false
    const runtimeId = config.runtime.default
    // 所有 runtime 统一写本地绝对路径；Orca 侧由适配器翻译成 path: 选择器并自动登记。
    if (!isLocalRepoPath(repo)) return false
    const project: ProjectConfig = { name, repo, defaultBranch }
    const projects = projectsForRuntime(config, runtimeId)
    const index = projects.findIndex(item => item.name === name)
    if (index >= 0) projects[index] = { ...projects[index]!, ...project }
    else projects.push(project)
    setProjectsForRuntime(config, runtimeId, projects)
    return true
  }

  // 群级绑定：`ra config set chatBinding.<chatId> <repo>[@<branch>]`（绑定同时意味着监控这个群）
  if (path.startsWith('chatBinding.')) {
    const chat = path.slice('chatBinding.'.length).trim()
    const [repo, branch] = splitBranch(value)
    if (!chat || !repo) return false
    const entry = ensureChat(config, chat)
    entry.repo = repo
    // 绑定到项目清单里的项目时，分支跟随项目的默认分支；手写仓库才使用显式分支。
    const project = projectsForRuntime(config).find(item => item.name === repo || item.repo === repo)
    entry.branch = project ? project.defaultBranch : branch
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

  // 运行时选项：`ra config set runtime.options.orca.agent codex`
  // 走通用声明：每个运行时自己声明能配哪些键，这里按声明校验后落盘。
  if (path.startsWith('runtime.options.')) {
    const parsed = parseRuntimeOptionPath(path)
    if (!parsed) return false
    const id = normalizeRuntimeId(parsed.runtimeId)
    if (!isKnownRuntimeId(config, id)) return false
    const field = optionFieldFor(config, id, parsed.key)
    if (!field) return false
    if (validateRuntimeOption(field, value)) return false
    setRuntimeOption(config, id, parsed.key, field.kind === 'switch' ? value === 'true' : value)
    return true
  }

  // 插件入口：`ra config set runtime.plugins.my-runtime ./my-runtime`
  // 空值删除条目；通道插件同理走 channels.<id>。
  if (path.startsWith('runtime.plugins.') || path.startsWith('channels.')) {
    const id = path.startsWith('runtime.plugins.')
      ? path.slice('runtime.plugins.'.length).trim()
      : path.slice('channels.'.length).trim()
    if (!id || id.includes('.')) return false
    if (path.startsWith('runtime.plugins.')) setRuntimePlugin(config, id, value)
    else setChannelPlugin(config, id, value)
    return true
  }

  switch (path) {
    case 'feishu.appId':
      config.feishu.appId = value
      return true
    case 'feishu.reaction':
      config.feishu.reaction = value
      return true
    case 'feishu.chats': {
      // 逗号分隔的 chat_id 列表；已有条目的 mode/绑定保留，新条目默认 all
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
    case 'policy.interruptedRecovery': {
      if (!INTERRUPTED_RECOVERY_MODES.includes(value)) return false
      config.policy.interruptedRecovery = value as InterruptedRecoveryMode
      return true
    }
    case 'policy.maxAutoRecover': {
      const v = int(0, 100)
      if (v === null) return false
      config.policy.maxAutoRecover = v
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
    case 'workspace.enabled': {
      const v = bool()
      if (v === null) return false
      config.workspace.enabled = v
      return true
    }
    case 'workspace.keepHours': {
      const v = int(0, 24 * 365)
      if (v === null) return false
      config.workspace.keepHours = v
      return true
    }
    case 'workspace.sweepMinutes': {
      const v = int(1, 24 * 60)
      if (v === null) return false
      config.workspace.sweepMinutes = v
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
    case 'worker.evidence.ui':
      if (!UI_EVIDENCE_MODES.includes(value as UiEvidenceMode)) return false
      config.worker.evidence.ui = value as UiEvidenceMode
      return true
    case 'worker.skill.mode':
      if (value !== 'path' && value !== 'inline') return false
      config.worker.skill.mode = value
      return true
    case 'reply.ask.mode':
      if (value !== 'callback' && value !== 'text' && value !== 'auto') return false
      config.reply.ask.mode = value
      return true
    case 'reply.ask.allow':
      if (value !== 'anyone' && value !== 'requester') return false
      config.reply.ask.allow = value
      return true
    case 'reply.ask.timeoutMs': {
      const v = int(60_000, 24 * 60 * 60_000)
      if (v === null) return false
      config.reply.ask.timeoutMs = v
      return true
    }
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
    case 'runtime.default': {
      const id = normalizeRuntimeId(value)
      if (!isKnownRuntimeId(config, id)) return false
      config.runtime.default = id
      return true
    }
    case 'llm.baseUrl':
    case 'llm.apiKey':
    case 'llm.model': {
      const key = path.split('.')[1] as 'baseUrl' | 'apiKey' | 'model'
      config.llm = { ...(config.llm ?? {}), [key]: value }
      return true
    }
    case 'llm.api': {
      if (!(LLM_APIS as readonly string[]).includes(value)) return false
      config.llm = { ...(config.llm ?? {}), api: value as LlmApi }
      return true
    }
    case 'llm.authHeader': {
      const v = bool()
      if (v === null) return false
      config.llm = { ...(config.llm ?? {}), authHeader: v }
      return true
    }
    case 'llm.contextWindow': {
      const n = int(1_000, 10_000_000)
      if (n === null) return false
      config.llm = { ...(config.llm ?? {}), contextWindow: n }
      return true
    }
    default:
      return false
  }
}
