import type { Store } from '../store/db.js'
import type { Clock, Engine } from '../core/engine.js'
import { effectiveAllowed, effectiveAllowedByChat, gate, type Policy } from '#core/policy.js'
import type { SourceKind, Strength, Ticket, Trigger } from '#core/model.js'
import { DEFAULT_CHANNEL_ID } from '#channel/port.js'
import { noopLogger, errorMessage, type Logger } from '#infra/logger.js'
import { activeDraft, resolveDispatch, type DispatchMissing, type DispatchSettings } from './dispatch.js'
import { readRouterPrompt } from '../specs/index.js'
import { IntakeCoordinator, type IntakeSettingsView } from './intake-flow.js'
import type { IntakeEngine } from './intake-engine.js'
import type { SessionKeyParts } from './session-registry.js'
import type {
  DecisionAudit,
  DecisionEngine,
  DecisionEngineResult,
  DecisionProposal,
} from './decision-engine.js'

export interface AgentLoopOptions {
  engine: Engine
  /** 唯一研判通道：研判与礼貌回复都走它。 */
  decisionEngine: DecisionEngine
  clock?: Clock
  /** 聚合窗口：只处理比 now - batchWindowMs 更早的消息。 */
  batchWindowMs?: number
  source?: SourceKind
  systemPrompt?: string
  /** 多项目 / 多分支派工设置；不传则不校验 repo/branch（兼容旧测试与嵌入用法）。 */
  dispatch?: DispatchSettings
  /**
   * 「全量接收」的会话：配置了 `mode: all` 的群。
   * 这些群里的消息无论有没有 @，都要正常回复；判不接单就回一句，不开单。
   */
  replyAlwaysChats?: string[]
  /** 是否启用「一个会话一个落盘 session」。关闭时退回旧行为。 */
  sessionsEnabled?: boolean
  /** 会话粒度：user=群+人；thread=群+话题+人。 */
  sessionKeyScope?: 'user' | 'thread'
  /** 状态目录；传入后规范 markdown 优先读 `<home>/specs/` 下的覆盖文件。 */
  home?: string
  /** 人格文案；不传则读内置 prompts/soul.md（或 `<home>/specs/router/soul.md`）。 */
  soul?: string
  /** 人格配置（名字 / 语气 / 语言），只影响 system prompt 的设定段。 */
  persona?: { name: string; style: string; language: string }
  /** 审计出口：每次研判都会回调一次（CLI 落 decisions.jsonl）。 */
  onAudit?: (audit: DecisionAudit) => void
  /** 关键链路日志：消息处理失败、模型不可用、会话读写失败都会在这里留痕。 */
  logger?: Logger
  /**
   * 需求识别（intake）：普通成员在群里反馈问题时由它初筛、澄清并整理需求单。
   * 不传时保持原有行为：群里未 @ 的消息只在 mode=all 时回复，普通成员不能自助提需。
   */
  intake?: {
    llm: IntakeEngine
    settings: IntakeSettingsView
    /** 项目选择器 → 本地目录；返回空表示这一轮不读代码。 */
    resolveProjectPath?: (project: { name: string; repo: string }) => Promise<string | undefined>
  }
}

export interface ClarifyInfo {
  missing: DispatchMissing[]
  repo: string
  branch: string
  rejectedRepo?: string
  /** 尚未开工的原始请求，多轮补齐时保持不变。 */
  task: string
}

export interface AssessResult {
  outcome: 'accept' | 'ignore' | 'unavailable' | 'clarify'
  ticket?: Ticket
  clarify?: ClarifyInfo
  /** 研判过程中已经生成好的用户答复（查询 / 清理类工具），直接发送，不再多调一次回复模型。 */
  reply?: string
}

export interface TickResult {
  accepted: Ticket[]
  ignored: number
  unavailable: number
  replied: number
  fannedOut: number
}

const REPLY_ONLY_TEXT = '这条消息我收到了，但当前策略暂不自动开工（acceptMode=off），所以我没有派工。如果需要我做，请直接 @我并说明要改什么。'
const SMALL_TALK_FALLBACK = '收到。我还没看出具体要做什么，能说一下要改哪个模块、期望的结果吗？'
const MEDIA_ONLY_TEXT = '收到附件了，但我看不到图片/文件里的内容。请用文字说一下要改什么，或者把关键信息贴成文字。'
const THREAD_INTRO = (title: string, id: string) => `工单「${title}」已开始执行（${id}）。后续进展会在这个话题里更新。`

/** 已关闭话题里，用户明确要求继续的关键词。 */
const REOPEN_PATTERN = /重新开工|重新开单|重开|继续做|继续干|接着做|接着干|继续|reopen|retry|continue/i

/**
 * 被群级白名单拒绝的 Gate 原因：intake 不得绕过。
 * 「配了白名单但一个都没解析出来」是安全边界，也不允许普通成员自助触发。
 */
const BLOCKED_BY_CHAT_ALLOWLIST = new Set(['admission:chat-allowlist-empty', 'admission:not-in-chat-allowlist'])

function isAllowlistBlocked(verdict: ReturnType<typeof gate>): boolean {
  return 'reason' in verdict && BLOCKED_BY_CHAT_ALLOWLIST.has(verdict.reason)
}

export function isReopenRequest(text: string): boolean {
  const normalized = text.trim()
  // 先排除「不用继续 / 别重开」这类否定表达，避免把收尾消息当成重开。
  if (/不(用|需要|想|必)(继续|重开|重新)|别(继续|重开|重新)|不要(继续|重开|重新)/.test(normalized)) return false
  return REOPEN_PATTERN.test(normalized)
}

