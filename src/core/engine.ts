import type { Store } from '../store/db.js'
import { attachmentsOf, withAttachmentManifest } from './attachments.js'
import { negotiateAcceptance, type Policy, type Acceptance } from '#core/policy.js'
import { computeStage } from '#core/stage.js'
import { noopSink, preview, type EventSink } from '#core/events.js'
import type {
  Assignment,
  Decision,
  DecisionRecord,
  Input,
  InputKind,
  Mandate,
  Report,
  ReportState,
  Stage,
  Strength,
  Ticket,
  Trigger,
} from '#core/model.js'

export interface Clock {
  now(): string
}

/**
 * 输入去重窗口：同工单内 kind + 文本完全相同、且还在 pending/delivered 时，
 * 这段时间内只保留第一条。跨来源重复（飞书消息 + 面板补录）靠它兜住。
 */
export const INPUT_DEDUP_WINDOW_MS = 120_000

export interface IdGen {
  next(prefix: string): string
}

export interface EngineDeps {
  store: Store
  policy: Policy
  clock?: Clock
  ids?: IdGen
  /** 结构化事件出口，用于把状态变化写进日志。 */
  onEvent?: EventSink
}

export interface DecideInput {
  triggerId: string
  decision: Decision
  strength: Strength
  reason: string
  title?: string
  scope?: string
  /**
   * 发起人原始请求正文。
   *
   * 默认取触发消息的正文；需求识别（intake）终审时传的是提出人的原话，
   * 而不是管理员点「确认派单」的那句话。
   */
  request?: string
  requestActorName?: string
  rules?: string[]
  /** 派工目标仓库；accept 时由 Router 解析后传入。 */
  repo?: string
  /** 派工起始分支。 */
  branch?: string
  /**
   * 工单归属人（可选）。
   *
   * 默认归属触发消息的人；需求识别终审时归属提出人——管理员只是代为确认，
   * 工单该算在提出人名下。
   */
  owner?: { actorId: string; actorName: string }
}

export interface DecideOutcome {
  decision: DecisionRecord
  acceptance: Acceptance
  ticket?: Ticket
  mandate?: Mandate
}

export interface WorkerState {
  ticketId: string
  turn: number
  state: ReportState
  summary: string
  humanAction?: string
  prNumber?: number
  prUrl?: string
  reply?: string
  ackedInputs: string[]
}

const defaultClock: Clock = { now: () => new Date().toISOString() }
const defaultIds: IdGen = { next: prefix => `${prefix}_${crypto.randomUUID()}` }

/**
 * 领域内核的唯一状态写入口。
 * Router、Worker、面板都不直接写 SQLite，全部经由这里。
 */
export class Engine {
  readonly store: Store
  private clock: Clock
  private ids: IdGen
  private currentPolicy: Policy
  private onEvent: EventSink

  constructor(deps: EngineDeps) {
    this.store = deps.store
    this.clock = deps.clock ?? defaultClock
    this.ids = deps.ids ?? defaultIds
    this.currentPolicy = deps.policy
    this.onEvent = deps.onEvent ?? noopSink
    if (!this.store.getPolicy()) this.store.setPolicy(deps.policy)
  }

  policy(): Policy {
    return this.currentPolicy
  }

  updatePolicy(policy: Policy): Policy {
    this.currentPolicy = policy
    this.store.setPolicy(policy)
    return policy
  }

  /** 幂等写入一条 Trigger；重复的 Source 事件不会入库。 */
  ingest(trigger: Trigger): boolean {
    // 线程归属统一走别名解析：话题 ID / 根消息 ID / 消息自身 ID 任一到场都能落回同一个 Thread。
    const resolved = this.store.resolveThread({
      source: trigger.source,
      ...(trigger.channelId ? { channelId: trigger.channelId } : {}),
      chatId: trigger.chatId,
      keys: threadKeysOf(trigger),
      canonicalId: trigger.threadId,
      createdAt: trigger.receivedAt,
    })
    if (resolved.created) {
      this.onEvent({ event: 'thread:created', threadId: resolved.threadId, source: trigger.source, chat: trigger.chatId })
    } else if (resolved.threadId !== trigger.threadId) {
      // 关键排查点：消息自带的线程标识没对上，靠别名收敛到了已有线程。
      this.onEvent({
        event: 'thread:resolved',
        threadId: resolved.threadId,
        rawThreadId: trigger.threadId,
        triggerId: trigger.id,
        source: trigger.source,
      })
    }
    const stored = resolved.threadId === trigger.threadId ? trigger : { ...trigger, threadId: resolved.threadId }
    return this.store.insertTrigger(stored)
  }

