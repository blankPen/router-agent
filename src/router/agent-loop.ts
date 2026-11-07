import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Store } from '../store/db.js'
import type { Clock, Engine } from '../core/engine.js'
import { gate, type Policy } from '../core/policy.js'
import type { SourceKind, Strength, Ticket, Trigger } from '../core/model.js'
import { deriveTitle } from '../core/engine.js'
import { extractJsonObject, type LlmClient, type LlmMessage, type LlmToolSchema } from './llm.js'
import { ROUTER_TOOLS, RouterToolbox } from './tools.js'
import { activeDraft, resolveDispatch, type DispatchMissing, type DispatchSettings } from './dispatch.js'

export interface AgentLoopOptions {
  engine: Engine
  llm: LlmClient
  clock?: Clock
  /** 聚合窗口：只处理比 now - batchWindowMs 更早的消息。 */
  batchWindowMs?: number
  source?: SourceKind
  maxToolRounds?: number
  toolbox?: RouterToolbox
  systemPrompt?: string
  /** 多项目 / 多分支派工设置；不传则不校验 repo/branch（兼容旧测试与嵌入用法）。 */
  dispatch?: DispatchSettings
}

export interface ClarifyInfo {
  missing: DispatchMissing[]
  repo: string
  branch: string
  rejectedRepo?: string
  rejectedBranch?: string
  /** 尚未开工的原始请求，多轮补齐时保持不变。 */
  task: string
}

export interface AssessResult {
  outcome: 'accept' | 'ignore' | 'unavailable' | 'clarify'
  ticket?: Ticket
  clarify?: ClarifyInfo
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
const THREAD_INTRO = (title: string, id: string) => `工单 ${id}「${title}」已开始执行。后续进展会在这个话题里更新。`
const ACK_TEXT = (title: string, id: string) => `好的，我帮你创建了工单 ${id}「${title}」。执行进展我会在本话题里同步。`

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
  llm: LlmClient
  private store: Store
  private clock: Clock
  private batchWindowMs: number
  private source?: SourceKind
  private maxToolRounds: number
  private toolbox: RouterToolbox
  private systemPrompt: string
  private conversationPrompt: string
  private dispatch?: DispatchSettings

  constructor(opts: AgentLoopOptions) {
    this.engine = opts.engine
    this.llm = opts.llm
    this.store = opts.engine.store
    this.clock = opts.clock ?? { now: () => new Date().toISOString() }
    this.batchWindowMs = opts.batchWindowMs ?? 8000
    this.source = opts.source
    this.maxToolRounds = opts.maxToolRounds ?? 3
    this.systemPrompt = opts.systemPrompt ?? buildSystemPrompt(opts.engine.policy())
    this.conversationPrompt = readPrompt('conversation.md')
    this.dispatch = opts.dispatch
    this.toolbox = opts.toolbox ?? new RouterToolbox({ engine: opts.engine, store: this.store, clock: this.clock, dispatch: opts.dispatch })
  }

  setPolicy(policy: Policy): void {
    this.engine.updatePolicy(policy)
    this.systemPrompt = buildSystemPrompt(policy)
  }

