import type { Assignment, InputKind, Ticket } from '../core/model.js'

/** 工单执行上下文：Router 负责拼装，运行时只消费。 */
export interface WorkerContext {
  ticket: Ticket
  assignment: Assignment
  /** 预分配目录；为空表示由运行时决定。 */
  workdir: string
  /** 运行时中立的工单契约；Router 正常都会提供，缺省时 adapter 可自行渲染。 */
  brief?: WorkerBrief
  /** 报告文件路径；缺省时由 adapter 按 workersDir 推导。 */
  report?: ReportPaths
  /** 工具策略；缺省时使用内置默认值。 */
  tools?: ToolPolicy
}

/** 运行时中立的任务契约：只讲“做什么/怎么上报”，不讲某个 CLI 的参数。 */
export interface WorkerBrief {
  ticketId: string
  title: string
  scope: string
  workBranch: string
  /** 已渲染的正文（工单、授权范围、交付规则、上报命令）。 */
  contract: string
}

export interface ReportPaths {
  statePath: string
  eventsPath: string
}

/** 中立工具策略；adapter 负责映射到各 CLI 的开关。 */
export interface ToolPolicy {
  fileAccess: 'read-only' | 'read-write'
  /** deny=不给 shell；allowlist=只放行 shellAllow 中的命令前缀；allow=任意 shell。 */
  shell: 'deny' | 'allowlist' | 'allow'
  /** shell=allowlist 时生效，按命令前缀匹配，例如 ['ra report','ra doc','git','gh']。 */
  shellAllow?: string[]
  allowNetwork: boolean
}

export interface InboundMessage {
  /** 输入 id（in_xxx）；投递时原样展示给 worker，用于写进 acked_inputs。 */
  id: string
  kind: InputKind
  text: string
}

export type ContextItem =
  | { kind: 'system-prompt'; text: string }
  | { kind: 'file'; path: string; content: string }
  | { kind: 'env'; key: string; value: string }
  | { kind: 'dir'; path: string }

/** Router 传给运行时的引用：handle 不透明，其余字段让运行时能定位自己的 meta/会话。 */
export interface WorkspaceRequest {
  ticketId: string
  repo: string
  baseBranch: string
  workBranch: string
  name: string
  workdir?: string
}

export interface Workspace {
  workspaceRef: string
  workdir: string
  branch: string
  meta?: Record<string, unknown>
}

/** 内部构件：工作区生命周期。Orca 等运行时可以不严格实现。 */
export interface WorkspaceProvider {
  readonly id: string
  create(req: WorkspaceRequest): Promise<Workspace>
  inspect(ref: string): Promise<WorkspaceInfo | null>
  remove(ref: string, opts?: { force?: boolean }): Promise<void>
  listRepos?(): Promise<RepoDescriptor[]>
}

export interface WorkerRef {
  handle: string
  ticketId: string
  workdir?: string
  /** 运行时自己的会话 ID（Claude/Codex 用；Orca 可空）。 */
  sessionId?: string
}

/** 工作区引用：回收/查询时使用，不依赖 provider 私有选择器语法。 */
export interface WorkspaceRef {
  ticketId: string
  workdir: string
  /** provider 自己的稳定标识；为空时由 workdir 推导。 */
  workspaceRef?: string
}

export interface StartResult {
  handle: string
  workdir: string
  /** 实际工作分支（可能被 provider 加后缀）；供 PR 兜底查询。 */
  branch?: string
  /** 会话 ID；写入 runtime 的 meta.json，供 resume/活动定位。 */
  sessionId?: string
  workspaceRef?: string
}

export interface ActivityQuery {
  ref: WorkerRef
  opts?: { maxBytes?: number; maxEvents?: number }
}

/** 投递回执：Router 据此决定是否重投；accepted 不等于 ack。 */
export type DeliveryReceipt =
  | { status: 'accepted'; inputIds: string[] }
  | { status: 'queued'; inputIds: string[]; reason?: string }
  | { status: 'rejected'; inputIds: string[]; reason: string; retryable?: boolean; retryAfterMs?: number }

export interface DeliverOptions {
  /** 第几次投递（从 1 开始）；同一 attempt 的并发调用必须幂等。 */
  attempt?: number
  /** Router 显式重投：adapter 必须允许同一 input.id 再次进入。 */
  redeliver?: boolean
}

export type AgentPhase = 'starting' | 'running' | 'blocked' | 'exited' | 'lost' | 'unknown'

export interface AgentStatus {
  alive: boolean
  phase: AgentPhase
  acceptingInput: boolean
  /** 最后一次可观测活动时间（ISO）；用于 idle / zombie 判定。 */
  lastActivityAt?: string
  exitCode?: number
  exitSignal?: string
  /** provider 细节；只进日志，不进判断。 */
  detail?: Record<string, unknown>
}

export interface AgentOutput {
  status: 'running' | 'exited' | 'unknown'
  lines: string[]
  source?: string
}

/**
 * 被中断的一轮执行。
 *
 * 运行时重启后用来回答「上一轮做到哪、是不是被中途打断的」。
 * 只有进程会随 Router 一起死的运行时（capabilities.agent.processExit=true）
 * 才有这个概念；常驻 worker 不会因为 Router 重启而中断，不需要实现。
 */
