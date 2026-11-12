/**
 * 面板「批量清理工作区」的中立视图与端口。
 *
 * 这里只放纯类型与纯函数，不能依赖任何 Node 内置模块 —— Web 面板会把它打进前端包。
 * 服务层负责扫磁盘、按运行时分组；HTTP 层只透传这些结构。
 */
import type { Stage } from '#core/model.js'
import { ACP_AGENTS } from '../runtimes/acp/agents.js'
import { WORKER_RUNTIMES, normalizeRuntimeId } from '../runtimes/catalog.js'

/** 一个仍在磁盘上的工单工作区。 */
export interface WorkspaceEntryView {
  assignmentId: string
  ticketId: string
  title: string
  stage: Stage
  runtimeId: string
  workdir: string
  startedAt: string
  /** 工单关闭时间（ISO）；未关闭为空串。定时任务用它算保留期。 */
  closedAt: string
  /** 仅「工单已关闭 + 目录仍存在 + 当前运行时可回收」时为 true。 */
  cleanable: boolean
  /** 不可清理的原因；cleanable=true 时为空。 */
  reason?: string
}

/** 按运行时聚合的工作区清单。 */
export interface WorkspaceRuntimeGroupView {
  runtimeId: string
  /** 面板展示用短名，例如 orca / claude-code / Claude Code (ACP)。 */
  label: string
  isDefault: boolean
  /** 当前服务是否注册了该运行时且支持回收。 */
  supported: boolean
  entries: WorkspaceEntryView[]
  cleanableCount: number
}

export interface WorkspaceOverviewView {
  runtimes: WorkspaceRuntimeGroupView[]
  /** 全部可清理的工作区数量。 */
  cleanableCount: number
}

export interface WorkspaceRemovalView {
  ticketId: string
  workdir: string
}

export interface WorkspaceSkipView extends WorkspaceRemovalView {
  reason: string
}

export interface WorkspaceCleanupResultView {
  removed: WorkspaceRemovalView[]
  skipped: WorkspaceSkipView[]
}

/** 面板勾选后提交的清理请求：优先按工单；只传 runtimeId 时清理该运行时下全部可清理项。 */
export interface WorkspaceCleanupRequest {
  ticketIds?: string[]
  runtimeId?: string
}

/** HTTP API 依赖的面板端口；由 RouterService 实现。 */
export interface WorkspaceAdminPort {
  list(): Promise<WorkspaceOverviewView>
  /**
   * 按工单逐个清理：每个工单由它自己的运行时决定怎么回收
   * （Orca 关 worktree、Claude Code 删 agent view、ACP 直接删 worktree）。
   */
  cleanup(request: WorkspaceCleanupRequest): Promise<WorkspaceCleanupResultView>
}

/** 运行时短名：目录里的长 label（`orca · Orca worktree + 终端`）只取第一段。 */
export function workspaceRuntimeLabel(runtimeId: string): string {
  const id = normalizeRuntimeId(runtimeId)
  const builtin = WORKER_RUNTIMES.find(runtime => runtime.id === id)
  if (builtin) return builtin.label.split(' · ')[0]?.trim() || id
  const agent = ACP_AGENTS.find(item => item.runtimeId === id)
  return agent?.label ?? id
}