  async tick(): Promise<TickResult> {
    const now = this.clock.now()
    const cutoff = new Date(new Date(now).getTime() - this.batchWindowMs).toISOString()
    const result: TickResult = { accepted: [], ignored: 0, unavailable: 0, replied: 0, fannedOut: 0 }

    const pending = this.store.claimPendingTriggers(cutoff).filter(t => !this.source || t.source === this.source)
    for (const trigger of pending) {
      try {
        await this.handle(trigger, result)
      } catch {
        // 单条失败不影响同批其它消息；未落决定的会在 finally 里放回队列。
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
      // 订阅扇出优先：已订阅线程的消息不经过研判。
      if (this.hasLiveSubscription(trigger.threadId)) {
        const delivered = this.engine.fanOut(trigger.id)
        if (delivered.length > 0) {
          result.fannedOut += delivered.length
          return
        }
      }

      const verdict = gate(trigger, this.engine.policy())
      if (verdict.action === 'ignore') {
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
        if (trigger.addressed !== 'none') {
          this.reply(trigger, MEDIA_ONLY_TEXT, `media:${trigger.id}`)
          result.replied += 1
        }
        return
      }
      if (verdict.action === 'reply-only') {
        this.replyOnly(trigger, verdict.reason)
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

  /** 落地研判结果：接单则发 ack + 开话题；没接单且消息是在找它说话时，礼貌回一句。 */
  private async applyAssess(trigger: Trigger, assessed: AssessResult, result: TickResult, strength: Strength): Promise<void> {
    if (assessed.outcome === 'accept' && assessed.ticket) {
      // 派工信息已经凑齐并开单，草稿使命结束。
      this.store.clearDispatchDraft(trigger.chatId)
      result.accepted.push(assessed.ticket)
      this.reply(trigger, ACK_TEXT(assessed.ticket.title, assessed.ticket.id), `ack:${assessed.ticket.id}`)
      // 用话题把后续 worker 进展挂在原消息下。
      this.reply(trigger, THREAD_INTRO(assessed.ticket.title, assessed.ticket.id), `thread:${assessed.ticket.id}`, { thread: true })
      return
    }
    if (assessed.outcome === 'clarify' && assessed.clarify) {
      const info = assessed.clarify
      // 只对确实在跟它说话的消息追问，避免群里刷屏。
      if (trigger.addressed === 'none') {
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
          ...(info.rejectedBranch ? { rejected_branch: info.rejectedBranch } : {}),
          resolved_repo: info.repo,
          resolved_branch: info.branch,
        },
        projects: (this.dispatch?.projects ?? []).map(project => ({
          name: project.name,
          defaultBranch: project.defaultBranch,
          branches: project.branches,
        })),
        draft: { task: info.task },
      }, clarifyFallback(info, this.dispatch?.projects))
      result.replied += 1
      return
    }
    if (assessed.outcome === 'unavailable') {
      result.unavailable += 1
      if (trigger.addressed !== 'none') {
        await this.converse(trigger, '暂时没判断出来这条消息要做什么')
        result.replied += 1
      }
      return
    }
    result.ignored += 1
    // 只有当消息确实是在跟它说话（@ 或私聊）时才回复，避免群聊刷屏。
    if (trigger.addressed !== 'none') {
      await this.converse(trigger, 'Router 判断这不是可执行的工作请求')
      result.replied += 1
    }
  }

  /** 让模型组织一句礼貌回复（普通消息，不进话题）。失败时退回固定话术。 */
  async converse(trigger: Trigger, reason: string, extra: Record<string, unknown> = {}, fallback: string = SMALL_TALK_FALLBACK): Promise<string> {
    let text = ''
    try {
      const res = await this.llm.complete({
        messages: [
          { role: 'system', content: this.systemPromptFor(trigger, this.conversationPrompt) },
          { role: 'user', content: JSON.stringify({ message: trigger.text, addressed: trigger.addressed, reason, ...extra }) },
        ],
      })
      text = (res.content ?? '').trim()
    } catch {
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

  /** 单条候选的研判。返回实际落地的决定与工单。 */
  async assess(trigger: Trigger, strength: Strength = 'inferred'): Promise<AssessResult> {
    const messages: LlmMessage[] = [
      { role: 'system', content: this.systemPromptFor(trigger) },
      { role: 'user', content: this.contextPrompt(trigger) },
    ]

    try {
      for (let round = 0; round < this.maxToolRounds; round += 1) {
        const res = await this.llm.complete({ messages, tools: ROUTER_TOOLS })
        if (res.toolCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: res.content,
            tool_calls: res.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })),
          })
          let applied: AssessResult | null = null
          for (const call of res.toolCalls) {
            const outcome = await this.toolbox.call(call.name, call.arguments, { strength })
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(outcome.result) })
            if (call.name === 'router_decide') {
              const raw = outcome.result as Record<string, unknown>
              if (raw.error === 'dispatch:needs-info') return this.clarifyFrom(trigger, raw)
              if (raw.error) return this.markUnavailable(trigger, String(raw.error))
              const decision = String(raw.decision ?? '')
              const ticketId = raw.ticket_id ? String(raw.ticket_id) : ''
              applied = {
                outcome: decision === 'accept' ? 'accept' : decision === 'unavailable' ? 'unavailable' : 'ignore',
                ...(ticketId ? { ticket: this.store.getTicket(ticketId) ?? undefined } : {}),
              }
            }
          }
          if (applied) return applied
          continue
        }