/** 关闭话题的固定回复；不调用模型，保证每次都是同一套口径。 */
export function closedThreadText(ticket: Ticket, opts: { workspaceRemoved?: boolean } = {}): string {
  const closedAt = ticket.closedAt ? ticket.closedAt.slice(0, 10) : ''
  const pr = ticket.prUrl ? `，PR：${ticket.prUrl}` : ''
  return [
    `这张工单「${ticket.title}」（${ticket.id}）已于 ${closedAt} 关闭${pr}，后续消息不会自动继续处理。`,
    '',
    // 工作区已经被回收，原工单没有现场可接，只能另开一张单。
    ...(opts.workspaceRemoved ? ['需要的话，我可以帮你新开工单进行处理。'] : []),
    '如果还需要继续，请回复「重新开工」并说明要补充的内容，我会基于原工单创建一张新工单跟进。',
    '如果是新需求，请描述完整需求并回复「重新开工」，我会创建一张新工单。',
  ].join('\n')
}

/** 已关闭话题里用户先描述的需求：暂存到游标，等「重新开工」时一起带进新工单。 */
function reopenDraftKey(threadId: string, actorId: string): string {
  return `reopen:draft:${threadId}:${actorId}`
}

/** `/new`：只有整条消息就是命令时才生效，允许前面带一个 @机器人。 */
export function parseSessionResetCommand(text: string): boolean {
  return /^\s*(?:@\S+\s+)?\/new\s*$/.test(text)
}

/** 显式 @ 也可能是寒暄/测试；只匹配纯寒暄，不误伤简短需求（如「修个 bug」）。 */
export function isSmallTalk(text: string): boolean {
  // 去掉标点与空白后，只由寒暄词组成才算闲聊（容许「你好在吗」这类拼接）。
  const normalized = text.replace(/[\s!！。.，,~～?？、:：]+/g, '').toLowerCase()
  if (!normalized || normalized.length > 20) return false
  return /^(?:你好|您好|hi|hello|hey|在吗|在不在|在么|谢谢|thanks|辛苦了|收到|好的|ok|早上好|晚上好|测试一下|测试|test|哈+|嗯+|哦+|在)+$/.test(normalized)
}

/**
 * 常驻 Agent Loop：候选批处理 → Gate → （已订阅则扇出）→ 研判 → 决策。
 * 不自己 sleep；由外部按固定节奏调用 tick()。
 */
export class AgentLoop {
  readonly engine: Engine
  private store: Store
  private clock: Clock
  private batchWindowMs: number
  private source?: SourceKind
  private systemPrompt: string
  private conversationPrompt: string
  private dispatch?: DispatchSettings
  /** 全量接收的会话：这些群里不 @ 也要回复。 */
  private replyAlwaysChats: Set<string>
  /** 会话复用开关与粒度。 */
  private sessionsEnabled: boolean
  private sessionKeyScope: 'user' | 'thread'
  /** 会话模式使用的统一 system prompt（人格 + 职责 + 准入 + 回复 + 策略）。 */
  private unifiedSystemPrompt: string
  private soul: string
  private home?: string
  private persona?: { name: string; style: string; language: string }
  /** 可替换：测试与模拟可以直接注入假引擎。 */
  decisionEngine: DecisionEngine
  private onAudit?: (audit: DecisionAudit) => void
  private logger: Logger
  private intake?: IntakeCoordinator

  constructor(opts: AgentLoopOptions) {
    this.engine = opts.engine
    this.store = opts.engine.store
    this.clock = opts.clock ?? { now: () => new Date().toISOString() }
    this.batchWindowMs = opts.batchWindowMs ?? 8000
    this.source = opts.source
    this.home = opts.home
    this.systemPrompt = opts.systemPrompt ?? buildSystemPrompt(opts.engine.policy(), this.home)
    this.conversationPrompt = readPrompt('conversation.md', this.home)
    this.dispatch = opts.dispatch
    this.replyAlwaysChats = new Set(opts.replyAlwaysChats ?? [])
    this.sessionsEnabled = opts.sessionsEnabled === true
    this.sessionKeyScope = opts.sessionKeyScope ?? 'user'
    this.soul = opts.soul ?? readPrompt('soul.md', this.home)
    this.persona = opts.persona
    this.unifiedSystemPrompt = buildUnifiedSystemPrompt(opts.engine.policy(), this.soul, this.persona, this.home)
    this.decisionEngine = opts.decisionEngine
    this.onAudit = opts.onAudit
    this.logger = opts.logger ?? noopLogger
    this.intake = opts.intake
      ? new IntakeCoordinator({
          store: this.store,
          engine: this.engine,
          llm: opts.intake.llm,
          clock: this.clock,
          logger: this.logger,
          settings: opts.intake.settings,
          dispatch: this.dispatch ?? { projects: [], bindings: [] },
          ...(opts.intake.resolveProjectPath ? { resolveProjectPath: opts.intake.resolveProjectPath } : {}),
          reply: (trigger, text, key, opts) => this.reply(trigger, text, key, opts),
          fallbackApprovers: () => effectiveAllowed(this.engine.policy()),
          ...(this.home ? { home: this.home } : {}),
        })
      : undefined
  }

  setPolicy(policy: Policy): void {
    this.engine.updatePolicy(policy)
    this.systemPrompt = buildSystemPrompt(policy, this.home)
    this.unifiedSystemPrompt = buildUnifiedSystemPrompt(policy, this.soul, this.persona, this.home)
  }

