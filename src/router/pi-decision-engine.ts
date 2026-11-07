import { mkdirSync } from 'node:fs'
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

/** Pi 侧只依赖这几个方法，便于测试时注入假 session。 */
export interface PiSessionLike {
  prompt(text: string): Promise<void>
  subscribe(listener: (event: PiSessionEvent) => void): () => void
  abort(): Promise<void>
  dispose(): void
  readonly messages?: unknown
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
}

const DEFAULT_TIMEOUT_MS = 60_000
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

  constructor(opts: PiDecisionEngineOptions) {
    this.model = opts.model
    this.toolbox = opts.toolbox
    this.agentDir = opts.agentDir
    this.cwd = opts.cwd ?? process.cwd()
    this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
    this.tokenBudget = opts.tokenBudget === undefined ? DEFAULT_TOKEN_BUDGET : Math.max(0, opts.tokenBudget)
    this.sessionFactory = opts.sessionFactory ?? createDefaultPiSession
  }

  async assess(req: DecisionRequest): Promise<DecisionEngineResult> {
    const started = Date.now()
    const audit: DecisionAudit = {
      engine: 'pi',
      triggerId: req.trigger.id,
      durationMs: 0,
      toolCalls: [],
      tokens: { input: 0, output: 0, total: 0 },
      promptChars: { system: req.systemPrompt.length, user: req.userPrompt.length },
      provider: PROVIDER,
      model: this.model.model,
      systemPrompt: req.systemPrompt,
      userPrompt: req.userPrompt,
    }
    const state: ToolState = { proposal: undefined, toolCalls: [] }
    const tools = this.buildTools(req, state)
    const outcome = await this.runSession({
      systemPrompt: req.systemPrompt,
      userPrompt: req.userPrompt,
      toolNames: [...DECISION_TOOL_NAMES],
      tools,
      state,
    })
    audit.toolCalls = state.toolCalls
    audit.tokens = outcome.tokens
    audit.durationMs = Date.now() - started

    if (outcome.timedOut) return this.finish(audit, { unavailableReason: `pi:timeout(${this.timeoutMs}ms)` })
    if (outcome.overBudget) return this.finish(audit, { unavailableReason: `pi:token-budget(${this.tokenBudget})` })

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

  /** 寒暄 / 追问的礼貌回复：同一个 Pi 通道，但不开任何工具。 */
  async reply(req: ReplyRequest): Promise<string> {
    const outcome = await this.runSession({
      systemPrompt: req.systemPrompt,
      userPrompt: req.userPrompt,
      toolNames: [],
      tools: [],
      state: { proposal: undefined, toolCalls: [] },
    })
    if (outcome.timedOut) throw new Error(`pi:timeout(${this.timeoutMs}ms)`)
    if (outcome.overBudget) throw new Error(`pi:token-budget(${this.tokenBudget})`)
    const text = lastAssistantText(outcome.messages).trim()
    if (!text) throw new Error(outcome.error ? `pi:error:${outcome.error}` : 'pi:empty-reply')
    return text
  }

  private async runSession(opts: {
    systemPrompt: string
    userPrompt: string
    toolNames: string[]
    tools: PiToolDefinition[]
    state: ToolState
  }): Promise<SessionOutcome> {
    const tokens: DecisionTokens = { input: 0, output: 0, total: 0 }
    let session: PiSessionLike | null = null
    let unsubscribe: (() => void) | null = null
    let timedOut = false
    let overBudget = false
    let error = ''
    const timer = setTimeout(() => {
      timedOut = true
      void session?.abort().catch(() => {})
    }, this.timeoutMs)
    timer.unref?.()

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
      })

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
        if (this.tokenBudget > 0 && tokens.total > this.tokenBudget && !overBudget) {
          overBudget = true
          void session?.abort().catch(() => {})
        }
      })

      await session.prompt(opts.userPrompt)
    } catch (caught) {
      error = error || (caught instanceof Error ? caught.message : String(caught))
    } finally {
      clearTimeout(timer)
      unsubscribe?.()
      try {
        session?.dispose()
      } catch {
        // dispose 失败不影响已拿到的结果。
      }
    }

    return { messages: session?.messages, tokens, timedOut, overBudget, error }
  }

  private buildTools(req: DecisionRequest, state: ToolState): PiToolDefinition[] {
    return DECISION_TOOL_NAMES.map(name => {
      const spec = toolSpec(name)
      return {
        name: spec.name,
        label: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        execute: async (_toolCallId: string, params: Record<string, unknown>) => {
          const args = params ?? {}
          const argsText = safeJson(args).slice(0, 500)
          try {
            if (name === 'router_decide') {
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
            const ctx = { canMutate: req.canMutate === true }
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
    compaction: { enabled: false },
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
  modelRuntime.registerProvider(PROVIDER, {
    name: 'Router Agent',
    api: 'openai-completions',
    baseUrl: opts.baseUrl,
    models: [
      {
        id: opts.model,
        name: opts.model,
        api: 'openai-completions',
        baseUrl: opts.baseUrl,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
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
    sessionManager: pi.SessionManager.inMemory(),
    settingsManager: settings,
  })
  return session as unknown as PiSessionLike
}