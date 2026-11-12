/** 领域内核的实体与取值定义。所有模块共用这里的词汇。 */

/** Router 对一个 Trigger 的四种决定。 */
export type Decision = 'accept' | 'stop' | 'ignore' | 'unavailable'

/** 决定的依据强度：显式（@bot / 直接指派）或推断（LLM 研判）。 */
export type Strength = 'explicit' | 'inferred'

/** 工单阶段（五种）：待办 / 进行中 / 审核中 / 已阻塞 / 已完成。 */
export type Stage = 'todo' | 'running' | 'review' | 'blocked' | 'done'

/** Worker 上报的六种状态。 */
export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'

/** Source 种类。一期只有飞书与 GitHub PR 跟踪。 */
export type SourceKind = 'feishu' | 'github'

/** 一条消息的寻址方式。 */
export type AddressMode = 'mention' | 'direct' | 'none'

export type TriggerDisposition = 'pending' | 'evaluating' | 'filtered' | 'evaluated' | 'fanned_out' | 'owned'

/**
 * Router 落盘到本机的原始附件。
 * 目前只有飞书图片；派工/追问时把本地路径透传给 Worker，让它直接看原图。
 */
export interface Attachment {
  /** Router 本机绝对路径。 */
  path: string
  /** image/png、image/jpeg 等，供 Worker 判断文件类型。 */
  mimeType: string
  /** 是否来自被引用的消息。 */
  quoted?: boolean
}

export interface Trigger {
  id: string
  source: SourceKind
  /**
   * 通道实例 ID（一期固定 feishu）。
   * 历史数据没有该字段时按 DEFAULT_CHANNEL_ID 兜底，见 channels/port.ts。
   */
  channelId?: string
  /** Source 自己的事件 ID，用于幂等。 */
  externalId: string
  threadId: string
  /**
   * 这条消息携带的全部外部线程标识：话题 ID（omt_）、根消息 ID（om_）、消息自身 ID。
   * 飞书在不同客户端入口给不全字段（话题面板直发只有 thread_id），
   * Store 靠这组别名把同一话题的消息解析到同一个 Thread。见 Store.resolveThread。
   */
  threadKeys?: string[]
  /** 飞书 chat_id 或 GitHub owner/repo#number。 */
  chatId: string
  chatName: string
  actorId: string
  actorName: string
  isBot: boolean
  text: string
  addressed: AddressMode
  /** 纯附件消息（图片 / 文件 / 语音等）：正文只是占位文本，不能据此开工。 */
  mediaOnly?: boolean
  receivedAt: string
  disposition: TriggerDisposition
  decisionId?: string
  /** Source 原始载荷，便于审计与回放。 */
  raw?: unknown
}

export interface Thread {
  id: string
  source: SourceKind
  rootId: string
  chatId: string
  createdAt: string
}

export interface Mandate {
  id: string
  ticketId: string
  policyVersion: string
  strength: Strength
  /** 授权范围：一句话说明这份工作允许做什么。 */
  scope: string
  /** 研判命中的策略规则名。 */
  rules: string[]
  actorId: string
  actorName: string
  source: SourceKind
  chatId: string
  threadId: string
  createdAt: string
}

export interface Ticket {
  id: string
  title: string
  threadId: string
  source: SourceKind
  chatId: string
  mandateId: string
  stage: Stage
  /** 派工目标仓库（Orca repo 选择器或项目名）；开单时必须明确。 */
  repo: string
  /** 派工起始分支（worktree 的 base branch）；开单时必须明确。 */
  branch: string
  /** 开单消息里随附的原始附件（Router 已落盘），派工时透传给 Worker。 */
  attachments?: Attachment[]
  prNumber: number
  prUrl: string
  prState: 'none' | 'open' | 'merged' | 'closed'
  createdAt: string
  updatedAt: string
  closedAt?: string
}

/**
 * 一次尚未凑齐派工信息的对话草稿。
 * Router 判断该开工但缺 repo / branch 时先落这里，等用户补齐后再开单。
 */
export interface DispatchDraft {
  chatId: string
  threadId: string
  actorId: string
  /** 原始工作请求（多轮补齐时保持不变）。 */
  task: string
  repo: string
  branch: string
  updatedAt: string
}

export interface Assignment {
  id: string
  ticketId: string
  runtimeId: string
  handle: string
  workdir: string
  status: 'pending' | 'running' | 'ended'
  startedAt: string
  endedAt?: string
}

export type InputKind = 'followup' | 'ci' | 'policy' | 'retry'

export interface Input {
  id: string
  ticketId: string
  assignmentId: string
  seq: number
  kind: InputKind
  text: string
  /** expired：worker 在 ack 前就没了；不再重投，也不代表用户请求被完成。 */
  status: 'pending' | 'delivered' | 'acked' | 'expired'
  createdAt: string
  deliveredAt?: string
  ackedAt?: string
}

export interface Report {
  id: string
  ticketId: string
  assignmentId: string
  turn: number
  state: ReportState
  summary: string
  humanAction?: string
  prNumber?: number
  prUrl?: string
  /** Worker 要发给发起人的完整回复（Markdown）。里面可以有文档链接、PR 链接，Router 原样发送。 */
  reply?: string
  ackedInputs: string[]
  at: string
}

export interface Subscription {
  threadId: string
  ticketId: string
  /** 只提供上下文、不授予权限的订阅。 */
  contextOnly: boolean
  createdAt: string
}

export interface DecisionRecord {
  id: string
  triggerId: string
  threadId: string
  decision: Decision
  strength: Strength
  reason: string
  policyVersion: string
  /** observe 模式下「本该接单」的标记。 */
  wouldAccept: boolean
  createdAt: string
}

export interface Channel {
  kind: 'feishu' | 'github'
  chatId: string
  /** 飞书 thread / 根消息 ID，用于话题回复。 */
  threadId?: string
}