  /** 记录一个 Decision；accept 时同时创建 Mandate 与 Ticket。 */
  decide(input: DecideInput): DecideOutcome {
    const trigger = this.store.getTrigger(input.triggerId)
    if (!trigger) throw new Error('trigger:not-found')

    const acceptance = negotiateAcceptance(input.decision, input.strength, this.currentPolicy.acceptMode)
    const now = this.clock.now()

    const record: DecisionRecord = {
      id: this.ids.next('dec'),
      triggerId: trigger.id,
      threadId: trigger.threadId,
      decision: acceptance.decision,
      strength: input.strength,
      reason: input.reason,
      policyVersion: this.currentPolicy.version,
      wouldAccept: acceptance.wouldAccept,
      createdAt: now,
    }
    this.store.insertDecision(record)
    this.store.setTriggerDisposition(trigger.id, 'evaluated', record.id)

    if (acceptance.decision !== 'accept') {
      this.onEvent({
        event: 'router:decision',
        triggerId: trigger.id,
        decision: record.decision,
        strength: record.strength,
        wouldAccept: record.wouldAccept,
        reason: preview(input.reason),
        text: preview(trigger.text, 120),
      })
      return { decision: record, acceptance }
    }

    const triggerAttachments = attachmentsOf(trigger.raw)
    const requestText = (input.request ?? trigger.text).trim()
    const requestActorName = input.requestActorName ?? trigger.actorName
    const ticket: Ticket = {
      id: formatTicketId(this.store.nextTicketSeq()),
      title: input.title?.trim() || deriveTitle(trigger.text),
      threadId: trigger.threadId,
      source: trigger.source,
      ...(trigger.channelId ? { channelId: trigger.channelId } : {}),
      chatId: trigger.chatId,
      mandateId: this.ids.next('md'),
      stage: 'todo',
      repo: input.repo?.trim() ?? '',
      branch: input.branch?.trim() ?? '',
      ...(triggerAttachments.length > 0 ? { attachments: triggerAttachments } : {}),
      // 用户原话是需求的唯一依据；研判结论是授权范围，两者都要传给 Worker。
      ...(requestText.trim() ? { request: requestText } : {}),
      ...(requestActorName ? { requestActorName } : {}),
      requestAt: trigger.receivedAt,
      prNumber: 0,
      prUrl: '',
      prState: 'none',
      createdAt: now,
      updatedAt: now,
    }
    const mandate: Mandate = {
      id: ticket.mandateId,
      ticketId: ticket.id,
      policyVersion: this.currentPolicy.version,
      strength: input.strength,
      scope: input.scope?.trim() || `完成：${ticket.title}`,
      rules: input.rules ?? [],
      actorId: input.owner?.actorId ?? trigger.actorId,
      actorName: input.owner?.actorName ?? trigger.actorName,
      source: trigger.source,
      chatId: trigger.chatId,
      threadId: trigger.threadId,
      createdAt: now,
    }
    this.store.insertMandate(mandate)
    this.store.insertTicket(ticket)
    this.store.subscribe({ threadId: trigger.threadId, ticketId: ticket.id, contextOnly: false, createdAt: now })
    this.onEvent({
      event: 'router:decision',
      triggerId: trigger.id,
      decision: record.decision,
      strength: record.strength,
      wouldAccept: record.wouldAccept,
      reason: preview(input.reason),
      ticketId: ticket.id,
      title: ticket.title,
      scope: preview(mandate.scope, 120),
      text: preview(trigger.text, 120),
    })
    return { decision: record, acceptance, ticket, mandate }
  }