  async tick(): Promise<TickResult> {
    const now = this.clock.now()
    const cutoff = new Date(new Date(now).getTime() - this.batchWindowMs).toISOString()
    const result: TickResult = { accepted: [], ignored: 0, unavailable: 0, replied: 0, fannedOut: 0 }

    const pending = this.store.claimPendingTriggers(cutoff).filter(t => !this.source || t.source === this.source)
    for (const trigger of pending) {
      try {
        await this.handle(trigger, result)
      } catch (error) {
        // 单条失败不影响同批其它消息；未落决定的会在 finally 里放回队列。
        // 这里必须留日志，否则用户只会看到「消息没反应」却查不到原因。
        this.logger.error('loop:trigger-failed', {
          triggerId: trigger.id,
          chat: trigger.chatId,
          thread: trigger.threadId,
          message: errorMessage(error),
        })
      } finally {
        const current = this.store.getTrigger(trigger.id)
        if (current?.disposition === 'evaluating') this.store.setTriggerDisposition(trigger.id, 'pending')
      }
    }
    return result
  }

  /** 处理单条已领取的 Trigger。 */
  private async handle(trigger: Trigger, result: TickResult): Promise<void> {
    {
      // /new 优先于一切：即使话题里有活跃工单，也要能重置会话。
      if (parseSessionResetCommand(trigger.text)) {
        await this.handleSessionReset(trigger, result)
        return
      }

      // 订阅扇出优先：已订阅线程的消息不经过研判。
      if (this.hasLiveSubscription(trigger.threadId)) {
        const delivered = this.engine.fanOut(trigger.id)
        if (delivered.length > 0) {
          await this.recordTranscript(trigger, `${trigger.actorName || trigger.actorId}：${trigger.text}`)
          result.fannedOut += delivered.length
          return
        }
      }

      // 需求识别：进行中的澄清会话、待终审的需求单优先处理，不进入研判/派工。
      if (this.intake) {
        const intakeAction = await this.intake.handleBeforeGate(trigger)
        if (intakeAction === 'handled') {
          await this.recordTranscript(trigger, `${trigger.actorName || trigger.actorId}：${trigger.text}`)
          return
        }
      }

      // 已关闭工单的话题：确定性回复，不再交给模型，也不自动开单。
      const closed = this.closedTicketForThread(trigger.threadId, trigger.actorId)
      if (closed) {
        await this.handleClosedThread(trigger, closed, result)
        return
      }

      const verdict = gate(trigger, this.engine.policy())
      // 需求识别：群里未 @ 的消息统一先过轻量初筛，名单内外的普通反馈一视同仁。
      // 群级白名单（含「配了但一个都没解析出来」）是硬边界，不允许 intake 绕过。
      if (this.intake && trigger.addressed === 'none' && !trigger.mediaOnly && !isAllowlistBlocked(verdict)) {
        const handled = await this.intake.handleUnaddressed(trigger)
        if (handled) {
          await this.recordTranscript(trigger, `${trigger.actorName || trigger.actorId}：${trigger.text}`)
          result.ignored += 1
          return
        }
      }
      if (verdict.action === 'ignore') {
        await this.recordTranscript(trigger, `${trigger.actorName || trigger.actorId}：${trigger.text}`)
        this.engine.decide({ triggerId: trigger.id, decision: 'ignore', strength: 'inferred', reason: verdict.reason })
        result.ignored += 1
        return
      }
      // 纯附件消息没有可执行的文字，直接回一句要说明，不开单、不烧模型。
      if (trigger.mediaOnly) {
        this.engine.decide({
          triggerId: trigger.id,
          decision: 'ignore',
          strength: trigger.addressed === 'none' ? 'inferred' : 'explicit',
          reason: 'media:needs-text',
        })
        result.ignored += 1
        if (this.shouldReply(trigger)) {
          this.reply(trigger, MEDIA_ONLY_TEXT, `media:${trigger.id}`)
          await this.recordTranscript(trigger, `${trigger.actorName || trigger.actorId}：[附件消息，未解析]\nRouter：${MEDIA_ONLY_TEXT}`)
          result.replied += 1
        }
        return
      }
      if (verdict.action === 'reply-only') {
        await this.replyOnly(trigger, verdict.reason)
        result.replied += 1
        return
      }
      if (verdict.action === 'explicit') {
        if (isSmallTalk(trigger.text)) {
          // 明显寒暄不必再花一次研判，直接让模型组织一句礼貌回复。
          await this.converse(trigger, '这条消息是寒暄或试探，没有具体工作请求')
          this.engine.decide({ triggerId: trigger.id, decision: 'ignore', strength: 'explicit', reason: 'explicit:small-talk' })
          result.replied += 1
          return
        }
        const assessed = await this.assess(trigger, 'explicit')
        await this.applyAssess(trigger, assessed, result, 'explicit')
        return
      }

      const assessed = await this.assess(trigger)
      await this.applyAssess(trigger, assessed, result, 'inferred')
    }
  }

