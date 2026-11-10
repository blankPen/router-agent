import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { extractJsonObject, type PiModelConfig } from './model-config.js'
import type {
  DecisionAudit,
  DecisionEngine,
  DecisionEngineResult,
  DecisionProposal,
  DecisionRequest,
  DecisionToolCall,
  DecisionTokens,
  ReplyRequest,
} from './decision-engine.js'
import { proposalFromJson } from './decision-engine.js'
import { DECISION_TOOL_NAMES, toolSpec, type PiToolDefinition } from './tool-spec.js'
import type { RouterToolbox } from './tools.js'
import {
  SessionRegistry,
  type ManagedSessionLike,
  type PersistedSessionRecord,
  type SessionKeyParts,
  type SessionPersistence,
} from './session-registry.js'

/** Pi 侧只依赖这几个方法，便于测试时注入假 session。 */
export interface PiSessionLike extends ManagedSessionLike {
  subscribe(listener: (event: PiSessionEvent) => void): () => void
}

export interface PiSessionEvent {
  type: string
  message?: {
    role?: string
    content?: unknown
    usage?: { input?: number; output?: number; totalTokens?: number; total?: number }
    stopReason?: string
    errorMessage?: string
  }
  toolName?: string
  isError?: boolean
}

export interface PiSessionOptions {
  cwd: string
  agentDir: string
  systemPrompt: string
  toolNames: string[]
  tools: PiToolDefinition[]
  apiKey: string
  baseUrl: string
  model: string
  /** 模型接口协议；默认 openai-completions。 */
  api?: 'openai-completions' | 'anthropic-messages'
  /** anthropic-messages 下把密钥作为 Authorization: Bearer 发送。 */
  authHeader?: boolean
  /** 落盘 SessionManager；不传则 in-memory（旧行为）。 */
  sessionManager?: unknown
  /** 自动压缩配置；不传则关闭。 */
  compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number }
  /** 模型上下文窗口，用于压缩阈值。 */
  contextWindow?: number
}

export type PiSessionFactory = (opts: PiSessionOptions) => Promise<PiSessionLike>

export interface PiDecisionEngineOptions {
  model: PiModelConfig
  toolbox: RouterToolbox
  /** Pi 的独立配置目录（与用户 ~/.pi 隔离），默认 ~/.router-agent/pi。 */
  agentDir: string
  cwd?: string
  /** 每次研判的硬超时，默认 60s。 */
  timeoutMs?: number
  /** 单次研判的 token 预算上限；0 表示不限制。 */
  tokenBudget?: number
  /** 测试注入：默认走真实 Pi SDK。 */
  sessionFactory?: PiSessionFactory
  /** 会话持久化端口；不传则不启用会话复用。 */
  sessionPersistence?: SessionPersistence
  /** session 落盘根目录；启用会话复用时必填。 */
  sessionDir?: string
  /** 空闲回收阈值（毫秒）。 */
  sessionIdleTtlMs?: number
  /** 同时驻留内存的 session 上限。 */
  maxActiveSessions?: number
  /** 带会话的一轮硬超时（含压缩），默认 180s。 */
  sessionTimeoutMs?: number
  /** 会话内 token 预算；0 表示不限制（交给压缩）。 */
  sessionTokenBudget?: number
  /** Pi 自动压缩配置。 */
  compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number }
  /** 模型上下文窗口。 */
  contextWindow?: number
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_SESSION_TIMEOUT_MS = 180_000
const DEFAULT_TOKEN_BUDGET = 32_000
const PROVIDER = 'router-agent'

interface SessionOutcome {
  messages: unknown
  tokens: DecisionTokens
  timedOut: boolean
  overBudget: boolean
  error: string
}

interface ToolState {
  proposal: DecisionProposal | undefined
  toolCalls: DecisionToolCall[]
}

/**
 * 工具闭包读取的可变本轮上下文。
 * 复用 session 后工具只绑定一次，但每轮的 trigger / 权限不同，必须通过 ref 切换。
 */
interface TurnRef {
  request?: DecisionRequest | ReplyRequest
  state: ToolState
}

/**
 * 用 Pi SDK 承担研判与工具循环，也承担寒暄 / 追问的礼貌回复。
 *
 * 守住方案的约束：
 * 1. Gate 在 Pi 之前（AgentLoop 已经过 Gate 才会调用这里）；
 * 2. 工具白名单（读上下文 / 查工单 / 关单 / 回收 workspace / router_decide），回复通道零工具；
 * 3. 写操作只走两个口子：Engine 关单、Effects 回收 workspace；router_decide 仍只产出 proposal；
 * 4. 60s 超时 + token 预算，超时按 unavailable 落库；
 * 5. 审计（prompt、工具序列、proposal、耗时、token）。
 */
