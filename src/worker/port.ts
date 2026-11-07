import type { Assignment, InputKind, Ticket } from '../core/model.js'

export interface WorkerContext {
  ticket: Ticket
  assignment: Assignment
  /** 该 worker 的隔离目录（worktree 路径）。 */
  workdir: string
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

/** Router 主动巡检时读到的终端尾部输出。只用于给人看的进展摘录，不参与状态判定。 */
export interface TerminalOutput {
  /** Orca 对终端进程的判定：running / exited / unknown。 */
  status: 'running' | 'exited' | 'unknown'
  /** 渲染屏幕的尾部行（已去 ANSI）；可能包含 TUI 装饰，由调用方清洗。 */
  lines: string[]
  /** Orca 返回的数据来源：screen / stream。 */
  source?: string
}

/** Agent 会话记录里的一条活动（assistant 文本或工具调用）。 */
export interface SessionEvent {
  at: string
  kind: 'text' | 'tool'
  text: string
  /** 工具调用的结构化描述（仅 kind=tool 且后端能提供时）；用于生成语义摘要，不展示原始命令。 */
  tool?: { name: string; target?: string }
}

/** 从 Agent 自己的会话记录里读出的最近活动；比终端屏幕更干净、可结构化。 */
export interface SessionSnapshot {
  /** 最近一条会话活动的时间（ISO）。 */
  at: string
  events: SessionEvent[]
  sessionId?: string
  filePath?: string
}

/** Worker 后端端口：换后端只加一个 adapter，内核与 Router 不改。 */
export interface WorkerBackend {
  readonly id: string
  start(ctx: WorkerContext): Promise<{ handle: string; workdir?: string }>
  deliver(handle: string, inputs: InboundMessage[]): Promise<void>
  registerContext(handle: string, items: ContextItem[]): Promise<void>
  stop(handle: string, reason: string): Promise<void>
  /** 可选：读取终端尾部输出，供 Router 主动巡检 worker 进展；不实现则跳过巡检。 */
  read?(handle: string, opts?: { limit?: number }): Promise<TerminalOutput | null>
  /** 可选：读取 Agent 自己的会话记录（优先于终端屏幕）；不实现则退回 read。 */
  session?(workdir: string, opts?: { maxBytes?: number; maxEvents?: number }): Promise<SessionSnapshot | null>
}
