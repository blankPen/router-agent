import { mkdirSync } from 'node:fs'
import { extractJsonObject, type LlmConfig } from './llm.js'
import type {
  DecisionAudit,
  DecisionEngine,
  DecisionEngineResult,
  DecisionProposal,
  DecisionRequest,
  DecisionToolCall,
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
  llm: LlmConfig
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

/**
 * 用 Pi SDK 承担「研判 + 工具循环」。
 *
 * 守住方案的五个约束：
 * 1. Gate 在 Pi 之前（AgentLoop 已经过 Gate 才会调用这里）；
 * 2. 工具白名单（router_read / router_ticket / router_decide）；
 * 3. 工具不写库（router_decide 只产出 proposal）；
 * 4. 60s 超时 + token 预算，超时按 unavailable 落库；
 * 5. 审计（prompt、工具序列、proposal、耗时、token）。
 */
export class PiDecisionEngine implements DecisionEngine {
  readonly kind = 'pi' as const
  private llm: LlmConfig
  private toolbox: RouterToolbox
  private agentDir: string
  private cwd: string
  private timeoutMs: number
  private tokenBudget: number
  private sessionFactory: PiSessionFactory

  constructor(opts: PiDecisionEngineOptions) {
    this.llm = opts.llm
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
      model: this.llm.model,
      systemPrompt: req.systemPrompt,
      userPrompt: req.userPrompt,
    }
    const state: AssessState = { proposal: undefined, toolCalls: [] }

    let session: PiSessionLike | null = null
    let unsubscribe: (() => void) | null = null
    let timedOut = false
    let overBudget = false
    let sessionError = ''
    const timer = setTimeout(() => {
      timedOut = true
      void session?.abort().catch(() => {})
    }, this.timeoutMs)
    timer.unref?.()

    try {
      const tools = this.buildTools(req, state)
      session = await this.sessionFactory({
        cwd: this.cwd,
        agentDir: this.agentDir,
        systemPrompt: req.systemPrompt,
        toolNames: [...DECISION_TOOL_NAMES],
        tools,
        apiKey: this.llm.apiKey,
        baseUrl: this.llm.baseUrl,
        model: this.llm.model,
      })

      unsubscribe = session.subscribe(event => {
        if (event.type === 'message_end') {
          const message = event.message
          if (message?.role === 'assistant') {
            const usage = message.usage ?? {}
            const input = Number(usage.input ?? 0)
            const output = Number(usage.output ?? 0)
            const total = Number(usage.totalTokens ?? usage.total ?? input + output)
            audit.tokens.input += Number.isFinite(input) ? input : 0
            audit.tokens.output += Number.isFinite(output) ? output : 0
            audit.tokens.total += Number.isFinite(total) ? total : 0
            if (message.errorMessage) sessionError = message.errorMessage
          }
          if (this.tokenBudget > 0 && audit.tokens.total > this.tokenBudget && !overBudget) {
            overBudget = true
            void session?.abort().catch(() => {})
          }
        }
      })

      await session.prompt(req.userPrompt)
    } catch (error) {
      sessionError = sessionError || (error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
      unsubscribe?.()
      try {
        session?.dispose()
      } catch {
        // dispose 失败不影响已拿到的结果。
      }
      audit.toolCalls = state.toolCalls
    }

    if (timedOut) return this.finish(audit, started, { unavailableReason: `pi:timeout(${this.timeoutMs}ms)` })
    if (overBudget) return this.finish(audit, started, { unavailableReason: `pi:token-budget(${this.tokenBudget})` })
    if (state.proposal) return this.finish(audit, started, { proposal: state.proposal })

    // Pi 没调用工具时的兜底：从最后一条 assistant 文本里提取 JSON 决定。
    const text = lastAssistantText(session?.messages)
    const json = extractJsonObject(text)
    if (json) {
      const parsed = proposalFromJson(json, req.trigger.id, req.strength)
      if (parsed.kind === 'proposal') return this.finish(audit, started, { proposal: parsed.proposal })
      if (parsed.kind === 'unavailable') return this.finish(audit, started, { unavailableReason: parsed.reason })
      return this.finish(audit, started, { unavailableReason: parsed.reason })
    }
    return this.finish(audit, started, {
      unavailableReason: sessionError ? `pi:error:${sessionError}` : 'pi:no-decision',
    })
  }

  private buildTools(req: DecisionRequest, state: AssessState): PiToolDefinition[] {
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
            const outcome = await this.toolbox.call(name, safeJson(args), { triggerId: req.trigger.id })
            const result = outcome.result
            const failed = Boolean(result && typeof result === 'object' && 'error' in (result as Record<string, unknown>))
            state.toolCalls.push({
              name,
              args: argsText,
              ok: !failed,
              ...(failed ? { error: String((result as Record<string, unknown>).error) } : {}),
            })
            return textResult(result)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            state.toolCalls.push({ name, args: argsText, ok: false, error: message })
            return textResult({ error: message })
          }
        },
      }
    })
  }

  private finish(
    audit: DecisionAudit,
    started: number,
    result: { proposal: DecisionProposal } | { unavailableReason: string },
  ): DecisionEngineResult {
    audit.durationMs = Date.now() - started
    if ('proposal' in result) {
      audit.proposal = result.proposal
      return { proposal: result.proposal, audit }
    }
    audit.unavailableReason = result.unavailableReason
    return { unavailableReason: result.unavailableReason, audit }
  }
}

interface AssessState {
  proposal: DecisionProposal | undefined
  toolCalls: DecisionToolCall[]
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
 * 真实 Pi session 装配。动态 import 是为了让单元测试注入假 factory 时不加载 SDK。
 *
 * 隔离策略：
 * - AuthStorage / ModelRegistry / SettingsManager 全部 in-memory，不读写用户 ~/.pi；
 * - DefaultResourceLoader 关闭 extensions / skills / prompts / themes / AGENTS.md，
 *   只注入 Router 自己的 system prompt；
 * - 只放行三个 router_* 工具，禁用 Pi 内置 read/bash/edit/write。
 */
export async function createDefaultPiSession(opts: PiSessionOptions): Promise<PiSessionLike> {
  mkdirSync(opts.agentDir, { recursive: true })
  const pi = await import('@mariozechner/pi-coding-agent')
  const auth = pi.AuthStorage.inMemory()
  auth.setRuntimeApiKey(PROVIDER, opts.apiKey)
  const registry = pi.ModelRegistry.inMemory(auth)
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

  const model = {
    id: opts.model,
    name: opts.model,
    api: 'openai-completions' as const,
    provider: PROVIDER,
    baseUrl: opts.baseUrl,
    reasoning: false,
    input: ['text'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  }
  const { session } = await pi.createAgentSession({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    model: model as never,
    thinkingLevel: 'off',
    authStorage: auth,
    modelRegistry: registry,
    tools: opts.toolNames,
    customTools: opts.tools as never,
    resourceLoader: loader,
    sessionManager: pi.SessionManager.inMemory(),
    settingsManager: settings,
  })
  return session as unknown as PiSessionLike
}
