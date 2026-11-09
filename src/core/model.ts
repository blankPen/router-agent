/** 领域内核的实体与取值定义。所有模块共用这里的词汇。 */

/** Router 对一个 Trigger 的四种决定。 */
export type Decision = 'accept' | 'stop' | 'ignore' | 'unavailable'

/** 决定的依据强度：显式（@bot / 直接指派）或推断（LLM 研判）。 */
export type Strength = 'explicit' | 'inferred'

/** 工单阶段。person 表示等人，idle 表示 worker 空闲但活未完。 */
export type Stage = 'draft' | 'accepted' | 'assigned' | 'running' | 'review' | 'person' | 'idle' | 'closed'

/** Worker 上报的六种状态。 */
export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'

/** Source 种类。一期只有飞书与 GitHub PR 跟踪。 */
export type SourceKind = 'feishu' | 'github'

/** 一条消息的寻址方式。 */
export type AddressMode = 'mention' | 'direct' | 'none'

export type TriggerDisposition = 'pending' | 'evaluating' | 'filtered' | 'evaluated' | 'fanned_out' | 'owned'

export interface Trigger {
  id: string
  source: SourceKind
  /** Source 自己的事件 ID，用于幂等。 */
  externalId: string
  threadId: string
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
  status: 'pending' | 'delivered' | 'acked'
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
