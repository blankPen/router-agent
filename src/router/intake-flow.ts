import type { Clock, DecideOutcome, Engine } from '../core/engine.js'
import type { Intake, IntakeReport, Ticket, Trigger } from '#core/model.js'
import { effectiveAllowedByChat } from '#core/policy.js'
import { readRouterPrompt } from '../specs/index.js'
import { preview } from '#core/events.js'
import { noopLogger, errorMessage, type Logger } from '#infra/logger.js'
import type { DispatchSettings } from './dispatch.js'
import { resolveDispatch } from './dispatch.js'
import type { Store } from '../store/db.js'
import type { IntakeEngine } from './intake-engine.js'
import {
  buildAnalystUserPrompt,
  buildScreenerUserPrompt,
  formatReviewMessage,
  formatSubmittedToUser,
  isApprovalCommand,
  isDismissCommand,
  isRejectionCommand,
  parseAnalystOutcome,
  parseScreenerVerdict,
  ticketFromIntake,
} from './intake.js'

/** 单个群的需求分析配置。 */
export interface IntakeChatSettings {
  enabled: boolean
  /** 终审管理员 open_id；为空时回退到策略里的全局名单。 */
  approvers: string[]
  maxQuestions: number
  codeAccess: boolean
}

export interface IntakeSettingsView {
  /**
   * 按群取配置。
   *
   * 需求分析助手是群级能力：开关、追问轮数、终审管理员都跟着群走，
   * 没配的群一律关闭（不会因为别的群开了就跟着开）。
   */
  forChat: (chatId: string) => IntakeChatSettings
}

export interface IntakeCoordinatorOptions {
  store: Store
  engine: Engine
  /** 初筛与分析共用的模型通道。 */
  llm: IntakeEngine
  clock: Clock
  logger?: Logger
  settings: IntakeSettingsView
  dispatch: DispatchSettings
  /** 项目选择器 → 本地目录；拿不到时不读代码，只基于对话判断。 */
  resolveProjectPath?: (project: { name: string; repo: string }) => Promise<string | undefined>
  /** 回消息到原会话；由 AgentLoop 提供，保证出站仍走统一 Outbox。 */
  reply: (trigger: Trigger, text: string, key: string, opts?: { thread?: boolean }) => void
  /** 终审管理员缺省值（策略里的生效名单）。 */
  fallbackApprovers: () => string[]
  home?: string
  /** intake 会话空闲多久后自动放弃，默认 72 小时。 */
  ttlMs?: number
}

export type IntakeGateAction = 'handled' | 'screen'

/** 默认 72 小时没有新消息的 intake 视为放弃，避免陈旧会话一直挡着新问题。 */
const DEFAULT_TTL_MS = 72 * 3_600_000

/**
 * 需求识别调度器。
 *
 * Router 侧只做三件事：判断这条消息该不该进 intake、把模型输出落库、把结果交给管理员终审。
 * 读代码、判断问题性质、组织追问全部发生在 `IntakeEngine` 里，主链路不解析终端、不读仓库。
 */
export class IntakeCoordinator {
  private store: Store
  private engine: Engine
  private llm: IntakeEngine
  private clock: Clock
  private logger: Logger
  private settings: IntakeSettingsView
  private dispatch: DispatchSettings
  private resolveProjectPath?: (project: { name: string; repo: string }) => Promise<string | undefined>
  private replyTo: IntakeCoordinatorOptions['reply']
  private fallbackApprovers: () => string[]
  private home?: string
  private ttlMs: number

  constructor(opts: IntakeCoordinatorOptions) {
    this.store = opts.store
    this.engine = opts.engine
    this.llm = opts.llm
    this.clock = opts.clock
    this.logger = opts.logger ?? noopLogger
    this.settings = opts.settings
    this.dispatch = opts.dispatch
    this.resolveProjectPath = opts.resolveProjectPath
    this.replyTo = opts.reply
    this.fallbackApprovers = opts.fallbackApprovers
    this.home = opts.home
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  }

  /** 这个群是否开启了需求识别。 */
  enabledFor(trigger: Trigger): boolean {
    if (trigger.isBot) return false
    return this.settingsFor(trigger.chatId).enabled
  }

  /** 该群是否配了终审管理员；没配时回退到策略里的全局名单。 */
  isApprover(chatId: string, actorId: string): boolean {
    const approvers = this.approversOf(chatId)
    return approvers.includes(actorId)
  }