  startAssignment(ticketId: string, opts: { runtimeId: string; handle: string; workdir: string }): Assignment {
    this.requireTicket(ticketId)
    const now = this.clock.now()
    const assignment: Assignment = {
      id: this.ids.next('as'),
      ticketId,
      runtimeId: opts.runtimeId,
      handle: opts.handle,
      workdir: opts.workdir,
      status: 'pending',
      startedAt: now,
    }
    this.store.insertAssignment(assignment)
    this.store.rebindInputs(ticketId, assignment.id)
    this.refreshStage(ticketId)
    return assignment
  }

  /**
   * 记录 worker 上报，并在同一事务语义内刷新阶段、PR 与待答问题。
   * 返回这次真正被 ack 的输入 id（旧派工下投递、新派工下 ack 的也算）。
   */
  report(assignmentId: string, state: WorkerState): { report: Report; ackedInputs: string[] } {
    const assignment = this.store.getAssignment(assignmentId)
    if (!assignment) throw new Error('assignment:not-found')
    const ticket = this.requireTicket(assignment.ticketId)
    const now = this.clock.now()

    const report: Report = {
      id: this.ids.next('rp'),
      ticketId: ticket.id,
      assignmentId,
      turn: state.turn,
      state: state.state,
      summary: state.summary,
      ...(state.humanAction ? { humanAction: state.humanAction } : {}),
      ...(state.prNumber && state.prNumber > 0 ? { prNumber: state.prNumber } : {}),
      ...(state.prUrl ? { prUrl: state.prUrl } : {}),
      ...(state.reply ? { reply: state.reply } : {}),
      ackedInputs: state.ackedInputs ?? [],
      at: now,
    }
    this.store.insertReport(report)
    // ack 按 ticket 收敛，不限定 assignment：worker 丢失后换了新派工，旧派工下创建、
    // 但实际被新 worker 消费的输入同样要落成 acked，否则会被无限重投（tk-51）。
    const ackedInputs = this.store.ackInputs(ticket.id, report.ackedInputs, now)
    if (assignment.status === 'pending') {
      this.store.updateAssignment({ ...assignment, status: 'running' })
    }

    let updated: Ticket = ticket
    if (state.prNumber && state.prNumber > 0) {
      updated = { ...updated, prNumber: state.prNumber, prUrl: state.prUrl ?? updated.prUrl, prState: updated.prState === 'none' ? 'open' : updated.prState, updatedAt: now }
    }
    this.store.updateTicket(updated)

    if (state.state === 'blocked' && state.humanAction) this.store.setAttention(ticket.id, state.humanAction, now)
    if (state.state === 'ready' || state.state === 'progress' || state.state === 'waiting') this.store.clearAttention(ticket.id)
    if (state.state === 'ready') {
      this.store.subscribe({ threadId: ticket.threadId, ticketId: ticket.id, contextOnly: false, createdAt: now })
    }

    this.refreshStage(ticket.id)
    return { report, ackedInputs }
  }

  deliverInput(ticketId: string, opts: { kind: InputKind; text: string; assignmentId?: string; sourceKey?: string }): Input {
    const ticket = this.requireTicket(ticketId)
    if (ticket.stage === 'done') throw new Error('ticket:closed')
    const duplicate = this.findDuplicateInput(ticketId, opts)
    if (duplicate) {
      // 同一条外部消息重复到达（飞书重投 / 面板再点一次）：只保留第一条，不重复投给 worker。
      this.onEvent({
        event: 'input:deduped',
        ticketId,
        inputId: duplicate.id,
        seq: duplicate.seq,
        kind: duplicate.kind,
        ...(opts.sourceKey ? { sourceKey: opts.sourceKey } : {}),
      })
      return duplicate
    }
    // 工单已接但还没派工时先挂起，派工后由 startAssignment 重新绑定。
    const assignment = opts.assignmentId ?? this.store.latestAssignment(ticketId)?.id ?? ''
    const input: Input = {
      id: this.ids.next('in'),
      ticketId,
      assignmentId: assignment,
      seq: this.store.nextInputSeq(ticketId),
      kind: opts.kind,
      text: opts.text,
      ...(opts.sourceKey ? { sourceKey: opts.sourceKey } : {}),
      status: 'pending',
      createdAt: this.clock.now(),
    }
    this.store.insertInput(input)
    if (!this.store.getInput(input.id)) {
      // 唯一键冲突：同一条消息并发入库时命中了已有行，复用那一条而不是丢掉这次投递。
      const existing = opts.sourceKey ? this.store.findInputBySourceKey(ticketId, opts.sourceKey) : null
      if (existing) {
        this.onEvent({ event: 'input:deduped', ticketId, inputId: existing.id, seq: existing.seq, kind: existing.kind })
        return existing
      }
      throw new Error('input:insert-conflict')
    }
    this.onEvent({ event: 'input:queued', ticketId, inputId: input.id, seq: input.seq, kind: input.kind, text: preview(input.text) })
    return input
  }