  /** 落地研判结果：接单只用一条话题消息确认开单；没接单且消息是在找它说话时，礼貌回一句。 */
  private async applyAssess(trigger: Trigger, assessed: AssessResult, result: TickResult, strength: Strength): Promise<void> {
    if (assessed.outcome === 'accept' && assessed.ticket) {
      // 派工信息已经凑齐并开单，草稿使命结束。
      this.store.clearDispatchDraft(trigger.chatId, trigger.actorId)
      result.accepted.push(assessed.ticket)
      // 只发一条：话题开场同时承担开单确认，后续 worker 进展都挂在这条原消息下。
      this.reply(trigger, THREAD_INTRO(assessed.ticket.title, assessed.ticket.id), `thread:${assessed.ticket.id}`, { thread: true })
      return
    }
    if (assessed.outcome === 'clarify' && assessed.clarify) {
      const info = assessed.clarify
      // 不在「全量接收」的会话里时，未 @ 的消息不追问，避免群里刷屏。
      if (!this.shouldReply(trigger)) {
        this.engine.decide({ triggerId: trigger.id, decision: 'ignore', strength, reason: `clarify:unaddressed:missing-${info.missing.join('+')}` })
        result.ignored += 1
        return
      }
      this.store.saveDispatchDraft({
        chatId: trigger.chatId,
        threadId: trigger.threadId,
        actorId: trigger.actorId,
        task: info.task,
        repo: info.repo,
        branch: info.branch,
        updatedAt: this.clock.now(),
      })
      this.engine.decide({ triggerId: trigger.id, decision: 'ignore', strength, reason: `clarify:missing-${info.missing.join('+')}` })
      result.ignored += 1
      await this.converse(trigger, clarifyReason(info), {
        needs: {
          missing: info.missing,
          ...(info.rejectedRepo ? { rejected_repo: info.rejectedRepo } : {}),
          resolved_repo: info.repo,
          resolved_branch: info.branch,
        },
        projects: (this.dispatch?.projects ?? []).map(project => ({
          name: project.name,
          defaultBranch: project.defaultBranch,
        })),
        draft: { task: info.task },
      }, clarifyFallback(info, this.dispatch?.projects))
      result.replied += 1
      return
    }
    if (assessed.outcome === 'unavailable') {
      result.unavailable += 1
      if (this.shouldReply(trigger)) {
        await this.converse(trigger, '暂时没判断出来这条消息要做什么')
        result.replied += 1
      }
      return
    }
    result.ignored += 1
    // 全量接收的会话（mode: all）里，不接单也要正常回一句，只是不开单。
    if (this.shouldReply(trigger)) {
      // 查询 / 清理类工具已经在研判阶段生成好答复时直接用，避免重复调用模型。
      if (assessed.reply) this.reply(trigger, assessed.reply, `chat:${trigger.id}`)
      else await this.converse(trigger, 'Router 判断这不是可执行的工作请求')
      result.replied += 1
    }
  }

  /** 让 Pi 组织一句礼貌回复（普通消息，不进话题）。失败时退回固定话术。 */
  async converse(trigger: Trigger, reason: string, extra: Record<string, unknown> = {}, fallback: string = SMALL_TALK_FALLBACK): Promise<string> {
    let text = ''
    const session = this.sessionFor(trigger)
    try {
      text = await this.decisionEngine.reply({
        systemPrompt: this.sessionsEnabled ? this.unifiedSystemPrompt : this.systemPromptFor(trigger, this.conversationPrompt),
        userPrompt: JSON.stringify({
          message: trigger.text,
          addressed: trigger.addressed,
          reason,
          mode: 'reply',
          ...(this.sessionsEnabled ? { chat: this.chatContextData(trigger) } : {}),
          ...extra,
        }),
        ...(session ? { session } : {}),
      })
      text = text.trim()
    } catch (error) {
      // 模型回复失败时退回到固定话术；日志记下原因，避免把「模型挂了」误判成「模型不会答」。
      this.logger.warn('chat:reply-failed', {
        triggerId: trigger.id,
        chat: trigger.chatId,
        reason,
        message: errorMessage(error),
      })
      text = ''
    }
    const reply = text || fallback
    this.reply(trigger, reply, `chat:${trigger.id}`)
    return reply
  }

  /** 所有 LLM 调用的 system prompt 都带上「当前会话」段：群绑定、可选项目、待补齐请求。 */
  private systemPromptFor(trigger: Trigger, base: string = this.systemPrompt): string {
    const section = this.chatContextSection(trigger)
    return section ? `${base}\n\n---\n\n${section}` : base
  }

  /** 会话级上下文：同一个群的所有模型调用看到的都是同一份，和具体某条消息无关。 */
  private chatContextSection(trigger: Trigger): string {
    if (!this.dispatch) return ''
    const lines = ['# 当前会话', `- 会话：${trigger.chatId}${trigger.chatName ? `（${trigger.chatName}）` : ''}`]
    const binding = this.dispatch.bindings.find(item => item.chat === trigger.chatId)
    const resolution = resolveDispatch({ settings: this.dispatch, chatId: trigger.chatId })

    if (resolution.repo && resolution.branch) {
      const project = resolution.project?.name ?? resolution.repo
      const repo = resolution.project?.repo ?? resolution.repo
      lines.push(`- 已确定项目：${project}（Orca 仓库：${repo}），起始分支：${resolution.branch}（来源：${binding ? '群绑定' : '项目默认'}）`)
      lines.push('- 用户说「这个项目 / 这个仓库 / 这里」时，默认指上面这个项目，不要反问。')
    } else {
      const missing = resolution.missing.includes('repo') ? (resolution.missing.includes('branch') ? '项目与起始分支' : '项目') : '起始分支'
      lines.push(`- 本项目前未确定${missing}：用户没有明确说明时，开单前需要确认。`)
    }
    if (this.dispatch.projects.length > 0) {
      lines.push(`- 可选项目：${this.dispatch.projects.map(project => project.name).join('、')}`)
    }
    const draft = activeDraft(this.store, trigger.chatId, trigger.actorId, this.clock.now())
    if (draft) {
      lines.push(`- 待补齐的请求：「${draft.task}」（已解析项目：${draft.repo || '未知'}，起始分支：${draft.branch || '未知'}）`)
    }
    return lines.join('\n')
  }

  /** 单条候选的研判。研判与回复都走同一条 Pi 通道。 */
  async assess(trigger: Trigger, strength: Strength = 'inferred'): Promise<AssessResult> {
    const session = this.sessionFor(trigger)
    const result = await this.decisionEngine
      .assess({
        trigger,
        strength,
        systemPrompt: this.sessionsEnabled ? this.unifiedSystemPrompt : this.systemPromptFor(trigger),
        userPrompt: this.contextPrompt(trigger),
        canMutate: this.canMutate(trigger),
        ...(session ? { session } : {}),
      })
      .catch(error => {
        this.logger.warn('decision:engine-failed', { triggerId: trigger.id, message: errorMessage(error) })
        return failedResult(trigger.id, error)
      })
    this.onAudit?.(result.audit)

    if (result.unavailableReason) return this.markUnavailable(trigger, result.unavailableReason)
    if (!result.proposal) return this.markUnavailable(trigger, '研判未产出决定')
    const applied = this.applyProposal(trigger, result.proposal, strength)
    return result.reply ? { ...applied, reply: result.reply } : applied
  }

