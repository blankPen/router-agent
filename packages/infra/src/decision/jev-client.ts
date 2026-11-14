/**
 * TypeSafe Jev 决策客户端。
 *
 * Jev 是 TypeSafe 的决策模型：一次请求带 `state` 与多个 `questions`，
 * 返回每个问题的 0~1 判定（noul）或档位分数（score）。
 * 密钥与模型从环境读取（TYPESAFE_API_KEY / TYPESAFE_MODEL，见 src/config.ts），
 * 本模块只接收注入的配置，不直接读环境，保证可测试。
 */
import { errorMessage } from '../logger.js'

export interface JevConfig {
  apiKey: string
  model: string
  /** 缺省用官方端点，可指向代理 / 镜像绕过区域限制。 */
  baseUrl?: string
}

export interface JevQuestion {
  type: 'noul' | 'score'
  instructions: string
  /** score 档位（0..N-1 的下标）；用于把分数归一化到 0~1。 */
  criteria?: string[]
}

/** 每个问题的答案（已归一化到 0~1）。 */
export type JevAnswers = Record<string, number>

/** 一次模型调用的 token 用量。 */
export interface JevUsage {
  input: number
  output: number
  total: number
}

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const DEFAULT_TIMEOUT_MS = 5_000

export interface JevClientDeps {
  /** 测试注入；缺省用全局 fetch。 */
  fetch?: typeof fetch
  timeoutMs?: number
}

/** 请求失败原因分类，供上层决定降级策略。 */
export type JevErrorKind = 'http' | 'timeout' | 'malformed' | 'network'

export class JevError extends Error {
  constructor(readonly kind: JevErrorKind, message: string) {
    super(message)
    this.name = 'JevError'
  }
}

export class JevClient {
  private apiKey: string
  private model: string
  private baseUrl: string
  private timeoutMs: number
  private fetchImpl: typeof fetch

  constructor(config: JevConfig, deps: JevClientDeps = {}) {
    this.apiKey = config.apiKey
    this.model = config.model
    this.baseUrl = config.baseUrl ?? JEV_ENDPOINT
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = deps.fetch ?? fetch
  }

  async ask(state: unknown, questions: Record<string, JevQuestion>): Promise<JevAnswers> {
    return (await this.askWithUsage(state, questions)).answers
  }

  /** 同 ask，但一并返回 token 用量；预算闸门按它计费。 */
  async askWithUsage(
    state: unknown,
    questions: Record<string, JevQuestion>,
  ): Promise<{ answers: JevAnswers; usage: JevUsage }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const body = JSON.stringify({ model: this.model, state, questions })
    try {
      const res = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: controller.signal,
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new JevError('http', `jev:http-${res.status} ${detail.slice(0, 200)}`)
      }
      const data = (await res.json()) as {
        answers?: Record<string, { noul?: number; score?: number }>
        usage?: Record<string, unknown>
      }
      return {
        answers: this.extractAnswers(data.answers ?? {}, questions),
        usage: usageOf(data.usage, body.length, JSON.stringify(data.answers ?? {}).length),
      }
    } catch (error) {
      if (error instanceof JevError) throw error
      if (controller.signal.aborted) throw new JevError('timeout', 'jev:timeout')
      throw new JevError('network', `jev:network ${errorMessage(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  private extractAnswers(answers: Record<string, { noul?: number; score?: number }>, questions: Record<string, JevQuestion>): JevAnswers {
    const out: JevAnswers = {}
    for (const id of Object.keys(questions)) {
      const question = questions[id]
      if (!question) throw new JevError('malformed', `jev:malformed:${id}`)
      const raw = answers[id]
      if (!raw) throw new JevError('malformed', `jev:malformed:${id}`)
      let value: number
      if (question.type === 'score') {
        const criteria = question.criteria ?? []
        const top = criteria.length - 1
        const score = raw.score
        if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || top <= 0) {
          throw new JevError('malformed', `jev:malformed:${id}`)
        }
        value = score / top
      } else {
        const noul = raw.noul
        if (typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) {
          throw new JevError('malformed', `jev:malformed:${id}`)
        }
        value = noul
      }
      out[id] = Math.min(1, Math.max(0, value))
    }
    return out
  }
}

/**
 * 解析模型返回的 token 用量。
 *
 * Provider 给了就用它（几种常见字段名都认）；没给就按 4 字符 ≈ 1 token 估算，
 * 宁可高估也不要低估——预算宁可早点触发。
 */
function usageOf(raw: Record<string, unknown> | undefined, requestChars: number, responseChars: number): JevUsage {
  const input = numberOf(raw?.prompt_tokens ?? raw?.input_tokens ?? raw?.input)
  const output = numberOf(raw?.completion_tokens ?? raw?.output_tokens ?? raw?.output)
  const total = numberOf(raw?.total_tokens ?? raw?.total)
  if (input === null && output === null && total === null) {
    const estimatedInput = Math.ceil(requestChars / 4)
    const estimatedOutput = Math.ceil(responseChars / 4)
    return { input: estimatedInput, output: estimatedOutput, total: estimatedInput + estimatedOutput }
  }
  const resolvedInput = input ?? 0
  const resolvedOutput = output ?? 0
  return { input: resolvedInput, output: resolvedOutput, total: total ?? resolvedInput + resolvedOutput }
}

function numberOf(value: unknown): number | null {
  const num = Number(value)
  return typeof value === 'number' && Number.isFinite(num) && num >= 0 ? num : null
}