  /** 该群的需求分析配置；没配的群按「关闭」处理。 */
  private settingsFor(chatId: string): IntakeChatSettings {
    return this.settings.forChat(chatId)
  }

  /** 该群生效的终审管理员 open_id；没配时回退到全局名单。 */
  private approversOf(chatId: string): string[] {
    const configured = this.settingsFor(chatId).approvers
    return configured.length > 0 ? configured : this.fallbackApprovers()
  }

  /**
   * 这个人能不能在本群发起需求。
   *
   * 只认群级名单：群没配名单时普通成员都能提需（这正是需求分析助手的用途，
   * 全局 allowed 管的是谁能派单，不是谁能提需）；群配了名单则只认名单内的人，
   * 配了却一个都解析不出来 = 该群拒绝所有人。
   *
   * 与 AgentLoop 的初筛入口同口径：intake 走的是 Gate 之前的分支，所以必须自己再判一次，
   * 否则名单外的人能借「继续追问」绕过准入。
   */
  private canRequest(trigger: Trigger): boolean {
    const scoped = effectiveAllowedByChat(this.engine.policy(), trigger.chatId)
    if (scoped === undefined) return true
    return scoped.includes(trigger.actorId)
  }

  /**
   * 能不能给这张需求单终审。
   *
   * 必须是终审管理员（群级配置优先，没配回退全局名单），
   * 且群级白名单是硬边界：配了名单的人不在名单里，也不能终审派单。
   */
  private canApprove(trigger: Trigger): boolean {
    if (!this.isApprover(trigger.chatId, trigger.actorId)) return false
    const scoped = effectiveAllowedByChat(this.engine.policy(), trigger.chatId)
    if (scoped === undefined) return true
    return scoped.includes(trigger.actorId)
  }

  /**
   * Gate 之前的确定性处理：
   * - 发起人继续补信息 → 走分析；
   * - 管理员在已就绪的需求单下确认 / 驳回 → 派单或结束；
   * - 管理员直接补充要求 → 重新分析。
   */
  async handleBeforeGate(trigger: Trigger): Promise<IntakeGateAction> {
    if (!this.enabledFor(trigger)) return 'screen'

    const active = this.freshActive(trigger.threadId, trigger.actorId)
    if (active) {
      if (trigger.mediaOnly) {
        this.replyTo(trigger, '图片我看不到内容，请用文字补充一下问题或复现步骤。', `intake:media:${trigger.id}`, { thread: true })
        this.decideIgnore(trigger, 'intake:media-only', 'inferred')
        return 'handled'
      }
      if (isDismissCommand(trigger.text)) {
        this.closeIntake(active, 'dismissed')
        this.replyTo(trigger, '好，这条问题先放一边；之后如果还需要处理，直接把问题再发一遍就行。', `intake:dismiss:${trigger.id}`, { thread: true })
        this.decideIgnore(trigger, 'intake:dismissed', 'inferred')
        return 'handled'
      }
      // 管理员自己提的需求、自己再终审时，「确认派单 / 驳回」必须按终审处理。
      // 需求单一旦 ready，下面「发起人补充信息」的分支会把它当成新一轮回答，
      // 重新分析一遍再让人确认 —— 表现为确认完永远不进派单，一直在群里来回弹。
      if (active.status === 'ready' && this.canApprove(trigger) && (isApprovalCommand(trigger.text) || isRejectionCommand(trigger.text))) {
        await this.handleApproval(active, trigger)
        return 'handled'
      }
      // 群白名单是硬边界：名单外的人不能借「继续追问」绕过准入。
      if (!this.canRequest(trigger)) {
        this.logger.warn('intake:requester-not-allowed', { triggerId: trigger.id, chat: trigger.chatId, actor: trigger.actorId })
        return 'screen'
      }
      // 发起人补充信息时，如果上一版已经整理成待审需求单，这版必须作废重来：
      // 不能还挂着旧报告让管理员去终审一份已经被推翻的结论。
      if (active.status === 'ready') {
        active.status = 'clarifying'
        active.report = undefined
      }
      // 先把这条回答记进会话再分析：即使分析失败，历史里也有用户原话。
      active.turns.push({ role: 'user', text: trigger.text, at: trigger.receivedAt, actorId: trigger.actorId })
      active.updatedAt = this.clock.now()
      this.store.updateIntake(active)
      await this.advance(active, trigger)
      return 'handled'
    }

    const pending = this.readyIntakeInThread(trigger.threadId)
    // 发起人在需求单待审期间补充内容：当作需求单修订，重新分析一版。
    // 同一话题可能还有别人提问，所以必须按人匹配，不能只看线程。
    if (pending && pending.actorId === trigger.actorId && !isApprovalCommand(trigger.text) && !isRejectionCommand(trigger.text)) {
      if (!this.canRequest(trigger)) {
        this.logger.warn('intake:requester-not-allowed', { triggerId: trigger.id, chat: trigger.chatId, actor: trigger.actorId })
        return 'screen'
      }
      pending.turns.push({ role: 'user', text: trigger.text, at: trigger.receivedAt, actorId: trigger.actorId })
      pending.status = 'clarifying'
      // 旧报告作废：修订后的需求单不能还挂着上一版的结论去终审。
      pending.report = undefined
      pending.updatedAt = this.clock.now()
      this.store.updateIntake(pending)
      await this.advance(pending, trigger)
      return 'handled'
    }
    // 管理员 @机器人 说「确认派单 / 驳回」时仍然按终审处理（语义明确）；
    // 其余 @ 是新指令，要走原研判，不能被待审需求单截走。
    const settlesApproval = isApprovalCommand(trigger.text) || isRejectionCommand(trigger.text)
    if (pending && this.canApprove(trigger) && (trigger.addressed === 'none' || settlesApproval)) {
      await this.handleApproval(pending, trigger)
      return 'handled'
    }
    return 'screen'
  }

