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

/** Worker 后端端口：换后端只加一个 adapter，内核与 Router 不改。 */
export interface WorkerBackend {
  readonly id: string
  start(ctx: WorkerContext): Promise<{ handle: string; workdir?: string }>
  deliver(handle: string, inputs: InboundMessage[]): Promise<void>
  registerContext(handle: string, items: ContextItem[]): Promise<void>
  stop(handle: string, reason: string): Promise<void>
}