  /**
   * 找到「已经入库过」的同一条输入。
   *
   * 两层判定：
   * 1. sourceKey 精确匹配 —— 同一条外部消息（飞书 message_id）只入库一次；
   * 2. 内容窗口 —— 同一工单内 kind + 文本完全相同、且还在 pending/delivered 状态、
   *    且发生在 INPUT_DEDUP_WINDOW_MS 内时视为重复（面板与飞书各插了一条的兜底）。
   *    已经 ack / expired 的不参与去重：用户确实可以再发一遍「继续」。
   */
  private findDuplicateInput(
    ticketId: string,
    opts: { kind: InputKind; text: string; sourceKey?: string },
  ): Input | null {
    if (opts.sourceKey) {
      const existing = this.store.findInputBySourceKey(ticketId, opts.sourceKey)
      if (existing) return existing
    }
    const since = new Date(Date.parse(this.clock.now()) - INPUT_DEDUP_WINDOW_MS).toISOString()
    return this.store.findRecentInputByText(ticketId, opts.kind, opts.text, since)
  }

  ackInputs(ticketId: string, ids: string[]): void {
    const ticket = this.store.getTicket(ticketId)
    if (!ticket) return
    this.store.ackInputs(ticket.id, ids, this.clock.now())
  }

  /** 订阅扇出：把某条 Trigger 投给订阅了该 Thread 的所有未关闭工单。 */
  fanOut(triggerId: string): Ticket[] {
    const trigger = this.store.getTrigger(triggerId)
    if (!trigger) throw new Error('trigger:not-found')
    // 已被本轮 tick 领取（evaluating）或尚未处理的都可以扇出。
    if (trigger.disposition !== 'pending' && trigger.disposition !== 'evaluating') return []

    const subscriptions = this.store.listSubscriptions(trigger.threadId)
    const delivered: Ticket[] = []
    const text = withAttachmentManifest(trigger.text, attachmentsOf(trigger.raw))
    for (const sub of subscriptions) {
      const ticket = this.store.getTicket(sub.ticketId)
      if (!ticket || ticket.stage === 'done') continue
      // sourceKey 用 trigger 的外部事件 id：同一条消息只会变成一条输入。
      this.deliverInput(ticket.id, { kind: 'followup', text, sourceKey: `trigger:${trigger.externalId}` })
      delivered.push(ticket)
    }
    this.store.setTriggerDisposition(trigger.id, delivered.length > 0 ? 'fanned_out' : 'pending')
    return delivered
  }

  updatePr(ticketId: string, pr: { number: number; url: string; state: Ticket['prState'] }): Ticket {
    const ticket = this.requireTicket(ticketId)
    const updated: Ticket = { ...ticket, prNumber: pr.number, prUrl: pr.url, prState: pr.state, updatedAt: this.clock.now() }
    this.store.updateTicket(updated)
    this.refreshStage(ticketId)
    return this.store.getTicket(ticketId)!
  }