export class PiDecisionEngine implements DecisionEngine {
  private model: PiModelConfig
  private toolbox: RouterToolbox
  private agentDir: string
  private cwd: string
  private timeoutMs: number
  private tokenBudget: number
  private sessionFactory: PiSessionFactory
  private sessionPersistence?: SessionPersistence
  private sessionDir?: string
  private sessionTimeoutMs: number
  private sessionTokenBudget: number
  private compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number }
  private contextWindow: number
  private sessions: SessionRegistry<PiSessionLike> | null = null
  /** 实际暴露给模型的工具；没有更新能力时去掉 router_update。 */
  private toolNames: string[]
  /** 复用 session 后，工具闭包通过它读取本轮上下文。 */
  private turnRefs = new WeakMap<object, TurnRef>()

  constructor(opts: PiDecisionEngineOptions) {
    this.model = opts.model
    this.toolbox = opts.toolbox
    this.agentDir = opts.agentDir
    this.cwd = opts.cwd ?? process.cwd()
    this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
    this.tokenBudget = opts.tokenBudget === undefined ? DEFAULT_TOKEN_BUDGET : Math.max(0, opts.tokenBudget)
    this.sessionFactory = opts.sessionFactory ?? createDefaultPiSession
    this.sessionPersistence = opts.sessionPersistence
    this.sessionDir = opts.sessionDir
    this.sessionTimeoutMs = opts.sessionTimeoutMs && opts.sessionTimeoutMs > 0 ? opts.sessionTimeoutMs : DEFAULT_SESSION_TIMEOUT_MS
    this.sessionTokenBudget = opts.sessionTokenBudget === undefined ? 0 : Math.max(0, opts.sessionTokenBudget)
    this.compaction = opts.compaction
    this.contextWindow = opts.contextWindow && opts.contextWindow > 0 ? opts.contextWindow : 128_000
    this.toolNames = DECISION_TOOL_NAMES.filter(name => name !== 'router_update' || opts.toolbox.canUpdate())

    if (opts.sessionPersistence && opts.sessionDir) {
      this.sessions = new SessionRegistry<PiSessionLike>({
        persistence: opts.sessionPersistence,
        create: input => this.createPersistentSession(input),
        idleTtlMs: opts.sessionIdleTtlMs ?? 30 * 60_000,
        maxActive: opts.maxActiveSessions ?? 50,
      })
    }
  }

  async assess(req: DecisionRequest): Promise<DecisionEngineResult> {
    try {
      return req.session && this.sessions ? await this.assessPersistent(req) : await this.assessTransient(req)
    } finally {
      // 更新工具只登记重启意图；本轮结束后再执行，保证「已更新」的回复先进入 outbox。
      this.toolbox.flushRestartRequest()
    }
  }

  /** 寒暄 / 追问的礼貌回复：同一个 Pi 通道，但不开任何工具。 */
  async reply(req: ReplyRequest): Promise<string> {
    if (req.session && this.sessions) return this.replyPersistent(req)

    const outcome = await this.runSession({
      systemPrompt: req.systemPrompt,
      userPrompt: req.userPrompt,
      toolNames: [],
      tools: [],
    })
    if (outcome.timedOut) throw new Error(`pi:timeout(${this.timeoutMs}ms)`)
    if (outcome.overBudget) throw new Error(`pi:token-budget(${this.tokenBudget})`)
    const text = lastAssistantText(outcome.messages).trim()
    if (!text) throw new Error(outcome.error ? `pi:error:${outcome.error}` : 'pi:empty-reply')
    return text
  }

  async resetSession(session: SessionKeyParts, by: string): Promise<void> {
    await this.sessions?.reset(session, by)
  }

  async recordTranscript(session: SessionKeyParts, text: string, systemPrompt: string): Promise<void> {
    if (!this.sessions) return
    await this.sessions.recordTranscript(session, text, systemPrompt)
  }

  async evictIdleSessions(now?: number): Promise<number> {
    return this.sessions ? this.sessions.evictIdle(now) : 0
  }

  async disposeAllSessions(): Promise<void> {
    await this.sessions?.disposeAll()
  }

  private auditOf(req: DecisionRequest | ReplyRequest): DecisionAudit {
    const triggerId = 'trigger' in req ? req.trigger.id : ''
    return {
      engine: 'pi',
      triggerId,
      durationMs: 0,
      toolCalls: [],
      tokens: { input: 0, output: 0, total: 0 },
      promptChars: { system: req.systemPrompt.length, user: req.userPrompt.length },
      provider: PROVIDER,
      model: this.model.model,
      systemPrompt: req.systemPrompt,
      userPrompt: req.userPrompt,
    }
  }

  private assessTransient(req: DecisionRequest): Promise<DecisionEngineResult> {
    const started = Date.now()
    const audit = this.auditOf(req)
    const state: ToolState = { proposal: undefined, toolCalls: [] }
    const turnRef: TurnRef = { request: req, state }
    return this.runSession({
      systemPrompt: req.systemPrompt,
      userPrompt: req.userPrompt,
      toolNames: [...this.toolNames],
      tools: this.buildTools(turnRef),
    }).then(outcome => this.finishAssess(audit, req, state, outcome, started, this.timeoutMs, this.tokenBudget))
  }

  private async assessPersistent(req: DecisionRequest): Promise<DecisionEngineResult> {
    const started = Date.now()
    const audit = this.auditOf(req)
    const state: ToolState = { proposal: undefined, toolCalls: [] }
    const entry = await this.sessions!.acquire(req.session!, req.systemPrompt)
    await this.sessions!.prepare(entry)
    const turnRef = this.turnRefs.get(entry.session)
    if (!turnRef) {
      this.sessions!.drop(entry.parts.key)
      return this.finish(audit, { unavailableReason: 'pi:session-tools-unbound' })
    }
    turnRef.request = req
    turnRef.state = state
    entry.session.setActiveToolsByName?.([...this.toolNames])

    const before = Array.isArray(entry.session.messages) ? entry.session.messages.length : 0
    const outcome = await this.runOnSession(entry.session as PiSessionLike, {
      userPrompt: this.sessions!.pendingPrompt(entry) + req.userPrompt,
      timeoutMs: this.sessionTimeoutMs,
      tokenBudget: this.sessionTokenBudget,
      disposeOnFinish: false,
      messagesBefore: before,
    })
    if (outcome.timedOut || outcome.overBudget) this.sessions!.drop(entry.parts.key)
    else this.sessions!.clearPendingTranscripts(entry)
    return this.finishAssess(audit, req, state, outcome, started, this.sessionTimeoutMs, this.sessionTokenBudget)
  }

  private async replyPersistent(req: ReplyRequest): Promise<string> {
    const entry = await this.sessions!.acquire(req.session!, req.systemPrompt)
    await this.sessions!.prepare(entry)
    const turnRef = this.turnRefs.get(entry.session)
    if (!turnRef) {
      this.sessions!.drop(entry.parts.key)
      throw new Error('pi:session-tools-unbound')
    }
    turnRef.request = req
    turnRef.state = { proposal: undefined, toolCalls: [] }
    entry.session.setActiveToolsByName?.([])

    const before = Array.isArray(entry.session.messages) ? entry.session.messages.length : 0
    const outcome = await this.runOnSession(entry.session as PiSessionLike, {
      userPrompt: this.sessions!.pendingPrompt(entry) + req.userPrompt,
      timeoutMs: this.sessionTimeoutMs,
      tokenBudget: this.sessionTokenBudget,
      disposeOnFinish: false,
      messagesBefore: before,
    })
    if (outcome.timedOut) {
      this.sessions!.drop(entry.parts.key)
      throw new Error(`pi:timeout(${this.sessionTimeoutMs}ms)`)
    }
    if (outcome.overBudget) {
      this.sessions!.drop(entry.parts.key)
      throw new Error(`pi:token-budget(${this.sessionTokenBudget})`)
    }
    this.sessions!.clearPendingTranscripts(entry)
    const text = lastAssistantText(outcome.messages).trim()
    if (!text) throw new Error(outcome.error ? `pi:error:${outcome.error}` : 'pi:empty-reply')
    return text
  }

  private finishAssess(
    audit: DecisionAudit,
    req: DecisionRequest,
    state: ToolState,
    outcome: SessionOutcome,
    started: number,
    timeoutMs: number,
    tokenBudget: number,
  ): DecisionEngineResult {
    audit.toolCalls = state.toolCalls
    audit.tokens = outcome.tokens
    audit.durationMs = Date.now() - started

    if (outcome.timedOut) return this.finish(audit, { unavailableReason: `pi:timeout(${timeoutMs}ms)` })
    if (outcome.overBudget) return this.finish(audit, { unavailableReason: `pi:token-budget(${tokenBudget})` })

    // 查询 / 清理工具执行完后，Pi 的最终文本就是给用户看的答复；
    // 有决定时一并带回，AgentLoop 不必再调用一次回复模型。
    const finalText = lastAssistantText(outcome.messages).trim()
    if (state.proposal) return this.finish(audit, { proposal: state.proposal, ...(finalText ? { reply: finalText } : {}) })

    // Pi 没调用工具时的兜底：从最后一条 assistant 文本里提取 JSON 决定。
    const json = extractJsonObject(finalText)
    if (json) {
      const parsed = proposalFromJson(json, req.trigger.id, req.strength)
      if (parsed.kind === 'proposal') return this.finish(audit, { proposal: parsed.proposal })
      return this.finish(audit, { unavailableReason: parsed.reason })
    }

    // 调用过工具并给出了答复：按 ignore 收口，文本原样回给用户。
    // 工具被拒绝（例如未 @ 的写操作）时同样使用这段文本，避免再说一遍或吞掉解释。
    if (finalText && state.toolCalls.length > 0) {
      return this.finish(audit, {
        proposal: {
          triggerId: req.trigger.id,
          decision: 'ignore',
          strength: req.strength,
          reason: 'ops:tool-reply',
          rules: [],
        },
        reply: finalText,
      })
    }

    return this.finish(audit, {
      unavailableReason: outcome.error ? `pi:error:${outcome.error}` : 'pi:no-decision',
    })
  }

  /** 一次性 session：旧行为，每次新建 + dispose。 */
  private async runSession(opts: {
    systemPrompt: string
    userPrompt: string
    toolNames: string[]
    tools: PiToolDefinition[]
  }): Promise<SessionOutcome> {
    let session: PiSessionLike | null = null
    try {
      session = await this.sessionFactory({
        cwd: this.cwd,
        agentDir: this.agentDir,
        systemPrompt: opts.systemPrompt,
        toolNames: opts.toolNames,
        tools: opts.tools,
        apiKey: this.model.apiKey,
        baseUrl: this.model.baseUrl,
        model: this.model.model,
        api: this.model.api,
        ...(this.model.authHeader !== undefined ? { authHeader: this.model.authHeader } : {}),
        compaction: this.compaction,
        contextWindow: this.contextWindow,
      })
    } catch (caught) {
      return {
        messages: undefined,
        tokens: { input: 0, output: 0, total: 0 },
        timedOut: false,
        overBudget: false,
        error: caught instanceof Error ? caught.message : String(caught),
      }
    }
    return this.runOnSession(session, {
      userPrompt: opts.userPrompt,
      timeoutMs: this.timeoutMs,
      tokenBudget: this.tokenBudget,
      disposeOnFinish: true,
    })
  }

  /** 在已有 session 上跑一轮；是否 dispose 由调用方决定。 */
  private async runOnSession(
    session: PiSessionLike,
    opts: { userPrompt: string; timeoutMs: number; tokenBudget: number; disposeOnFinish: boolean; messagesBefore?: number },
  ): Promise<SessionOutcome> {
    const tokens: DecisionTokens = { input: 0, output: 0, total: 0 }
    let unsubscribe: (() => void) | null = null
    let timedOut = false
    let overBudget = false
    let error = ''
    const timer = setTimeout(() => {
      timedOut = true
      void session.abort().catch(() => {})
    }, opts.timeoutMs)
    timer.unref?.()

    try {
      unsubscribe = session.subscribe(event => {
        if (event.type !== 'message_end') return
        const message = event.message
        if (message?.role === 'assistant') {
          const usage = message.usage ?? {}
          const input = Number(usage.input ?? 0)
          const output = Number(usage.output ?? 0)
          const total = Number(usage.totalTokens ?? usage.total ?? input + output)
          tokens.input += Number.isFinite(input) ? input : 0
          tokens.output += Number.isFinite(output) ? output : 0
          tokens.total += Number.isFinite(total) ? total : 0
          if (message.errorMessage) error = message.errorMessage
        }
        if (opts.tokenBudget > 0 && tokens.total > opts.tokenBudget && !overBudget) {
          overBudget = true
          void session.abort().catch(() => {})
        }
      })

      await session.prompt(opts.userPrompt)
    } catch (caught) {
      error = error || (caught instanceof Error ? caught.message : String(caught))
    } finally {
      clearTimeout(timer)
      unsubscribe?.()
      if (opts.disposeOnFinish) {
        try {
          session.dispose()
        } catch {
          // dispose 失败不影响已拿到的结果。
        }
      }
    }

    const messages = Array.isArray(session.messages) && opts.messagesBefore !== undefined
      ? session.messages.slice(opts.messagesBefore)
      : session.messages
    return { messages, tokens, timedOut, overBudget, error }
  }

  private buildTools(turnRef: TurnRef): PiToolDefinition[] {
    return this.toolNames.map(name => {
      const spec = toolSpec(name)
      return {
        name: spec.name,
        label: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          const req = turnRef.request
          const state = turnRef.state
          if (!req) return textResult({ error: 'pi:no-turn-context' })
          const args = params ?? {}
          const argsText = safeJson(args).slice(0, 500)
          try {
            if (name === 'router_decide') {
              if (!('trigger' in req)) return textResult({ error: 'pi:not-in-assess-mode' })
              const outcome = this.toolbox.propose(args, { strength: req.strength, triggerId: req.trigger.id })
              if ('error' in outcome) {
                state.toolCalls.push({ name, args: argsText, ok: false, error: outcome.error })
                return textResult({ error: outcome.error })
              }
              state.proposal = outcome.proposal
              state.toolCalls.push({ name, args: argsText, ok: true })
              return textResult({
                accepted: true,
                decision: outcome.proposal.decision,
                proposal: outcome.proposal,
              })
            }
            const ctx = { canMutate: 'canMutate' in req && req.canMutate === true }
            let result: unknown
            switch (name) {
              case 'router_read':
                result = this.toolbox.read(args)
                break
              case 'router_ticket_list':
                result = this.toolbox.list(args)
                break
              case 'router_ticket_progress':
                result = this.toolbox.progress(args)
                break
              case 'router_ticket_close':
                result = this.toolbox.close(args, ctx)
                break
              case 'router_workspace_remove':
                result = this.toolbox.removeWorkspace(args, ctx)
                break
              case 'router_update':
                result = await this.toolbox.update(args, ctx)
                break
              default:
                result = this.toolbox.ticket(args)
            }
            const failed = Boolean(result && typeof result === 'object' && 'error' in (result as Record<string, unknown>))
            state.toolCalls.push({
              name,
              args: argsText,
              ok: !failed,
              ...(failed ? { error: String((result as Record<string, unknown>).error) } : {}),
            })
            return textResult(result)
          } catch (caught) {
            const message = caught instanceof Error ? caught.message : String(caught)
            state.toolCalls.push({ name, args: argsText, ok: false, error: message })
            return textResult({ error: message })
          }
        },
      }
    })
  }

  /** 打开/新建落盘 session，并绑定本轮可变的工具上下文。 */
  private async createPersistentSession(input: {
    parts: SessionKeyParts
    systemPrompt: string
  }): Promise<{ session: PiSessionLike; file: string }> {
    if (!this.sessionPersistence || !this.sessionDir) throw new Error('pi:session-not-configured')
    const pi = await import('@earendil-works/pi-coding-agent')
    const dir = join(this.sessionDir, safeSegment(input.parts.chatId), safeSegment(input.parts.actorId))
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const record: PersistedSessionRecord | null = this.sessionPersistence.get(input.parts.key)
    const hasFile = Boolean(record?.sessionFile && existsSync(record.sessionFile))
    const manager = hasFile
      ? pi.SessionManager.open(record!.sessionFile, dir)
      : pi.SessionManager.create(this.cwd, dir)
    const file = manager.getSessionFile()
    if (!file) throw new Error('pi:session-file-missing')
    if (!hasFile && record) {
      // 记录还在但文件被删了：先把旧行标记 superseded；新记录由 SessionRegistry 统一保存。
      this.sessionPersistence.markSuperseded(input.parts.key, new Date().toISOString(), 'system:missing-file')
    }

    const turnRef: TurnRef = { state: { proposal: undefined, toolCalls: [] } }
    const session = await this.sessionFactory({
      cwd: this.cwd,
      agentDir: this.agentDir,
      systemPrompt: input.systemPrompt,
      toolNames: [...this.toolNames],
      tools: this.buildTools(turnRef),
      apiKey: this.model.apiKey,
      baseUrl: this.model.baseUrl,
      model: this.model.model,
      api: this.model.api,
      ...(this.model.authHeader !== undefined ? { authHeader: this.model.authHeader } : {}),
      sessionManager: manager,
      compaction: this.compaction,
      contextWindow: this.contextWindow,
    })
    this.turnRefs.set(session, turnRef)
    return { session, file }
  }

  private finish(
    audit: DecisionAudit,
    result: { proposal: DecisionProposal; reply?: string } | { unavailableReason: string },
  ): DecisionEngineResult {
    if ('proposal' in result) {
      audit.proposal = result.proposal
      return { proposal: result.proposal, ...(result.reply ? { reply: result.reply } : {}), audit }
    }
    audit.unavailableReason = result.unavailableReason
    return { unavailableReason: result.unavailableReason, audit }
  }
}