  /**
   * 普通成员（未 @、不在派单名单）消息的入口：先轻量初筛，再按类型分流。
   * 返回 false 表示这条消息不归 intake 管，交给原有研判处理。
   */
  async handleUnaddressed(trigger: Trigger): Promise<boolean> {
    if (!this.enabledFor(trigger) || trigger.mediaOnly) return false
    if (!this.hasBoundProject(trigger.chatId)) {
      // 群没绑定项目：分析 Agent 无法定位代码，也不能生成可派单的需求单。
      this.logger.warn('intake:project-unbound', { chat: trigger.chatId, triggerId: trigger.id })
      return false
    }
    return this.screen(trigger)
  }

  private async screen(trigger: Trigger): Promise<boolean> {
    let verdict
    try {
      const text = await this.llm.run({
        systemPrompt: readRouterPrompt(this.home, 'intake-screener.md'),
        userPrompt: buildScreenerUserPrompt(trigger, this.recentTurns(trigger)),
        readCode: false,
      })
      verdict = parseScreenerVerdict(text)
    } catch (error) {
      this.logger.warn('intake:screen-failed', { triggerId: trigger.id, detail: errorMessage(error) })
      return false
    }
    if (!verdict) {
      this.logger.warn('intake:screen-invalid', { triggerId: trigger.id })
      return false
    }
    this.logger.info('intake:screen', { triggerId: trigger.id, chat: trigger.chatId, kind: verdict.kind, reason: preview(verdict.reason, 120) })
    if (verdict.kind === 'chat') {
      // 模型给的 reason 可能复述用户原话，进决策记录前先截断。
      this.decideIgnore(trigger, `intake:chat:${preview(verdict.reason, 120)}`, 'inferred')
      return true
    }

    const intake = this.createIntake(trigger, verdict.kind)
    await this.advance(intake, trigger)
    return true
  }

  private createIntake(trigger: Trigger, kind: 'question' | 'issue'): Intake {
    const resolution = resolveDispatch({ settings: this.dispatch, chatId: trigger.chatId })
    const now = this.clock.now()
    const id = `it_${trigger.id}`
    // 同一个 trigger 被重试时复用已有会话，避免主键冲突把消息卡在重试循环里。
    const existing = this.store.getIntake(id)
    if (existing) return existing
    const intake: Intake = {
      id,
      threadId: trigger.threadId,
      chatId: trigger.chatId,
      actorId: trigger.actorId,
      actorName: trigger.actorName,
      project: resolution.project?.name ?? '',
      repo: resolution.repo,
      branch: resolution.branch,
      status: 'clarifying',
      kind,
      rawText: trigger.text,
      turns: [{ role: 'user', text: trigger.text, at: trigger.receivedAt, actorId: trigger.actorId }],
      questions: 0,
      createdAt: now,
      updatedAt: now,
    }
    this.store.insertIntake(intake)
    this.logger.info('intake:opened', {
      intakeId: intake.id,
      chat: trigger.chatId,
      actor: trigger.actorId,
      kind,
      project: intake.project,
    })
    return intake
  }