        const json = extractJsonObject(res.content)
        if (!json) return this.markUnavailable(trigger, '模型未给出可解析的决定')
        return this.applyDecision(trigger, json, strength)
      }
      return this.markUnavailable(trigger, '工具调用轮次耗尽')
    } catch (error) {
      return this.markUnavailable(trigger, error instanceof Error ? error.message : String(error))
    }
  }

  private applyDecision(trigger: Trigger, json: Record<string, unknown>, strength: Strength): AssessResult {
    const decision = String(json.decision ?? '')
    if (!['accept', 'stop', 'ignore', 'unavailable'].includes(decision)) {
      return this.markUnavailable(trigger, `非法决定：${decision || '(空)'}`)
    }
    if (decision === 'unavailable') return this.markUnavailable(trigger, String(json.reason ?? '模型判定未完成'))

    let repo = json.repo === undefined ? '' : String(json.repo).trim()
    let branch = json.branch === undefined ? '' : String(json.branch).trim()
    if (decision === 'accept' && this.dispatch) {
      const draft = activeDraft(this.store, trigger.chatId, trigger.actorId, this.clock.now())
      const resolution = resolveDispatch({ settings: this.dispatch, chatId: trigger.chatId, draft, repo, branch })
      if (resolution.missing.length > 0 || resolution.rejectedRepo || resolution.rejectedBranch) {
        return {
          outcome: 'clarify',
          clarify: {
            missing: resolution.missing,
            repo: resolution.repo,
            branch: resolution.branch,
            ...(resolution.rejectedRepo ? { rejectedRepo: resolution.rejectedRepo } : {}),
            ...(resolution.rejectedBranch ? { rejectedBranch: resolution.rejectedBranch } : {}),
            task: draft?.task ?? trigger.text,
          },
        }
      }
      repo = resolution.repo
      branch = resolution.branch
    }

    const outcome = this.engine.decide({
      triggerId: trigger.id,
      decision: decision as never,
      strength,
      reason: String(json.reason ?? ''),
      ...(json.title === undefined ? {} : { title: String(json.title) }),
      ...(json.scope === undefined ? {} : { scope: String(json.scope) }),
      ...(repo ? { repo } : {}),
      ...(branch ? { branch } : {}),
      rules: Array.isArray(json.rules) ? json.rules.map(String) : [],
    })
    return outcome.decision.decision === 'accept' && outcome.ticket
      ? { outcome: 'accept', ticket: outcome.ticket }
      : { outcome: 'ignore' }
  }

  /** 工具层判定缺派工信息：把已解析到的部分转成追问结果。 */
  private clarifyFrom(trigger: Trigger, raw: Record<string, unknown>): AssessResult {
    const missing = Array.isArray(raw.missing)
      ? (raw.missing.map(String).filter(value => value === 'repo' || value === 'branch') as DispatchMissing[])
      : []
    return {
      outcome: 'clarify',
      clarify: {
        missing,
        repo: String(raw.repo ?? ''),
        branch: String(raw.branch ?? ''),
        ...(raw.rejected_repo ? { rejectedRepo: String(raw.rejected_repo) } : {}),
        ...(raw.rejected_branch ? { rejectedBranch: String(raw.rejected_branch) } : {}),
        task: String(raw.draft_task ?? trigger.text),
      },
    }
  }

  private markUnavailable(trigger: Trigger, reason: string): AssessResult {
    try {
      this.engine.decide({ triggerId: trigger.id, decision: 'unavailable', strength: 'inferred', reason })
    } catch {
      // Trigger 已被处理时忽略。
    }
    return { outcome: 'unavailable' }
  }

  private replyOnly(trigger: Trigger, reason: string): void {
    this.reply(trigger, REPLY_ONLY_TEXT, `replyonly:${trigger.id}`)
    this.engine.decide({ triggerId: trigger.id, decision: 'ignore', strength: 'inferred', reason })
  }

  /** 回一句到原会话；key 保证同一件事只发一次。 */
  /** thread=true 时用话题回复（挂到原消息下）；否则发普通消息。 */
  private reply(trigger: Trigger, text: string, key: string, opts: { thread?: boolean } = {}): void {
    const rootId = opts.thread ? (trigger.threadId.split(':').at(-1) ?? '') : ''
    this.store.enqueueOutbox({
      id: `ob_${key.replace(/[^a-zA-Z0-9:_-]/g, '_')}`,
      key,
      channelKind: trigger.source,
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
      return Boolean(ticket && ticket.stage !== 'closed')
    })
  }

  private contextPrompt(trigger: Trigger): string {
    const thread = this.store.listTriggersByThread(trigger.threadId, 10)
    const tickets = this.store.listSubscriptions(trigger.threadId).map(s => this.store.getTicket(s.ticketId)).filter(Boolean)
    const policy = this.engine.policy()
    return JSON.stringify({
      policy: {
        version: policy.version,
        acceptMode: policy.acceptMode,
        allowed: policy.allowed,
        admission: policy.admission,
      },
      // 会话级上下文（群绑定 / 可选项目 / 草稿）统一放在 system prompt 的「当前会话」段。
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
      thread: thread.map(t => ({ id: t.id, actor: t.actorId, text: t.text, at: t.receivedAt })),
      tickets: tickets.map(t => ({ id: t?.id, title: t?.title, stage: t?.stage, prUrl: t?.prUrl })),
    }, null, 2)
  }
}

