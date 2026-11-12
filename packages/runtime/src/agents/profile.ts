/**
 * Agent 档案：与「谁在跑这个工单」有关的固有知识。
 *
 * 运行时（Orca / Claude Code / ACP …）只决定「在哪跑」，Agent 档案决定
 * 「会话记录在哪、怎么读、人工怎么接回去」。两者解耦后，换 Agent 不需要动内核。
 */
import type { SessionSnapshot } from '../port.js'

export interface AgentSessionReadOptions {
  /** 只读文件尾部这么多字节，避免把大会话全量读进内存。 */
  maxBytes?: number
  /** 最多保留多少条最近活动。 */
  maxEvents?: number
  /** 覆盖 Agent 的会话记录根目录（测试注入）。 */
  root?: string
  /** 精确匹配会话 id；找不到返回 null，不退化成「最新文件」。 */
  sessionId?: string
}

/** Agent 会话记录读取器。 */
export interface AgentSessionReader {
  /** 按 workdir 找到最近一次会话的 id。 */
  latestSessionId(workdir: string, opts?: AgentSessionReadOptions): string | null
  /** 读取该 workdir 最近的活动；读不到返回 null，由调用方退回终端屏幕。 */
  read(workdir: string, opts?: AgentSessionReadOptions): SessionSnapshot | null
}

/** 人工恢复命令模板；`{sessionId}` 会被真实会话 id 替换。 */
export interface AgentResumeTemplate {
  command: string
  args: readonly string[]
  note?: string
}

export interface AgentProfile {
  /** Agent id，与外部工具的 agent id 对齐（例如 orca --agent codex）。 */
  id: string
  label: string
  /** 人工接回会话的命令模板。 */
  resume?: AgentResumeTemplate
  /** 会话记录读取器；没有则活动巡检退回终端屏幕。 */
  session?: AgentSessionReader
}
