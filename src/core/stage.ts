import type { Assignment, Report, Stage, Ticket } from './model.js'

export interface StageInput {
  ticket: Ticket
  assignment?: Assignment | null
  latestReport?: Report | null
  /** 是否存在等待人工回答的问题。 */
  hasAttention?: boolean
}

/**
 * 由「工单 + 派工 + 最新报告」推导阶段。
 * 自上而下判断，第一条命中的规则生效。
 */
export function computeStage(input: StageInput): Stage {
  const { ticket, assignment, latestReport, hasAttention } = input

  if (ticket.closedAt) return 'closed'
  if (hasAttention) return 'person'
  if (latestReport?.state === 'ready') return 'review'
  if (latestReport?.state === 'blocked' || latestReport?.state === 'failed') return 'person'
  if (!assignment) return 'accepted'
  if (assignment.status === 'pending') return 'assigned'
  if (assignment.status === 'ended') return 'idle'
  if (latestReport?.state === 'waiting' || latestReport?.state === 'dropped') return 'idle'
  return 'running'
}

const FORWARD: Record<Stage, Stage[]> = {
  draft: ['accepted', 'closed'],
  accepted: ['assigned', 'person', 'idle', 'closed'],
  assigned: ['running', 'person', 'idle', 'closed'],
  running: ['review', 'person', 'idle', 'closed'],
  review: ['closed', 'running', 'person', 'idle'],
  person: ['running', 'idle', 'review', 'closed'],
  idle: ['running', 'person', 'review', 'closed'],
  closed: [],
}

/** 阶段迁移是否合法。closed 是终态；其余状态允许回到 running。 */
export function canTransition(from: Stage, to: Stage): boolean {
  if (from === to) return true
  return FORWARD[from].includes(to)
}
