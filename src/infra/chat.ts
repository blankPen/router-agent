/**
 * 通用对话补全客户端。
 *
 * 只依赖两种常见协议的 HTTP 接口，不引入新 SDK：
 * - `openai-completions`：POST `{baseUrl}/chat/completions`，密钥走 `Authorization: Bearer`；
 * - `anthropic-messages`：POST `{baseUrl}/v1/messages`，密钥走 `x-api-key`
 *   （配置了 `authHeader` 时按 `ANTHROPIC_AUTH_TOKEN` 的语义改成 `Authorization: Bearer`）。
 *
 * 用途：面板上的智能排查助手需要一个「问一句、答一句」的能力，
 * 不值得为此把 Agent 循环整套拉起来。
 */

export type ChatApi = 'openai-completions' | 'anthropic-messages'

export interface ChatModelConfig {
  baseUrl: string
  apiKey: string
  model: string
  api?: ChatApi
  /** anthropic-messages 下把密钥作为 Authorization: Bearer 发送。 */
  authHeader?: boolean
  temperature?: number
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatClientOptions {
  /** 单次请求硬超时，默认 60s。 */
  timeoutMs?: number
  /** 输出 token 上限，默认 2000。 */
  maxTokens?: number
  /** 测试注入点。 */
  fetchImpl?: typeof fetch
}

export interface ChatClient {
  complete(messages: ChatMessage[]): Promise<string>
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_TOKENS = 2_000

/** 创建对话补全客户端；模型地址、密钥、模型名缺一不可。 */
export function createChatClient(model: ChatModelConfig, opts: ChatClientOptions = {}): ChatClient {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxTokens = opts.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : DEFAULT_MAX_TOKENS
  const api: ChatApi = model.api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions'
  const url = api === 'anthropic-messages' ? anthropicMessagesUrl(model.baseUrl) : chatCompletionsUrl(model.baseUrl)

  return {
    async complete(messages: ChatMessage[]): Promise<string> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders(model, api),
          },
          body: JSON.stringify(requestBody(model, api, messages, maxTokens)),
          signal: controller.signal,
        })
      } catch (error) {
        if (isAbortError(error)) throw new Error(`chat:timeout(${timeoutMs}ms)`)
        throw new Error(`chat:request-failed: ${errorText(error)}`)
      } finally {
        clearTimeout(timer)
      }

      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200)
        throw new Error(`chat:http-${response.status}${detail ? `: ${detail}` : ''}`)
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch (error) {
        throw new Error(`chat:invalid-json: ${errorText(error)}`)
      }

      const text = parseChatText(payload, api)
      if (!text) throw new Error('chat:empty-response')
      return text
    },
  }
}

/** OpenAI 兼容地址：baseUrl 填到 /v1 即可，这里补上 /chat/completions。 */
export function chatCompletionsUrl(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, '')
  if (!clean) throw new Error('chat:base-url-missing')
  if (clean.endsWith('/chat/completions')) return clean
  return `${clean}/chat/completions`
}

/** Anthropic 兼容地址：baseUrl 填网关根地址（不带 /v1/messages）。 */
export function anthropicMessagesUrl(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, '')
  if (!clean) throw new Error('chat:base-url-missing')
  if (clean.endsWith('/v1/messages')) return clean
  if (clean.endsWith('/messages')) return clean
  return `${clean}/v1/messages`
}

function authHeaders(model: ChatModelConfig, api: ChatApi): Record<string, string> {
  if (!model.apiKey) return {}
  if (api === 'anthropic-messages') {
    return model.authHeader
      ? { Authorization: `Bearer ${model.apiKey}` }
      : { 'x-api-key': model.apiKey, 'anthropic-version': '2023-06-01' }
  }
  return { Authorization: `Bearer ${model.apiKey}` }
}

function requestBody(
  model: ChatModelConfig,
  api: ChatApi,
  messages: ChatMessage[],
  maxTokens: number,
): Record<string, unknown> {
  const temperature = model.temperature ?? 0.2
  if (api === 'anthropic-messages') {
    const system = messages.filter(item => item.role === 'system').map(item => item.content).join('\n\n')
    const rest = messages.filter(item => item.role !== 'system')
    return {
      model: model.model,
      max_tokens: maxTokens,
      temperature,
      ...(system ? { system } : {}),
      messages: rest.map(item => ({ role: item.role, content: item.content })),
    }
  }
  return {
    model: model.model,
    max_tokens: maxTokens,
    temperature,
    messages: messages.map(item => ({ role: item.role, content: item.content })),
  }
}

/** 从返回里取文本；兼容 OpenAI 的字符串 / 分段数组与 Anthropic 的 content 数组。 */
export function parseChatText(payload: unknown, api: ChatApi = 'openai-completions'): string {
  const root = payload as Record<string, any> | null
  if (!root) return ''
  if (api === 'anthropic-messages') {
    const blocks = Array.isArray(root.content) ? root.content : []
    return blocks
      .map((block: Record<string, unknown>) => (block && typeof block.text === 'string' ? block.text : ''))
      .join('')
      .trim()
  }
  const content = root.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part: Record<string, unknown>) => (part && part.type === 'text' ? String(part.text ?? '') : ''))
      .join('')
      .trim()
  }
  return ''
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