  /** 结束工单：PR 仍开时拒绝，避免提前闭环。 */
  closeTicket(ticketId: string, reason: string): Ticket {
    const ticket = this.requireTicket(ticketId)
    if (ticket.prState === 'open') throw new Error('pr:open')
    const now = this.clock.now()
    const updated: Ticket = { ...ticket, stage: 'done' as Stage, closedAt: now, updatedAt: now }
    this.store.updateTicket(updated)
    this.store.clearAttention(ticketId)
    const assignment = this.store.latestAssignment(ticketId)
    if (assignment && assignment.status !== 'ended') {
      this.store.updateAssignment({ ...assignment, status: 'ended', endedAt: now })
    }
    this.onEvent({ event: 'ticket:closed', ticketId, by: 'close', reason: preview(reason), stage: updated.stage })
    return updated
  }

  /** 人工停止：立刻结束工单，worker 停止由 Router 通过 Effects 执行。 */
  stopTicket(ticketId: string, reason: string): Ticket {
    const ticket = this.requireTicket(ticketId)
    const now = this.clock.now()
    const updated: Ticket = { ...ticket, stage: 'done' as Stage, closedAt: now, updatedAt: now }
    this.store.updateTicket(updated)
    this.store.clearAttention(ticketId)
    const assignment = this.store.latestAssignment(ticketId)
    if (assignment && assignment.status !== 'ended') {
      this.store.updateAssignment({ ...assignment, status: 'ended', endedAt: now })
    }
    this.onEvent({ event: 'ticket:closed', ticketId, by: 'stop', reason: preview(reason), stage: updated.stage })
    return updated
  }

  subscribe(threadId: string, ticketId: string, contextOnly = false): void {
    this.store.subscribe({ threadId, ticketId, contextOnly, createdAt: this.clock.now() })
  }

  unsubscribe(threadId: string, ticketId: string): void {
    this.store.unsubscribe(threadId, ticketId)
  }

  setAttention(ticketId: string, question: string): void {
    this.requireTicket(ticketId)
    this.store.setAttention(ticketId, question, this.clock.now())
    this.refreshStage(ticketId)
  }

  /** 清除待答问题并重新推导阶段（派工失败后重试时使用）。 */
  clearAttention(ticketId: string): void {
    this.requireTicket(ticketId)
    this.store.clearAttention(ticketId)
    this.refreshStage(ticketId)
  }

  /** 重新推导阶段并落库。 */
  refreshStage(ticketId: string): Stage {
    const ticket = this.requireTicket(ticketId)
    const assignment = this.store.latestAssignment(ticketId)
    const latestReport = this.store.latestReport(ticketId)
    const hasAttention = Boolean(this.store.getAttention(ticketId))
    const stage = computeStage({ ticket, assignment, latestReport, hasAttention })
    if (stage !== ticket.stage) {
      this.store.updateTicket({ ...ticket, stage, updatedAt: this.clock.now() })
    }
    return stage
  }

  listActiveAssignments(): Assignment[] {
    return this.store.listOpenTickets()
      .map(t => this.store.latestAssignment(t.id))
      .filter((a): a is Assignment => Boolean(a) && a!.status === 'running')
  }

  private requireTicket(ticketId: string): Ticket {
    const ticket = this.store.getTicket(ticketId)
    if (!ticket) throw new Error('ticket:not-found')
    return ticket
  }
}

export function deriveTitle(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  if (!line) return '未命名工单'
  return line.length > 40 ? `${line.slice(0, 40)}…` : line
}

/**
 * 提取一条 Trigger 携带的全部线程标识。
 *
 * 新 Source 会显式给出 threadKeys；历史数据与其它 Source 没有这个字段，
 * 按「线程 ID 尾段 + 事件 ID」兜底，至少保证同一 ID 反复出现时能稳定归到一条线程。
 */
function threadKeysOf(trigger: Trigger): string[] {
  const declared = trigger.threadKeys?.filter(Boolean) ?? []
  const tail = trigger.threadId.split(':').at(-1)
  return [...new Set([...declared, tail, trigger.externalId].filter((key): key is string => Boolean(key)))]
}

/**
 * 工单编号：`tk-1`、`tk-2`……全局自增，方便在飞书与终端里直接引用。
 * 旧工单是 `tk_<uuid>`，与短编号不会冲突。
 */
export function formatTicketId(seq: number): string {
  return `tk-${seq}`
}
