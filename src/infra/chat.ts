/**
 * 通用对话补全客户端。
 *
 * 只依赖两种常见协议的 HTTP 接口，不引入新 SDK：
 * - `openai-completions`：POST `{baseUrl}/chat/completions`，密钥走 `Authorization: Bearer`；
 * - `anthropic-messages`：POST `{baseUrl}/v1/messages`，密钥走 `x-api-key`
 *   （配置了 `authHeader` 时按 `ANTHROPIC_AUTH_TOKEN` 的语义改成 `Authorization: Bearer`）。
 *
 * 支持工具调用（tool use）：模型可以要求执行只读工具（读配置、读本地代码），
 * 再基于工具结果给结论——这正是「排查助手要能看本机代码与配置」需要的形态。
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

/** 工具声明（JSON Schema 形式的参数说明）。 */
export interface ChatToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 模型发起的一次工具调用。 */
export interface ChatToolCall {
  id: string
  name: string
  /** 已解析的参数对象。 */
  arguments: Record<string, unknown>
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** assistant 发起工具调用时带上。 */
  toolCalls?: ChatToolCall[]
  /** tool 消息指回哪一次调用。 */
  toolCallId?: string
}

/** 一轮对话的结果。 */
export interface ChatTurn {
  /** 模型的文字输出（发起工具调用时可以为空）。 */
  content: string
  /** 模型请求执行的工具。 */
  toolCalls: ChatToolCall[]
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
  complete(messages: ChatMessage[], opts?: { tools?: ChatToolSpec[] }): Promise<ChatTurn>
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
    async complete(messages: ChatMessage[], completeOpts: { tools?: ChatToolSpec[] } = {}): Promise<ChatTurn> {
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
          body: JSON.stringify(requestBody(model, api, messages, maxTokens, completeOpts.tools)),
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

      const turn = parseChatTurn(payload, api)
      // 既没有文字也没有工具调用，说明模型没给出可用的东西，直接报错让上层降级。
      if (!turn.content && turn.toolCalls.length === 0) throw new Error('chat:empty-response')
      return turn
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
  tools?: ChatToolSpec[],
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
      ...(tools && tools.length > 0 ? { tools: tools.map(anthropicTool) } : {}),
      messages: rest.map(anthropicMessage),
    }
  }
  return {
    model: model.model,
    max_tokens: maxTokens,
    temperature,
    ...(tools && tools.length > 0 ? { tools: tools.map(openaiTool) } : {}),
    messages: messages.map(openaiMessage),
  }
}

function openaiTool(tool: ChatToolSpec): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }
}

function anthropicTool(tool: ChatToolSpec): Record<string, unknown> {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters }
}

function openaiMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId ?? '', content: message.content }
  }
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map(call => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
      })),
    }
  }
  return { role: message.role, content: message.content }
}

function anthropicMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: message.content }],
    }
  }
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    const blocks: Record<string, unknown>[] = []
    if (message.content) blocks.push({ type: 'text', text: message.content })
    for (const call of message.toolCalls) {
      blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments ?? {} })
    }
    return { role: 'assistant', content: blocks }
  }
  return { role: message.role, content: message.content }
}

/** 解析一轮响应：文字 + 工具调用。 */
export function parseChatTurn(payload: unknown, api: ChatApi = 'openai-completions'): ChatTurn {
  const root = payload as Record<string, any> | null
  if (!root) return { content: '', toolCalls: [] }
  if (api === 'anthropic-messages') {
    const blocks = Array.isArray(root.content) ? root.content : []
    const content = blocks
      .filter((block: Record<string, unknown>) => block?.type === 'text')
      .map((block: Record<string, unknown>) => String(block.text ?? ''))
      .join('')
      .trim()
    const toolCalls = blocks
      .filter((block: Record<string, unknown>) => block?.type === 'tool_use')
      .map((block: Record<string, unknown>) => ({
        id: String(block.id ?? ''),
        name: String(block.name ?? ''),
        arguments: (block.input as Record<string, unknown>) ?? {},
      }))
    return { content, toolCalls }
  }
  const message = root.choices?.[0]?.message
  const content = parseChatContent(message?.content)
  const rawCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  const toolCalls = rawCalls.map((call: Record<string, any>) => ({
    id: String(call?.id ?? ''),
    name: String(call?.function?.name ?? ''),
    arguments: parseToolArguments(call?.function?.arguments),
  }))
  return { content, toolCalls }
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
  return parseChatContent(root.choices?.[0]?.message?.content)
}

function parseChatContent(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part: Record<string, unknown>) => (part && part.type === 'text' ? String(part.text ?? '') : ''))
      .join('')
      .trim()
  }
  return ''
}

/** 工具参数可能是 JSON 字符串，也可能是已经解析好的对象。 */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