function textResult(value: unknown): { content: { type: 'text'; text: string }[]; details: Record<string, unknown> } {
  return { content: [{ type: 'text', text: safeJson(value) }], details: {} }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 会话 key 里的飞书 id 只保留安全字符，避免目录穿越。 */
function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120)
  return safe || 'unknown'
}

function lastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string; content?: unknown } | undefined
    if (message?.role !== 'assistant') continue
    if (typeof message.content === 'string') return message.content
    if (Array.isArray(message.content)) {
      return message.content
        .filter((block): block is { type: string; text?: string } => Boolean(block) && typeof block === 'object' && (block as { type?: string }).type === 'text')
        .map(block => String(block.text ?? ''))
        .join('\n')
    }
  }
  return ''
}

/**
 * 真实 Pi session 装配。动态 import 让单元测试注入假 factory 时不加载 SDK。
 *
 * 隔离策略：
 * - ModelRuntime 不读 models.json，凭证用空的内存实现；API key 只通过
 *   setRuntimeApiKey 注入内存，不读写用户 ~/.pi，也不落盘；
 * - SettingsManager 全部 in-memory；
 * - DefaultResourceLoader 关闭 extensions / skills / prompts / themes / AGENTS.md，
 *   只注入 Router 自己的 system prompt；
 * - 研判只放行 Router 自己的 router_* 工具；回复通道工具为空。
 */