  /**
   * 写工具授权：发送人必须在当前会话的 allowed 名单内，且消息是 @ 或私聊。
   * 只看 addressed 不够——名单外的人 @ 机器人时 Gate 仍可能放行到研判，
   * 但不能因此获得关单 / 回收 workspace 的权限。
   */
  private canMutate(trigger: Trigger): boolean {
    if (trigger.isBot || trigger.addressed === 'none') return false
    const policy = this.engine.policy()
    const scoped = effectiveAllowedByChat(policy, trigger.chatId)
    const allowed = scoped ?? effectiveAllowed(policy)
    return allowed.includes(trigger.actorId)
  }

  /** 只有这里会写库：派工解析 + Engine.decide。 */
  private applyProposal(trigger: Trigger, proposal: DecisionProposal, strength: Strength): AssessResult {
    if (proposal.decision === 'unavailable') {
      return this.markUnavailable(trigger, proposal.reason || '模型判定未完成')
    }

    let repo = proposal.repo ?? ''
    let branch = proposal.branch ?? ''
    if (proposal.decision === 'accept' && this.dispatch) {
      const draft = activeDraft(this.store, trigger.chatId, trigger.actorId, this.clock.now())
      const resolution = resolveDispatch({ settings: this.dispatch, chatId: trigger.chatId, draft, repo, branch })
      if (resolution.missing.length > 0 || resolution.rejectedRepo) {
        return {
          outcome: 'clarify',
          clarify: {
            missing: resolution.missing,
            repo: resolution.repo,
            branch: resolution.branch,
            ...(resolution.rejectedRepo ? { rejectedRepo: resolution.rejectedRepo } : {}),
            task: draft?.task ?? trigger.text,
          },
        }
      }
      repo = resolution.repo
      branch = resolution.branch
    }

    const outcome = this.engine.decide({
      triggerId: trigger.id,
      decision: proposal.decision,
      strength,
      reason: proposal.reason,
      ...(proposal.title === undefined ? {} : { title: proposal.title }),
      ...(proposal.scope === undefined ? {} : { scope: proposal.scope }),
      ...(repo ? { repo } : {}),
      ...(branch ? { branch } : {}),
      rules: proposal.rules,
    })
    return outcome.decision.decision === 'accept' && outcome.ticket
      ? { outcome: 'accept', ticket: outcome.ticket }
      : { outcome: 'ignore' }
  }

  private markUnavailable(trigger: Trigger, reason: string): AssessResult {
    try {
      this.engine.decide({ triggerId: trigger.id, decision: 'unavailable', strength: 'inferred', reason })
    } catch {
      // Trigger 已被处理时忽略。
    }
    return { outcome: 'unavailable' }
  }

  private async replyOnly(trigger: Trigger, reason: string): Promise<void> {
    this.reply(trigger, REPLY_ONLY_TEXT, `replyonly:${trigger.id}`)
    await this.recordTranscript(trigger, `${trigger.actorName || trigger.actorId}：${trigger.text}\nRouter：${REPLY_ONLY_TEXT}`)
    this.engine.decide({ triggerId: trigger.id, decision: 'ignore', strength: 'inferred', reason })
  }

  /** 会话 key：默认按「通道 + 群 + 人」隔离；thread 粒度再叠加话题。 */
  private sessionKeyOf(trigger: Trigger): SessionKeyParts | null {
    if (!this.sessionsEnabled) return null
    const channel = trigger.channelId ?? DEFAULT_CHANNEL_ID
    const thread = this.sessionKeyScope === 'thread' ? `:thread:${trigger.threadId}` : ''
    return {
      key: `channel:${channel}:chat:${trigger.chatId}${thread}:user:${trigger.actorId}`,
      chatId: trigger.chatId,
      actorId: trigger.actorId,
      threadId: trigger.threadId,
    }
  }

  /** 发送人是否在当前群的 allowed 名单内（不看 @）。 */
  private isAllowed(trigger: Trigger): boolean {
    const policy = this.engine.policy()
    const scoped = effectiveAllowedByChat(policy, trigger.chatId)
    const allowed = scoped ?? effectiveAllowed(policy)
    return allowed.includes(trigger.actorId)
  }

  /**
   * 这条消息要不要进 session：
   * - 机器人、名单外成员不进；
   * - mode: mention 群只进 @ / 私聊；mode: all 群全进。
   */
  private shouldTrackConversation(trigger: Trigger): boolean {
    if (!this.sessionsEnabled || trigger.isBot) return false
    if (!this.isAllowed(trigger)) return false
    return trigger.addressed !== 'none' || this.replyAlwaysChats.has(trigger.chatId)
  }

  /** 只有应该进会话的消息才返回 session；没 @ 的 mention 群消息保持一次性调用。 */
  private sessionFor(trigger: Trigger): SessionKeyParts | null {
    return this.shouldTrackConversation(trigger) ? this.sessionKeyOf(trigger) : null
  }

  /** 确定性回复也写进会话，保证下一轮模型知道「刚才发生过什么」。 */
  private async recordTranscript(trigger: Trigger, text: string): Promise<void> {
    if (!this.shouldTrackConversation(trigger)) return
    const parts = this.sessionKeyOf(trigger)
    if (!parts) return
    try {
      await this.decisionEngine.recordTranscript?.(parts, text, this.unifiedSystemPrompt)
    } catch (error) {
      // 会话写入失败不能影响正常回复与决策，但需要留下原因。
      this.logger.warn('session:transcript-failed', { key: parts.key, message: errorMessage(error) })
    }
  }