export interface InterruptedTurn {
 /** 运行时自己的轮次 id；用于去重，保证同一轮只提醒一次。 */
 turnId: string
 /** 已执行到哪一步的简要描述；用来生成有意义的恢复提示。 */
 summary?: string
 /** 中断发生时间（ISO），尽力而为。 */
 at?: string
}

/** 兼容旧命名。 */
export type TerminalOutput = AgentOutput

/** Agent 会话记录里的一条活动（assistant 文本或工具调用）。 */
export interface SessionEvent {
  at: string
  kind: 'text' | 'tool'
  text: string
  tool?: { name: string; target?: string }
}

/** 从 Agent 自己的会话记录里读出的最近活动。 */
export interface SessionSnapshot {
  at: string
  events: SessionEvent[]
  sessionId?: string
  filePath?: string
}

/** 人工接管会话时可直接粘贴到终端的恢复提示。 */
export interface ResumeHint {
  /** 完整 shell 命令，已包含 cd 到工作目录。 */
  command: string
  /** 运行时自己的会话 ID；用于展示与排障。 */
  sessionId?: string
  /** 不阻断复制，但需要提示用户的注意事项。 */
  note?: string
}

export interface RuntimeCapabilities {
  agent: {
    liveStatus: boolean
    processExit: boolean
    output: boolean
    activity: boolean
    structuredInput: boolean
    nudge: boolean
  }
  workspace: {
    cleanup: boolean
    prLink: boolean
    discovery: boolean
  }
}

export interface RepoDescriptor {
  name: string
  path: string
  kind?: string
}

export interface WorkspaceInfo {
  workdir: string
  branch: string
  dirty?: boolean
  linkedPr?: { number: number; url: string; state?: 'open' | 'merged' | 'closed' }
}

export interface DiagnosticCheck {
  name: string
  status: 'ok' | 'warn' | 'fail'
  detail: string
  hint?: string
}

/** 运行时错误码；所有 adapter 必须抛 WorkerRuntimeError。 */
export type WorkerErrorCode =
  | 'workspace:create-failed'
  | 'workspace:missing-repo'
  | 'workspace:missing-branch'
  | 'workspace:remove-failed'
  | 'agent:launch-failed'
  | 'agent:not-accepting-input'
  | 'agent:gone'
  | 'agent:timeout'
  | 'runtime:unavailable'
  | 'runtime:unknown'

export class WorkerRuntimeError extends Error {
  readonly code: WorkerErrorCode
  readonly retryable: boolean
  readonly reason: string
  override readonly cause?: string
  readonly detail?: Record<string, unknown>

  constructor(
    code: WorkerErrorCode,
    reason: string,
    opts: { retryable?: boolean; cause?: string; detail?: Record<string, unknown> } = {},
  ) {
    super(reason)
    this.name = 'WorkerRuntimeError'
    this.code = code
    this.reason = reason
    this.retryable = opts.retryable ?? false
    this.cause = opts.cause
    this.detail = opts.detail
  }
}

/** Worker 运行时端口：换运行时只加一个 adapter，内核与 Router 不改。 */
export interface WorkerRuntime {
  readonly id: string
  readonly capabilities: RuntimeCapabilities

  start(ctx: WorkerContext): Promise<StartResult>
  deliver(ref: WorkerRef, inputs: InboundMessage[], opts?: DeliverOptions): Promise<DeliveryReceipt>
  stop(ref: WorkerRef, reason: string): Promise<void>

  /** 可选：显式唤醒/探活；只有 capabilities.agent.nudge=true 时才实现。 */
  nudge?(ref: WorkerRef): Promise<void>
  /** 可选：进程重启后把仍可恢复的会话接回来；接不回返回 false，不算丢失。 */
  reattach?(ref: WorkerRef): Promise<boolean>
  /**
   * 可选：查询上一轮是否被中途打断。
   *
   * 只有 worker 进程会随 Router 一起死的运行时（capabilities.agent.processExit=true）
   * 才需要实现：这类运行时重启后「上一轮」确实可能停在半路。
   * 返回 null 表示「没有被打断的轮次」或「判断不了」，不触发任何恢复动作。
   */
  interruptedTurn?(ref: WorkerRef): Promise<InterruptedTurn | null>
  /** 可选：结构化活性；返回 null 表示「无法判断」，不是「已丢失」。 */
  status?(ref: WorkerRef): Promise<AgentStatus | null>
  /** 可选：输出尾部；没有则巡检跳过这一路。 */
  output?(ref: WorkerRef, opts?: { limit?: number }): Promise<AgentOutput | null>
  /** 可选：结构化活动；优先于 output。 */
  activity?(query: ActivityQuery): Promise<SessionSnapshot | null>

  /** 可选：工作区查询/回收；不再使用运行时私有选择器。 */
  inspectWorkspace?(ref: WorkspaceRef): Promise<WorkspaceInfo | null>
  removeWorkspace?(ref: WorkspaceRef): Promise<void>
  /** 可选：仓库发现（doctor / init）。 */
  listRepos?(): Promise<RepoDescriptor[]>
  /** 可选：把本地仓库路径解析成 GitHub owner/repo，供 PR 跟踪。 */
  repoSlug?(ref: WorkerRef): Promise<string | null>
  /** 可选：启动前自检。 */
  doctor?(): Promise<DiagnosticCheck[]>
  /** 兼容保留：当前 Router 未调用。 */
  registerContext?(ref: WorkerRef, items: ContextItem[]): Promise<void>
}