export async function createDefaultPiSession(opts: PiSessionOptions): Promise<PiSessionLike> {
  mkdirSync(opts.agentDir, { recursive: true })
  const pi = await import('@earendil-works/pi-coding-agent')
  const settings = pi.SettingsManager.inMemory({
    compaction: opts.compaction ?? { enabled: false },
    retry: { enabled: false },
  } as never)
  const loader = new pi.DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => opts.systemPrompt,
    appendSystemPromptOverride: () => [],
  })
  await loader.reload()

  // pi 1.x 把模型/凭证收敛到 ModelRuntime：先注册 OpenAI 兼容 provider，
  // 再把 API key 作为运行时凭证注入，最后从 runtime 里取回组装好的 model 给 session 使用。
  // 凭证存储用空的内存实现，pi 不会读写任何 auth.json。
  const modelRuntime = await pi.ModelRuntime.create({
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async (_providerId: string, fn: (current: unknown) => Promise<unknown>) => fn(undefined),
      delete: async () => {},
    } as never,
    modelsPath: null,
    refreshOnCreate: false,
  })
  const api = opts.api ?? 'openai-completions'
  modelRuntime.registerProvider(PROVIDER, {
    name: 'Router Agent',
    api,
    baseUrl: opts.baseUrl,
    ...(opts.authHeader ? { authHeader: true } : {}),
    models: [
      {
        id: opts.model,
        name: opts.model,
        api,
        baseUrl: opts.baseUrl,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: opts.contextWindow && opts.contextWindow > 0 ? opts.contextWindow : 128_000,
        maxTokens: 8_192,
      },
    ],
  })
  await modelRuntime.setRuntimeApiKey(PROVIDER, opts.apiKey)
  const model = modelRuntime.getModel(PROVIDER, opts.model)
  if (!model) throw new Error(`pi:model-not-found(${PROVIDER}/${opts.model})`)

  const { session } = await pi.createAgentSession({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    model: model as never,
    modelRuntime,
    thinkingLevel: 'off',
    tools: opts.toolNames,
    customTools: opts.tools as never,
    resourceLoader: loader,
    sessionManager: (opts.sessionManager as never) ?? pi.SessionManager.inMemory(),
    settingsManager: settings,
  })
  return session as unknown as PiSessionLike
}