  /** `/new`：只重置发送者自己的 session，不影响同群其他人。 */
  private async handleSessionReset(trigger: Trigger, result: TickResult): Promise<void> {
    const parts = this.sessionKeyOf(trigger)

    // 机器人、名单外成员、没 @ 的消息：静默忽略，避免刷屏或机器人互相触发。
    if (trigger.isBot || !this.isAllowed(trigger) || !this.shouldReply(trigger)) {
      this.engine.decide({ triggerId: trigger.id, decision: 'ignore', strength: 'explicit', reason: 'session:reset:ignored' })
      result.ignored += 1
      return
    }
    if (!this.sessionsEnabled) {
      this.reply(trigger, '会话复用还没开启，暂时不需要 /new。', `session-reset-disabled:${trigger.id}`)
      this.engine.decide({ triggerId: trigger.id, decision: 'ignore', strength: 'explicit', reason: 'session:reset:disabled' })
      result.replied += 1
      return
    }
    if (!parts) {
      this.engine.decide({ triggerId: trigger.id, decision: 'ignore', strength: 'explicit', reason: 'session:reset:unavailable' })
      result.ignored += 1
      return
    }
    if (!this.decisionEngine.resetSession) {
      this.reply(trigger, '当前引擎没有接入会话复用，暂时不需要 /new。', `session-reset-unavailable:${trigger.id}`)
      this.engine.decide({ triggerId: trigger.id, decision: 'ignore', strength: 'explicit', reason: 'session:reset:unavailable' })
      result.replied += 1
      return
    }

    try {
      await this.decisionEngine.resetSession?.(parts, trigger.actorId)
    } catch (error) {
      this.logger.warn('session:reset-failed', { key: parts.key, message: errorMessage(error) })
      this.reply(trigger, '这次重置没成功，稍后再试一下。', `session-reset-failed:${trigger.id}`)
      this.engine.decide({ triggerId: trigger.id, decision: 'ignore', strength: 'explicit', reason: 'session:reset:failed' })
      result.replied += 1
      return
    }
    this.reply(
      trigger,
      '好，之前你和我的上下文我不带了，咱们重新开始。\n工单和历史记录都还在，群里其他人的会话也不受影响。',
      `session-reset:${trigger.id}`,
    )
    this.engine.decide({ triggerId: trigger.id, decision: 'ignore', strength: 'explicit', reason: 'session:reset' })
    result.replied += 1
  }

  /**
   * 这条消息要不要回。
   *
   * - 私聊、@机器人：一定回；
   * - 群里没 @ 但话题已绑定在办工单、被放行处理（tk-59）：也回，
   *   否则用户既看不到确认表情，也等不到任何回应；
   * - 群里没 @：只有配置为 `mode: all` 的会话才回。
   *   全量接收意味着「所有消息都当对话听」，不能只听不回。
   */
  private shouldReply(trigger: Trigger): boolean {
    if (trigger.addressed !== 'none') return true
    if (trigger.unaddressedAdmitted) return true
    return this.replyAlwaysChats.has(trigger.chatId)
  }

  /** 回一句到原会话；key 保证同一件事只发一次。 */
  /** thread=true 时用话题回复（挂到原消息下）；否则发普通消息。 */
  private reply(trigger: Trigger, text: string, key: string, opts: { thread?: boolean } = {}): void {
    const rootId = opts.thread ? (trigger.threadKeys?.[0] ?? trigger.threadId.split(':').at(-1) ?? '') : ''
    this.store.enqueueOutbox({
      id: `ob_${key.replace(/[^a-zA-Z0-9:_-]/g, '_')}`,
      key,
      channelKind: trigger.channelId ?? DEFAULT_CHANNEL_ID,
      channelId: trigger.chatId,
      threadId: rootId,
      text,
      now: this.clock.now(),
      originMessageId: trigger.externalId,
    })
  }

  private hasLiveSubscription(threadId: string): boolean {
    return this.store.listSubscriptions(threadId).some(sub => {
      const ticket = this.store.getTicket(sub.ticketId)
      return Boolean(ticket && ticket.stage !== 'done')
    })
  }

  /**
   * 该线程是否只对应已关闭工单（没有在办工单）；返回当前发送人最近关闭的那张。
   * 按人过滤，避免 B 在 A 的已关闭话题里被误判成「重开 A 的单」。
   */
  private closedTicketForThread(threadId: string, actorId: string): Ticket | null {
    const subscriptions = this.store.listSubscriptions(threadId)
    for (let i = subscriptions.length - 1; i >= 0; i -= 1) {
      const ticket = this.store.getTicket(subscriptions[i]!.ticketId)
      if (ticket?.stage !== 'done') continue
      const mandate = this.store.getMandate(ticket.mandateId)
      if (mandate?.actorId === actorId) return ticket
    }
    return null
  }

