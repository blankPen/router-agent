/**
 * 远端运行时：把一次派工转成给目标设备的消息。
 *
 * 它实现的是标准 WorkerRuntime 端口，所以 Router 的派工、追问、停止流程
 * 不用为多设备改一套；差异只在「仓库路径由设备自己解析」。
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import {
  WorkerRuntimeError,
  type ActivityQuery,
  type AgentOutput,
  type AgentStatus,
  type DeliveryReceipt,
  type InboundMessage,
  type RuntimeCapabilities,
  type SessionSnapshot,
  type StartResult,
  type WorkerContext,
  type WorkerRef,
  type WorkerRuntime,
  type WorkspaceInfo,
  type WorkspaceRef,
} from '#runtime/port.js'
import { nodeRuntimeId, type NodeAttachment, type NodeTask } from '#core/node.js'
import type { CenterNodeLink } from './link.js'

/** 单张附件与单次任务的体积上限：超过就不带过去，别把链路压垮。 */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const MAX_ATTACHMENTS_BYTES = 10 * 1024 * 1024

export interface RemoteRuntimeOptions {
  nodeId: string
  /** 把消息投给节点。 */
  link: CenterNodeLink
  /** 节点当前是否在线；离线时直接失败，别让工单静默排队。 */
  isOnline: (nodeId: string) => boolean
}

export class RemoteWorkerRuntime implements WorkerRuntime {
  readonly id: string
  readonly capabilities: RuntimeCapabilities = {
    agent: { liveStatus: false, processExit: false, output: false, activity: false, structuredInput: true, nudge: false },
    workspace: { cleanup: false, prLink: false, discovery: false },
  }

  private readonly nodeId: string
  private readonly link: CenterNodeLink
  private readonly isOnline: (nodeId: string) => boolean

  constructor(opts: RemoteRuntimeOptions) {
    this.nodeId = opts.nodeId
    this.id = nodeRuntimeId(opts.nodeId)
    this.link = opts.link
    this.isOnline = opts.isOnline
  }

  async start(ctx: WorkerContext): Promise<StartResult> {
    if (!this.isOnline(this.nodeId)) {
      throw new WorkerRuntimeError('runtime:unavailable', `目标设备 ${this.nodeId} 当前离线，无法派工`)
    }
    const task = buildTask(ctx)
    try {
      await this.link.deliver(this.nodeId, { kind: 'task', payload: task })
    } catch (error) {
      throw new WorkerRuntimeError('runtime:unavailable', `派工到设备 ${this.nodeId} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    // 工作目录在设备本机，中心不知道也不需要知道。
    return { handle: ctx.assignment.id, workdir: '' }
  }

  async deliver(ref: WorkerRef, inputs: InboundMessage[]): Promise<DeliveryReceipt> {
    if (inputs.length === 0) return { status: 'accepted', inputIds: [] }
    await this.link.deliver(this.nodeId, {
      kind: 'delivery',
      payload: {
        ticketId: ref.ticketId,
        assignmentId: ref.handle,
        inputs: inputs.map(input => ({ id: input.id, kind: input.kind, text: input.text })),
      },
    })
    return { status: 'accepted', inputIds: inputs.map(input => input.id) }
  }

  async stop(ref: WorkerRef, reason: string): Promise<void> {
    await this.link.deliver(this.nodeId, { kind: 'stop', payload: { ticketId: ref.ticketId, reason } })
  }

  async status(): Promise<AgentStatus | null> {
    return null
  }

  async output(): Promise<AgentOutput | null> {
    return null
  }

  async activity(_query: ActivityQuery): Promise<SessionSnapshot | null> {
    return null
  }

  async inspectWorkspace(_ref: WorkspaceRef): Promise<WorkspaceInfo | null> {
    return null
  }
}

/** 把工单上下文折算成节点任务；仓库定位原样带过去，由设备自己解析成本地路径。 */
function buildTask(ctx: WorkerContext): NodeTask {
  const ticket = ctx.ticket
  const attachments = attachmentsOf(ticket.attachments ?? [])
  return {
    assignmentId: ctx.assignment.id,
    ticketId: ticket.id,
    title: ticket.title,
    scope: ctx.brief?.scope ?? ticket.title,
    ...(ticket.request ? { request: ticket.request } : {}),
    ...(ticket.requestActorName ? { requestActorName: ticket.requestActorName } : {}),
    ...(ticket.requestAt ? { requestAt: ticket.requestAt } : {}),
    project: ticket.repo,
    branch: ticket.branch,
    workBranch: ctx.brief?.workBranch ?? `ra/${ticket.id}`,
    ...(attachments.length > 0 ? { attachments } : {}),
  }
}

/** 读中心本机落盘的附件并编码；读不到或超限就跳过，不让派工整体失败。 */
function attachmentsOf(attachments: Array<{ path: string; mimeType: string }>): NodeAttachment[] {
  const result: NodeAttachment[] = []
  let total = 0
  for (const attachment of attachments) {
    try {
      const buffer = readFileSync(attachment.path)
      if (buffer.byteLength > MAX_ATTACHMENT_BYTES) continue
      if (total + buffer.byteLength > MAX_ATTACHMENTS_BYTES) break
      total += buffer.byteLength
      result.push({
        name: basename(attachment.path),
        mimeType: attachment.mimeType,
        content: buffer.toString('base64'),
      })
    } catch {
      // 附件读不到就跳过：worker 少一张图好过整个工单派不出去。
    }
  }
  return result
}