  /** 跑一轮分析：用户补充信息、得到答复，或收口成结构化需求单。 */
  private async advance(intake: Intake, trigger: Trigger): Promise<void> {
    const projectPath = await this.projectPathOf(intake)
    const settings = this.settingsFor(intake.chatId)
    const readCode = settings.codeAccess && Boolean(projectPath)
    let outcome
    try {
      const text = await this.llm.run({
        systemPrompt: readRouterPrompt(this.home, 'intake-analyst.md'),
        userPrompt: buildAnalystUserPrompt({ intake, trigger, maxQuestions: settings.maxQuestions, ...(projectPath ? { projectPath } : {}), readCode }),
        readCode,
        ...(projectPath ? { projectPath } : {}),
      })
      outcome = parseAnalystOutcome(text)
    } catch (error) {
      this.logger.warn('intake:analysis-failed', { intakeId: intake.id, detail: errorMessage(error) })
      this.replyTo(trigger, '这次没分析出来，稍后再把问题描述一遍，或者直接 @管理员 看一下。', `intake:analysis-failed:${trigger.id}`, { thread: true })
      this.decideIgnore(trigger, 'intake:analysis-failed', 'inferred')
      return
    }
    if (!outcome) {
      this.logger.warn('intake:analysis-invalid', { intakeId: intake.id, triggerId: trigger.id })
      this.replyTo(trigger, '我这边没能整理清楚，麻烦再说一下具体现象和复现步骤。', `intake:analysis-invalid:${trigger.id}`, { thread: true })
      this.decideIgnore(trigger, 'intake:analysis-invalid', 'inferred')
      return
    }

    intake.turns.push({ role: 'router', text: outcome.reply, at: this.clock.now() })
    if (outcome.action === 'reply') {
      // 追问额度为 0 表示完全不追问：直接按现有信息收口，不发问题。
      if (settings.maxQuestions <= 0) {
        intake.report = this.fallbackReport(intake)
        await this.publishReady(intake, trigger)
        return
      }
      intake.questions += 1
      intake.updatedAt = this.clock.now()
      this.store.updateIntake(intake)
      this.replyTo(trigger, outcome.reply, `intake:reply:${intake.id}:${intake.turns.length}`, { thread: true })
      this.decideIgnore(trigger, `intake:clarify:q${intake.questions}`, 'inferred')
      this.logger.info('intake:clarify', { intakeId: intake.id, questions: intake.questions, chat: intake.chatId })
      // 追问轮数到顶仍拿不到结构化结果：直接按现有信息收口，避免无限对话。
      if (intake.questions >= settings.maxQuestions) {
        intake.report = this.fallbackReport(intake)
        await this.publishReady(intake, trigger)
      }
      return
    }

    // 用户问的是「怎么办」而不是「有问题」：直接给结论就结束，不产出需求单。
    if (outcome.action === 'answer') {
      this.replyTo(trigger, outcome.reply, `intake:answer:${intake.id}:${intake.turns.length}`, { thread: true })
      this.closeIntake(intake, 'answered')
      this.decideIgnore(trigger, 'intake:answered', 'inferred')
      this.logger.info('intake:answered', { intakeId: intake.id, chat: intake.chatId })
      return
    }

    intake.report = outcome.report
    intake.updatedAt = this.clock.now()
    if (outcome.reply) this.replyTo(trigger, outcome.reply, `intake:reply:${intake.id}:${intake.turns.length}`, { thread: true })
    await this.publishReady(intake, trigger)
  }

  /** 需求单就绪：告知发起人已提交审核，并把 @管理员的终审消息挂到同一话题。 */
  private async publishReady(intake: Intake, trigger: Trigger): Promise<void> {
    intake.status = 'ready'
    intake.updatedAt = this.clock.now()
    this.store.updateIntake(intake)

    const approvers = this.approversOf(intake.chatId)
    // 出站 key 带修订时间：同一张需求单改了好几版时，每版都要能发出去，
    // 不能被幂等去重成「同一条消息」吞掉。
    const revision = intake.updatedAt
    this.replyTo(trigger, formatSubmittedToUser(intake), `intake:submitted:${intake.id}:${revision}`, { thread: true })
    this.replyTo(trigger, formatReviewMessage(intake, approvers), `intake:review:${intake.id}:${revision}`, { thread: true })
    this.decideIgnore(trigger, 'intake:ready-for-review', 'inferred')
    this.logger.info('intake:ready', {
      intakeId: intake.id,
      chat: intake.chatId,
      title: intake.report?.title ?? '',
      approvers: approvers.length,
    })
  }

