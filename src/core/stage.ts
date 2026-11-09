import type { Assignment, Report, Stage, Ticket } from './model.js'

export interface StageInput {
  ticket: Ticket
  assignment?: Assignment | null
  latestReport?: Report | null
  /** 是否存在等待人工回答的问题。 */
  hasAttention?: boolean
}

/**
 * 五种工单阶段的展示顺序与中文名。
 * 顺序即看板列顺序，也用于 CLI / 提示文案。
 */
export const STAGE_VALUES: readonly Stage[] = ['todo', 'running', 'review', 'blocked', 'done']

export const STAGE_LABELS: Record<Stage, string> = {
  todo: '待办',
  running: '进行中',
  review: '审核中',
  blocked: '已阻塞',
  done: '已完成',
}

/**
 * 旧八阶段 → 新五阶段的映射。
 * 同时用于两处：历史库读时兼容（不写库），以及 scripts/migrate-ticket-stages.mjs 的迁移。
 * 注意：旧 `draft` / `accepted` 都并回「待办」，旧 `idle` 因为需要人工推动也并入「已阻塞」。
 */
export const LEGACY_STAGE_MAP: Readonly<Record<string, Stage>> = {
  draft: 'todo',
  accepted: 'todo',
  assigned: 'running',
  running: 'running',
  review: 'review',
  person: 'blocked',
  idle: 'blocked',
  closed: 'done',
}

export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGE_VALUES as readonly string[]).includes(value)
}

/** 把库里的阶段值归一化到新五阶段；未知值返回 null，交给调用方决定兜底。 */
export function normalizeStage(value: unknown): Stage | null {
  if (isStage(value)) return value
  if (typeof value === 'string') return LEGACY_STAGE_MAP[value] ?? null
  return null
}

/** 按新阶段查询时，需要一并匹配的旧阶段值（迁移执行前也能查全）。 */
export function stageAliases(stage: Stage): string[] {
  const aliases = Object.entries(LEGACY_STAGE_MAP)
    .filter(([, mapped]) => mapped === stage)
    .map(([legacy]) => legacy)
  return [...new Set([stage, ...aliases])]
}

/**
 * 由「工单 + 派工 + 最新报告」推导阶段。
 * 自上而下判断，第一条命中的规则生效。
 */
export function computeStage(input: StageInput): Stage {
  const { ticket, assignment, latestReport, hasAttention } = input

  if (ticket.closedAt) return 'done'
  if (hasAttention) return 'blocked'
  if (latestReport?.state === 'ready') return 'review'
  if (latestReport?.state === 'blocked' || latestReport?.state === 'failed') return 'blocked'
  if (!assignment) return 'todo'
  // 已派工（pending 或 running）都算「进行中」：对发起人来说工作已经开始了。
  if (assignment.status === 'pending') return 'running'
  // 派工已结束但工单没闭环、worker 明确 waiting/dropped：都需要人来推动。
  if (assignment.status === 'ended') return 'blocked'
  if (latestReport?.state === 'waiting' || latestReport?.state === 'dropped') return 'blocked'
  return 'running'
}

const TRANSITIONS: Record<Stage, Stage[]> = {
  todo: ['running', 'review', 'blocked', 'done'],
  running: ['todo', 'review', 'blocked', 'done'],
  review: ['todo', 'running', 'blocked', 'done'],
  blocked: ['todo', 'running', 'review', 'done'],
  done: [],
}

/**
 * 阶段迁移是否合法。
 * 收敛到五种后不再表达细分流程：除「已完成」外，四个活跃阶段之间都可以互转；
 * 「已完成」是终态，符合 PR 合并/关单后不可切回的既有约束。
 */
export function canTransition(from: Stage, to: Stage): boolean {
  if (from === to) return true
  return TRANSITIONS[from].includes(to)
}
