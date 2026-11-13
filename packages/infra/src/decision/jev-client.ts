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
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: this.model, state, questions }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new JevError('http', `jev:http-${res.status} ${detail.slice(0, 200)}`)
      }
      const data = (await res.json()) as { answers?: Record<string, { noul?: number; score?: number }> }
      return this.extractAnswers(data.answers ?? {}, questions)
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