  private async handleApproval(intake: Intake, trigger: Trigger): Promise<void> {
    // 已经派过单的 intake 不再重复处理：重试只补发回复，不再建第二张工单。
    if (intake.status === 'approved' && intake.ticketId) return

    if (isRejectionCommand(trigger.text)) {
      this.closeIntake(intake, 'rejected')
      this.replyTo(trigger, `已驳回需求单「${intake.report?.title ?? intake.id}」，不会派单。`, `intake:rejected:${intake.id}`, { thread: true })
      this.replyTo(trigger, '管理员确认这条需求不需要处理，先关闭了。之后如果还需要跟进，可以重新描述问题。', `intake:rejected-user:${intake.id}`, { thread: true })
      this.decideIgnore(trigger, 'intake:rejected', 'explicit')
      this.logger.info('intake:rejected', { intakeId: intake.id, actor: trigger.actorId })
      return
    }

    if (!isApprovalCommand(trigger.text)) {
      // 管理员补充了要求：当作需求单修订，重新分析一版再提交。
      intake.turns.push({ role: 'user', text: trigger.text, at: trigger.receivedAt, actorId: trigger.actorId })
      intake.status = 'clarifying'
      // 旧报告作废：管理员提了新要求，不能还挂着上一版结论去终审。
      intake.report = undefined
      intake.updatedAt = this.clock.now()
      this.store.updateIntake(intake)
      await this.advance(intake, trigger)
      return
    }

    const ticket = ticketFromIntake(intake)
    if (!ticket) {
      this.replyTo(trigger, '这张需求单还缺结构化内容，无法派单。', `intake:approve-invalid:${intake.id}`, { thread: true })
      return
    }
    if (!intake.repo || !intake.branch) {
      this.replyTo(
        trigger,
        `这张需求单还没有确定项目与起始分支，暂时不能派单。请先在群配置里绑定项目（当前项目：${intake.project || '未绑定'}）。`,
        `intake:approve-noproject:${intake.id}`,
        { thread: true },
      )
      return
    }

    // 幂等：上一次终审已经建过工单、但回写 intake 前就中断了，这里复用它，不再建第二张。
    const existing = this.ticketOfIntake(intake)
    if (existing) {
      intake.status = 'approved'
      intake.ticketId = existing.id
      intake.updatedAt = this.clock.now()
      this.store.updateIntake(intake)
      this.replyTo(trigger, `已确认派单：工单「${existing.title}」（${existing.id}）开始执行。`, `intake:approved:${intake.id}`, { thread: true })
      this.logger.info('intake:approved', { intakeId: intake.id, ticketId: existing.id, actor: trigger.actorId, reused: true })
      return
    }

    let outcome: DecideOutcome
    try {
      outcome = this.engine.decide({
        triggerId: trigger.id,
        decision: 'accept',
        strength: 'explicit',
        reason: `intake:approved:${intake.id}`,
        title: ticket.title,
        scope: `${ticket.scope}\n\n提出人：${intake.actorName || intake.actorId}（${intake.actorId}）\n需求单：${intake.id}`,
        repo: intake.repo,
        branch: intake.branch,
        rules: ['intake:approved'],
        // 工单归属提出人，而不是点「确认派单」的管理员。
        owner: { actorId: intake.actorId, actorName: intake.actorName },
      })
    } catch (error) {
      this.logger.warn('intake:approve-failed', { intakeId: intake.id, detail: errorMessage(error) })
      this.replyTo(trigger, '派单没有成功，稍后再回复「确认派单」试一次。', `intake:approve-failed:${intake.id}`, { thread: true })
      return
    }
    if (!outcome.ticket) {
      this.replyTo(trigger, '当前策略没有自动开单，请直接 @我 说明要做什么。', `intake:approve-blocked:${intake.id}`, { thread: true })
      return
    }

    intake.status = 'approved'
    intake.ticketId = outcome.ticket.id
    intake.updatedAt = this.clock.now()
    this.store.updateIntake(intake)
    this.replyTo(trigger, `已确认派单：工单「${outcome.ticket.title}」（${outcome.ticket.id}）开始执行。`, `intake:approved:${intake.id}`, { thread: true })
    this.logger.info('intake:approved', { intakeId: intake.id, ticketId: outcome.ticket.id, actor: trigger.actorId })
  }