export function buildSystemPrompt(policy: Policy): string {
  return [readPrompt('orchestrator.md'), readPrompt('admission.md'), policySection(policy)].join('\n\n---\n\n')
}

function policySection(policy: Policy): string {
  return `# 当前策略

- 版本：${policy.version}
- accept mode：${policy.acceptMode}（off 不开工 / observe 只记录 / auto 自动接单）
- 并发上限：${policy.maxWorkers}
- 准入表：名单内未 @ → ${policy.admission.listedNotAddressed}；名单外 @ → ${policy.admission.unlistedAddressed}；名单外未 @ → ${policy.admission.unlistedNotAddressed}`
}

function readPrompt(file: string): string {
  return readFileSync(fileURLToPath(new URL(`./prompts/${file}`, import.meta.url)), 'utf8')
}

/** 追问话术的 reason：告诉模型缺什么、为什么问。 */
export function clarifyReason(info: ClarifyInfo): string {
  if (info.rejectedRepo) return `用户说的项目「${info.rejectedRepo}」不在已配置的项目清单里，需要请用户重新选择`
  if (info.rejectedBranch) return `用户说的分支「${info.rejectedBranch}」不在允许的起始分支里，需要请用户重新选择`
  if (info.missing.includes('repo') && info.missing.includes('branch')) return '派工信息不全：缺少项目（repo）与起始分支（branch），需要问清楚后再开工'
  if (info.missing.includes('repo')) return '派工信息不全：缺少项目（repo），需要问清楚后再开工'
  if (info.missing.includes('branch')) return '派工信息不全：缺少起始分支（branch），需要问清楚后再开工'
  return '派工信息不全'
}

/** 模型不可用时的兜底追问：不猜，直接把缺的项和可选项摆出来。 */
export function clarifyFallback(info: ClarifyInfo, projects: Array<{ name: string; branches: string[] }> = []): string {
  const names = projects.map(project => project.name)
  if (info.rejectedRepo) {
    return `没有找到项目「${info.rejectedRepo}」${names.length > 0 ? `，可选：${names.slice(0, 5).join('、')}` : ''}。要改哪个项目？`
  }
  if (info.rejectedBranch) {
    const branches = projects.flatMap(project => project.branches)
    return `分支「${info.rejectedBranch}」不在允许范围${branches.length > 0 ? `（${[...new Set(branches)].slice(0, 5).join('、')}）` : ''}，从哪个分支开始？`
  }
  const parts: string[] = []
  if (info.missing.includes('repo')) parts.push(names.length > 0 ? `要改哪个项目（${names.slice(0, 5).join('、')}）` : '要改哪个项目')
  if (info.missing.includes('branch')) parts.push('从哪个分支开始')
  return `确认一下再开工：${parts.join('，')}？`
}

export type { Strength, LlmToolSchema }
