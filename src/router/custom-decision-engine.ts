import { extractJsonObject, type LlmClient, type LlmCompleteRequest, type LlmMessage, type LlmResponse } from './llm.js'
import type {
  DecisionAudit,
  DecisionEngine,
  DecisionEngineResult,
  DecisionProposal,
  DecisionRequest,
} from './decision-engine.js'
import { proposalFromJson } from './decision-engine.js'
import { ROUTER_TOOLS, type RouterToolbox } from './tools.js'

export interface CustomDecisionEngineOptions {
  /** 直接给客户端，或给一个 getter（AgentLoop 允许运行期替换 loop.llm）。 */
  llm: LlmClient | (() => LlmClient)
  toolbox: RouterToolbox
  maxToolRounds?: number
  /** 单次 LLM 调用超时；超时按 unavailable 落库，避免拖住 runCycle。 */
  timeoutMs?: number
  /** 单次研判 token 预算；0 表示不限制。 */
  tokenBudget?: number
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_TOKEN_BUDGET = 32_000

/**
 * 自研研判引擎：把原来的「LLM + 工具循环」从 AgentLoop 搬出来。
 * 除 router_subscribe 外只读；router_decide 只产出 proposal，不写库。
 */
export class CustomDecisionEngine implements DecisionEngine {
  readonly kind = 'custom' as const
  private resolveLlm: () => LlmClient
  private toolbox: RouterToolbox
  private maxToolRounds: number
  private timeoutMs: number
  private tokenBudget: number

  constructor(opts: CustomDecisionEngineOptions) {
    this.resolveLlm = typeof opts.llm === 'function' ? opts.llm : () => opts.llm as LlmClient
    this.toolbox = opts.toolbox
    this.maxToolRounds = opts.maxToolRounds ?? 3
    this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
    this.tokenBudget = opts.tokenBudget === undefined ? DEFAULT_TOKEN_BUDGET : Math.max(0, opts.tokenBudget)
  }

  async assess(req: DecisionRequest): Promise<DecisionEngineResult> {
    const started = Date.now()
    const audit: DecisionAudit = {
      engine: 'custom',
      triggerId: req.trigger.id,
      durationMs: 0,
      toolCalls: [],
      tokens: { input: 0, output: 0, total: 0 },
      promptChars: { system: req.systemPrompt.length, user: req.userPrompt.length },
      systemPrompt: req.systemPrompt,
      userPrompt: req.userPrompt,
    }
    const messages: LlmMessage[] = [
      { role: 'system', content: req.systemPrompt },
      { role: 'user', content: req.userPrompt },
    ]
    let proposal: DecisionProposal | undefined

    try {
      for (let round = 0; round < this.maxToolRounds; round += 1) {
        const res = await completeWithTimeout(this.resolveLlm(), { messages, tools: ROUTER_TOOLS }, this.timeoutMs)
        if (res.usage) {
          audit.tokens.input += res.usage.input
          audit.tokens.output += res.usage.output
          audit.tokens.total += res.usage.total
          if (this.tokenBudget > 0 && audit.tokens.total > this.tokenBudget) {
            return this.finish(audit, started, { unavailableReason: `custom:token-budget(${this.tokenBudget})` })
          }
        }
        if (res.toolCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: res.content,
            tool_calls: res.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })),
          })
          for (const call of res.toolCalls) {
            const outcome = await this.toolbox.call(call.name, call.arguments, { strength: req.strength, triggerId: req.trigger.id })
            audit.toolCalls.push({
              name: call.name,
              args: call.arguments.slice(0, 500),
              ok: Boolean(outcome.result && typeof outcome.result === 'object' && !(outcome.result as Record<string, unknown>).error),
              ...(outcome.result && typeof outcome.result === 'object' && (outcome.result as Record<string, unknown>).error
                ? { error: String((outcome.result as Record<string, unknown>).error) }
                : {}),
            })
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(outcome.result) })
            if (call.name === 'router_decide' && outcome.result && typeof outcome.result === 'object' && !('error' in (outcome.result as Record<string, unknown>))) {
              proposal = outcome.result as DecisionProposal
            }
          }
          if (proposal) {
            return this.finish(audit, started, { proposal })
          }
          continue
        }

        const json = extractJsonObject(res.content)
        if (!json) return this.finish(audit, started, { unavailableReason: '模型未给出可解析的决定' })
        const parsed = proposalFromJson(json, req.trigger.id, req.strength)
        if (parsed.kind === 'proposal') return this.finish(audit, started, { proposal: parsed.proposal })
        if (parsed.kind === 'unavailable') return this.finish(audit, started, { unavailableReason: parsed.reason })
        return this.finish(audit, started, { unavailableReason: parsed.reason })
      }
      return this.finish(audit, started, { unavailableReason: '工具调用轮次耗尽' })
    } catch (error) {
      return this.finish(audit, started, {
        unavailableReason: error instanceof Error ? error.message : String(error),
      })
    }
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

/** 给单次 LLM 调用加硬超时；即使客户端忽略 signal，Promise.race 也能解除阻塞。 */
async function completeWithTimeout(llm: LlmClient, req: LlmCompleteRequest, timeoutMs: number): Promise<LlmResponse> {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`custom:timeout(${timeoutMs}ms)`))
    }, timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([llm.complete({ ...req, signal: controller.signal }), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