  /** 追问到上限仍无结构化报告时的兜底：用原始对话拼一份可审阅的需求单。 */
  private fallbackReport(intake: Intake): IntakeReport {
    const userTurns = intake.turns.filter(turn => turn.role === 'user').map(turn => turn.text.trim()).filter(Boolean)
    const detail = userTurns.slice(1).join('\n')
    return {
      title: intake.rawText.trim().slice(0, 40) || '群内反馈的问题',
      problem: intake.rawText.trim(),
      background: intake.rawText.trim(),
      steps: '',
      environment: '',
      impact: '',
      expected: '',
      assessment: `已追问 ${intake.questions} 轮仍未收集齐全，按现有信息整理${detail ? `；用户补充：${detail}` : ''}`,
    }
  }

  /**
   * 这张需求单是不是已经建过工单。
   *
   * 终审是「建工单 + 回写 intake」两步，中间崩溃会留下已建单但没回写的需求单：
   * 重试时必须认出它并复用，否则会建出第二张重复工单。
   * 需求单号写进了工单的授权范围（`需求单：it_xxx`），按它反查即可。
   */
  private ticketOfIntake(intake: Intake): Ticket | null {
    return this.store.ticketByIntakeRef(intake.id)
  }

  private closeIntake(intake: Intake, status: 'dismissed' | 'rejected' | 'answered'): void {
    intake.status = status
    intake.updatedAt = this.clock.now()
    this.store.updateIntake(intake)
  }

  private readyIntakeInThread(threadId: string): Intake | null {
    // 按状态取待审的那张：同一个话题里可能还有别的状态的会话，
 // 直接取「最新一条」会拿到一张还没整理好的需求单。
    const ready = this.store.readyIntakeByThread(threadId)
    if (!ready) return null
    // 过期需求单不再接受终审：按 TTL 置为放弃，让管理员重新描述。
    if (this.isExpired(ready)) {
      this.closeIntake(ready, 'dismissed')
      this.logger.info('intake:expired', { intakeId: ready.id })
      return null
    }
    return ready
  }

  /** 只有仍在 TTL 内的 clarifying / ready 会话才继续；过期会话直接置为放弃。 */
  private freshActive(threadId: string, actorId: string): Intake | null {
    const intake = this.store.activeIntake(threadId, actorId)
    if (!intake) return null
    if (this.isExpired(intake)) {
      this.closeIntake(intake, 'dismissed')
      this.logger.info('intake:expired', { intakeId: intake.id })
      return null
    }
    return intake
  }

  /** 会话是否已超过 TTL（默认 72 小时）。 */
  private isExpired(intake: Intake): boolean {
    const updated = Date.parse(intake.updatedAt)
    const now = Date.parse(this.clock.now())
    return Number.isFinite(updated) && Number.isFinite(now) && now - updated > this.ttlMs
  }

  private hasBoundProject(chatId: string): boolean {
    const resolution = resolveDispatch({ settings: this.dispatch, chatId })
    return Boolean(resolution.repo && resolution.branch)
  }

  private async projectPathOf(intake: Intake): Promise<string | undefined> {
    if (!intake.repo) return undefined
    return this.resolveProjectPath ? await this.resolveProjectPath({ name: intake.project, repo: intake.repo }) : undefined
  }

  private recentTurns(trigger: Trigger): Array<{ role: string; text: string }> {
    return this.store.listTriggersByThread(trigger.threadId, 5).map(item => ({
      role: item.actorId === trigger.actorId ? 'user' : 'other',
      text: item.text.slice(0, 200),
    }))
  }

  private decideIgnore(trigger: Trigger, reason: string, strength: 'explicit' | 'inferred'): void {
    try {
      this.engine.decide({ triggerId: trigger.id, decision: 'ignore', strength, reason })
    } catch (error) {
      // Trigger 已被处理（例如同一轮已落过决定）时忽略，但留下原因便于排查。
      this.logger.warn('intake:decision-failed', { triggerId: trigger.id, detail: errorMessage(error) })
    }
  }
}