  /**
   * 已关闭话题的确定性处理：不研判、不自动开工。
   * - 普通消息：回复「工单已关闭」并记住内容，供随后的「重新开工」一并作为新工单上下文；
   * - 明确要求重开：基于原工单的 repo / 起始分支创建一张新工单。
   */
  private async handleClosedThread(trigger: Trigger, closed: Ticket, result: TickResult): Promise<void> {
    if (trigger.isBot) {
      this.engine.decide({ triggerId: trigger.id, decision: 'ignore', strength: 'inferred', reason: 'thread:closed:bot' })
      result.ignored += 1
      return
    }

    const verdict = gate(trigger, this.engine.policy())
    if (verdict.action === 'ignore') {
      // 群级白名单外 / 机器人等：关闭话题也不回复，避免绕开准入。
      this.engine.decide({
        triggerId: trigger.id,
        decision: 'ignore',
        strength: 'inferred',
        reason: `thread:closed:${verdict.reason}`,
      })
      result.ignored += 1
      return
    }

    const strength: Strength = verdict.action === 'explicit' ? 'explicit' : 'inferred'
    const canReopen = verdict.action === 'explicit' || verdict.action === 'infer'

    if (canReopen && isReopenRequest(trigger.text)) {
      const reopened = this.reopenTicket(trigger, closed, strength)
      if (reopened) result.accepted.push(reopened)
      return
    }

    if (!trigger.mediaOnly && !isSmallTalk(trigger.text)) {
      // 用户可能是先描述需求、再补一句「重新开工」；把这条原文记下来。
      this.store.setCursor(reopenDraftKey(trigger.threadId, trigger.actorId), trigger.text.trim().slice(0, 4000), this.clock.now())
    }
    const text = closedThreadText(closed, { workspaceRemoved: this.store.isWorkspaceRemoved(closed.id) })
    this.reply(trigger, text, `closed-thread:${trigger.id}`, { thread: true })
    await this.recordTranscript(
      trigger,
      `${trigger.actorName || trigger.actorId}：${trigger.text}\nRouter：${text}`,
    )
    this.engine.decide({ triggerId: trigger.id, decision: 'ignore', strength, reason: 'thread:closed' })
    result.replied += 1
  }

  private reopenTicket(trigger: Trigger, closed: Ticket, strength: Strength): Ticket | null {
    const draftKey = reopenDraftKey(trigger.threadId, trigger.actorId)
    const draft = this.store.getCursor(draftKey)
    const task = [draft, trigger.text].map(text => text?.trim() ?? '').filter(Boolean).join('\n\n')

    // 重新开工会建一张【新工单】，它使用当前默认后端；旧工单的 repo 可能属于
    // 另一个后端（例如 orca 的 name: 选择器），必须先映射到当前后端的项目清单。
    let repo = closed.repo
    let branch = closed.branch
    if (this.dispatch) {
      const settings = this.dispatch
      const resolveFor = (repoHint?: string) => resolveDispatch({
        settings,
        chatId: trigger.chatId,
        ...(repoHint ? { repo: repoHint } : {}),
        ...(closed.branch ? { branch: closed.branch } : {}),
      })
      let resolution = resolveFor(closed.repo)
      if (!resolution.repo) {
        // 用户在重新开工的这句话里点名了当前清单里的项目时优先使用。
        const named = settings.projects.find(project => task.includes(project.name))
        if (named) resolution = resolveFor(named.name)
      }
      if (!resolution.repo) resolution = resolveFor()
      repo = resolution.repo
      branch = resolution.branch
      if (!repo) {
        const names = settings.projects.map(project => project.name)
        this.reply(
          trigger,
          `原工单使用的项目「${closed.repo || '(未设置)'}」不在当前后端的项目清单里。请重新描述需求并指定项目${names.length > 0 ? `（可选：${names.slice(0, 5).join('、')}）` : '（当前后端还没有配置项目）'}，我会按新工单处理。`,
          `reopen-project:${trigger.id}`,
          { thread: true },
        )
        this.store.setCursor(draftKey, task, this.clock.now())
        return null
      }
    }

    const outcome = this.engine.decide({
      triggerId: trigger.id,
      decision: 'accept',
      strength,
      reason: `thread:reopen:${closed.id}`,
      title: `续作：${closed.title}`,
      scope: task || trigger.text,
      ...(repo ? { repo } : {}),
      ...(branch ? { branch } : {}),
    })
    this.store.deleteCursor(draftKey)

    if (!outcome.ticket) {
      this.reply(
        trigger,
        '收到重新开工的请求，但当前策略没有自动开单。请直接 @我 说明要做什么，我会按新工单处理。',
        `reopen-blocked:${trigger.id}`,
        { thread: true },
      )
      return null
    }
    this.reply(
      trigger,
      `已基于原工单 ${closed.id} 创建新工单「${outcome.ticket.title}」（${outcome.ticket.id}），从 ${closed.branch || '默认分支'} 重新开始。`,
      `reopen:${outcome.ticket.id}`,
      { thread: true },
    )
    return outcome.ticket
  }

  private contextPrompt(trigger: Trigger): string {
    const policy = this.engine.policy()
    const base = {
      policy: {
        version: policy.version,
        acceptMode: policy.acceptMode,
        allowed: displayAllowed(policy),
        admission: policy.admission,
      },
      trigger: {
        id: trigger.id,
        source: trigger.source,
        chat: trigger.chatId,
        actor: trigger.actorId,
        addressed: trigger.addressed,
        isBot: trigger.isBot,
        text: trigger.text,
        receivedAt: trigger.receivedAt,
      },
    }

    // 会话复用：历史在 session 里，不再重复注入最近 10 条；工单只注入当前用户发起的。
    if (this.sessionsEnabled) {
      return JSON.stringify({
        ...base,
        mode: 'assess',
        chat: this.chatContextData(trigger),
        tickets: this.ticketsForUser(trigger),
      }, null, 2)
    }

    const thread = this.store.listTriggersByThread(trigger.threadId, 10)
    const tickets = this.store.listSubscriptions(trigger.threadId).map(s => this.store.getTicket(s.ticketId)).filter(Boolean)
    return JSON.stringify({
      ...base,
      // 会话级上下文（群绑定 / 可选项目 / 草稿）统一放在 system prompt 的「当前会话」段。
      thread: thread.map(t => ({ id: t.id, actor: t.actorId, text: t.text, at: t.receivedAt })),
      tickets: tickets.map(t => ({ id: t?.id, title: t?.title, stage: t?.stage, prUrl: t?.prUrl })),
    }, null, 2)
  }

