/**
 * 多设备节点的跨端协议。
 *
 * 中心 Router 与远端设备之间只传这几种消息，两侧都不依赖对方的实现：
 * 直连（同一内网 / Tailscale）与公网中继只是换了承载消息的通道。
 */

/** 节点本机的一个项目：逻辑名 + 本地仓库绝对路径。 */
export interface NodeProject {
  /** 逻辑项目名；中心 Router 按它把任务指向具体项目。 */
  name: string
  /** 节点本机的仓库绝对路径。 */
  path: string
}

/** 节点注册时上报的自身信息。 */
export interface NodeRegistration {
  nodeId: string
  /** 显示名；缺省用 nodeId。 */
  name: string
  /** 节点本机可用的运行时 id（claude-code / orca / ...）。 */
  runtimes: string[]
  /** 节点本机的项目清单。 */
  projects: NodeProject[]
}

/** 中心转给节点的一张附件：中心本机落盘的原图。 */
export interface NodeAttachment {
  /** 中心侧的文件名；节点用它决定落盘名。 */
  name: string
  mimeType: string
  /** 文件内容的 base64；节点解码后写到自己的 worker 目录。 */
  content: string
}

/** 中心派给节点的一次执行任务。 */
export interface NodeTask {
  assignmentId: string
  ticketId: string
  title: string
  /** 授权范围（研判结论里的 scope）。 */
  scope: string
  /** 用户原话全文；节点侧据此生成 request.md。 */
  request?: string
  requestActorName?: string
  requestAt?: string
  /** 项目标识：节点用它在自己的项目表里查本地绝对路径。 */
  project: string
  /** 起始分支。 */
  branch: string
  /** 工作分支名。 */
  workBranch: string
  /** 中心本机落盘的附件，随任务带给节点。 */
  attachments?: NodeAttachment[]
}

/** 中心投递给节点的后续输入（用户在飞书里的追问、CI 结果等）。 */
export interface NodeDelivery {
  ticketId: string
  assignmentId: string
  inputs: Array<{ id: string; kind: 'followup' | 'ci' | 'policy' | 'retry'; text: string }>
}

/** 节点回传给中心的 worker 上报；字段与本地 `/api/reports` 一致。 */
export interface NodeReport {
  ticketId: string
  assignmentId?: string
  turn?: number
  state: string
  summary: string
  humanAction?: string
  prNumber?: number
  prUrl?: string
  uiChange?: boolean
  reply?: string
  replyPayload?: unknown
  ackedInputs?: string[]
  updatedAt?: string
}

/** 节点 → 中心的消息。 */
export type NodeToCenterMessage =
  | { kind: 'register'; payload: NodeRegistration }
  | { kind: 'report'; payload: NodeReport }

/** 中心让节点停掉某个工单的 worker。 */
export interface NodeStop {
  ticketId: string
  reason: string
}

/** 中心 → 节点的消息。 */
export type CenterToNodeMessage =
  | { kind: 'task'; payload: NodeTask }
  | { kind: 'delivery'; payload: NodeDelivery }
  | { kind: 'stop'; payload: NodeStop }

/** 节点在线状态视图；面板与 CLI 共用这一份。 */
export interface NodeStatusView {
  nodeId: string
  name: string
  /** 最近心跳是否在有效期内。 */
  online: boolean
  lastSeenAt: string
  /** 节点本机可用的运行时 id。 */
  runtimes: string[]
  /** 节点本机已登记的项目名。 */
  projects: string[]
  /** 该节点当前在执行的工单。 */
  tickets: string[]
  /** 最近一次失败原因；成功心跳后清空。 */
  lastError?: string
}

/** 远端运行时 id：`node:<设备 id>`。 */
export function nodeRuntimeId(nodeId: string): string {
  return `node:${nodeId.trim()}`
}

/** 从远端运行时 id 反解设备 id；不是远端运行时返回空串。 */
export function nodeIdOfRuntime(runtimeId: string): string {
  const value = runtimeId.trim()
  return value.startsWith('node:') ? value.slice('node:'.length) : ''
}
