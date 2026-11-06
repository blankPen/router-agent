import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
}

export interface LlmToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface LlmToolCall {
  id: string
  name: string
  arguments: string
}

export interface LlmResponse {
  content: string | null
  toolCalls: LlmToolCall[]
}

export interface LlmCompleteRequest {
  messages: LlmMessage[]
  tools?: LlmToolSchema[]
  temperature?: number
  maxTokens?: number
}

export interface LlmClient {
  complete(req: LlmCompleteRequest): Promise<LlmResponse>
}

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  temperature?: number
}

export interface ResolveLlmOptions {
  /** ~/.router-agent/config.yaml 路径。 */
  configPath?: string
  /** ~/.trove/config.json 路径。 */
  trovePath?: string
  env?: NodeJS.ProcessEnv
  /** 真实用户主目录，用于定位 .trove。 */
  home?: string
}

/**
 * 解析模型配置，优先级：环境变量 > ~/.router-agent/config.yaml > ~/.trove/config.json。
 * 复用 .trove 里已经可用的模型配置，避免重复登记密钥。
 */
export function resolveLlmConfig(opts: ResolveLlmOptions = {}): LlmConfig {
  const env = opts.env ?? process.env
  const userHome = opts.home ?? homedir()
  const fromEnv = {
    ...(env.RA_LLM_BASE_URL ? { baseUrl: env.RA_LLM_BASE_URL } : {}),
    ...(env.RA_LLM_API_KEY ? { apiKey: env.RA_LLM_API_KEY } : {}),
    ...(env.RA_LLM_MODEL ? { model: env.RA_LLM_MODEL } : {}),
  }

  const raHome = env.RA_HOME ?? join(userHome, '.router-agent')
  const configPath = opts.configPath ?? join(raHome, 'config.yaml')
  const fromConfig = readYamlLlm(configPath)

  const trovePath = opts.trovePath ?? join(userHome, '.trove', 'config.json')
  const fromTrove = readTroveLlm(trovePath)

  const merged = { ...fromTrove, ...fromConfig, ...fromEnv }
  if (!merged.baseUrl || !merged.apiKey || !merged.model) {
    throw new Error('llm:config-missing: 需要 baseUrl / apiKey / model（环境变量 RA_LLM_*、~/.router-agent/config.yaml 或 ~/.trove/config.json）')
  }
  return merged as LlmConfig
}

function readYamlLlm(path: string): Partial<LlmConfig> {
  if (!existsSync(path)) return {}
  try {
    const doc = parseYaml(readFileSync(path, 'utf8')) as Record<string, any> | null
    const llm = doc?.llm
    if (!llm) return {}
    return {
      ...(llm.baseUrl ? { baseUrl: String(llm.baseUrl) } : {}),
      ...(llm.apiKey ? { apiKey: String(llm.apiKey) } : {}),
      ...(llm.model ? { model: String(llm.model) } : {}),
      ...(llm.temperature !== undefined ? { temperature: Number(llm.temperature) } : {}),
    }
  } catch {
    return {}
  }
}

function readTroveLlm(path: string): Partial<LlmConfig> {
  if (!existsSync(path)) return {}
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
    const llm = doc?.llm
    if (!llm) return {}
    return {
      ...(llm.baseUrl ? { baseUrl: String(llm.baseUrl) } : {}),
      ...(llm.apiKey ? { apiKey: String(llm.apiKey) } : {}),
      ...(llm.model ? { model: String(llm.model) } : {}),
    }
  } catch {
    return {}
  }
}

/** OpenAI 兼容的 Chat Completions 客户端（DeepSeek / Kimi / OpenAI 等）。 */
export class OpenAiCompatClient implements LlmClient {
  private config: LlmConfig
  private fetchImpl: typeof fetch

  constructor(config: LlmConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config
    this.fetchImpl = fetchImpl
  }

  async complete(req: LlmCompleteRequest): Promise<LlmResponse> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: req.messages,
      temperature: req.temperature ?? this.config.temperature ?? 0.2,
    }
    if (req.tools?.length) {
      body.tools = req.tools
      body.tool_choice = 'auto'
    }
    if (req.maxTokens) body.max_tokens = req.maxTokens

    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`llm:http-${res.status}: ${text.slice(0, 300)}`)
    }
    const json = (await res.json()) as Record<string, any>
    const message = json.choices?.[0]?.message ?? {}
    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    return {
      content: typeof message.content === 'string' ? message.content : null,
      toolCalls: rawCalls.map((call: Record<string, any>, index: number) => ({
        id: String(call.id ?? `call_${index}`),
        name: String(call.function?.name ?? ''),
        arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {}),
      })),
    }
  }
}

/** 从模型自由文本里提取第一个 JSON 对象，容忍 ```json 包裹与前后说明。 */
export function extractJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1)) as Record<string, unknown>
        } catch {
          return null
        }
      }
    }
  }
  return null
}