  /** 每轮动态的会话级上下文：群绑定、可选项目、当前用户的派工草稿。 */
  private chatContextData(trigger: Trigger): Record<string, unknown> {
    const data: Record<string, unknown> = {
      id: trigger.chatId,
      ...(trigger.chatName ? { name: trigger.chatName } : {}),
    }
    if (!this.dispatch) return data
    const binding = this.dispatch.bindings.find(item => item.chat === trigger.chatId)
    const resolution = resolveDispatch({ settings: this.dispatch, chatId: trigger.chatId })
    if (resolution.repo && resolution.branch) {
      data.project = {
        name: resolution.project?.name ?? resolution.repo,
        repo: resolution.project?.repo ?? resolution.repo,
        branch: resolution.branch,
        source: binding ? 'binding' : 'default',
      }
    } else {
      data.missing = resolution.missing
    }
    if (this.dispatch.projects.length > 0) {
      data.projects = this.dispatch.projects.map(project => ({
        name: project.name,
        defaultBranch: project.defaultBranch,
      }))
    }
    const draft = activeDraft(this.store, trigger.chatId, trigger.actorId, this.clock.now())
    if (draft) data.draft = { task: draft.task, repo: draft.repo, branch: draft.branch }
    return data
  }

  /** 只把当前发送人发起的工单带进上下文，避免跨用户泄漏。 */
  private ticketsForUser(trigger: Trigger): Array<{ id?: string; title?: string; stage?: string; prUrl?: string }> {
    return this.store.listSubscriptions(trigger.threadId)
      .map(subscription => this.store.getTicket(subscription.ticketId))
      .filter((ticket): ticket is Ticket => Boolean(ticket))
      .filter(ticket => this.store.getMandate(ticket.mandateId)?.actorId === trigger.actorId)
      .map(ticket => ({ id: ticket.id, title: ticket.title, stage: ticket.stage, prUrl: ticket.prUrl }))
  }
}

export function buildSystemPrompt(policy: Policy, home?: string): string {
  return [readPrompt('orchestrator.md', home), readPrompt('admission.md', home), policySection(policy)].join('\n\n---\n\n')
}

/** 会话模式：人格 + 职责 + 准入 + 回复规则 + 策略，一次注入后由 session 复用。 */
export function buildUnifiedSystemPrompt(
  policy: Policy,
  soul: string,
  persona?: { name: string; style: string; language: string },
  home?: string,
): string {
  const header = persona
    ? `# 人格设定\n- 名字：${persona.name}\n- 语气：${persona.style}\n- 语言：${persona.language}`
    : ''
  return [
    header,
    soul,
    readPrompt('orchestrator.md', home),
    readPrompt('admission.md', home),
    readPrompt('conversation.md', home),
    policySection(policy),
  ].filter(Boolean).join('\n\n---\n\n')
}

/** 引擎抛异常时的兜底结果：按 unavailable 处理，并留下可审计的记录。 */
function failedResult(triggerId: string, error: unknown): DecisionEngineResult {
  const message = error instanceof Error ? error.message : String(error)
  return {
    unavailableReason: message,
    audit: {
      engine: 'pi',
      triggerId,
      durationMs: 0,
      toolCalls: [],
      tokens: { input: 0, output: 0, total: 0 },
      promptChars: { system: 0, user: 0 },
      unavailableReason: message,
    },
  }
}

/**
 * 给模型看的名单：按生效名单列 open_id，有显示名时写成「名字(ou_xxx)」。
 *
 * 邮箱不喂给模型：模型只需要知道「谁有资格」，邮箱对它没有意义，
 * 而且会把用户的邮箱地址带进上下文与日志链路。
 */
function displayAllowed(policy: Policy): string[] {
  const out: string[] = []
  for (const id of effectiveAllowed(policy)) {
    const name = policy.names?.[id]
    if (name) out.push(`${name}(${id})`)
    else if (!id.includes('@')) out.push(id)
  }
  return out
}

function policySection(policy: Policy): string {
  return `# 当前策略

- 版本：${policy.version}
- accept mode：${policy.acceptMode}（off 不开工 / observe 只记录 / auto 自动接单）
- 并发上限：${policy.maxWorkers}
- 准入表：名单内未 @ → ${policy.admission.listedNotAddressed}；名单外 @ → ${policy.admission.unlistedAddressed}；名单外未 @ → ${policy.admission.unlistedNotAddressed}`
}

function readPrompt(file: string, home?: string): string {
  return readRouterPrompt(home, file)
}

/** 追问话术的 reason：告诉模型缺什么、为什么问。 */
export function clarifyReason(info: ClarifyInfo): string {
  if (info.rejectedRepo) return `用户说的项目「${info.rejectedRepo}」不在已配置的项目清单里，需要请用户重新选择`
  if (info.missing.includes('repo') && info.missing.includes('branch')) return '派工信息不全：缺少项目（repo）与起始分支（branch），需要问清楚后再开工'
  if (info.missing.includes('repo')) return '派工信息不全：缺少项目（repo），需要问清楚后再开工'
  if (info.missing.includes('branch')) return '派工信息不全：缺少起始分支（branch），需要问清楚后再开工'
  return '派工信息不全'
}

/** 模型不可用时的兜底追问：不猜，直接把缺的项和可选项摆出来。 */
export function clarifyFallback(info: ClarifyInfo, projects: Array<{ name: string }> = []): string {
  const names = projects.map(project => project.name)
  if (info.rejectedRepo) {
    return `没有找到项目「${info.rejectedRepo}」${names.length > 0 ? `，可选：${names.slice(0, 5).join('、')}` : ''}。要改哪个项目？`
  }
  const parts: string[] = []
  if (info.missing.includes('repo')) parts.push(names.length > 0 ? `要改哪个项目（${names.slice(0, 5).join('、')}）` : '要改哪个项目')
  if (info.missing.includes('branch')) parts.push('从哪个分支开始')
  return `确认一下再开工：${parts.join('，')}？`
}

export type { Strength }
