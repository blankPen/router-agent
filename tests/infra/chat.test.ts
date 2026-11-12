import { describe, expect, it } from 'vitest'
import {
  anthropicMessagesUrl,
  chatCompletionsUrl,
  createChatClient,
  parseChatText,
} from '#infra/chat.js'

const model = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'chat-model' }

function fakeFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return handler(String(url), init ?? {})
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('chatCompletionsUrl', () => {
  it('补全 chat/completions 路径并去掉多余斜杠', () => {
    expect(chatCompletionsUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/chat/completions')
    expect(chatCompletionsUrl('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1/chat/completions')
    expect(() => chatCompletionsUrl('')).toThrow(/base-url-missing/)
  })
})

describe('anthropicMessagesUrl', () => {
  it('网关根地址补成 /v1/messages', () => {
    expect(anthropicMessagesUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/messages')
    expect(anthropicMessagesUrl('https://gw.example.com/v1/messages')).toBe('https://gw.example.com/v1/messages')
  })
})

describe('parseChatText', () => {
  it('兼容 OpenAI 的字符串与分段数组', () => {
    expect(parseChatText({ choices: [{ message: { content: ' 结论 ' } }] })).toBe('结论')
    expect(parseChatText({
      choices: [{ message: { content: [{ type: 'text', text: '一' }, { type: 'text', text: '二' }] } }],
    })).toBe('一二')
  })

  it('兼容 Anthropic 的 content 数组', () => {
    expect(parseChatText({ content: [{ type: 'text', text: '结论' }] }, 'anthropic-messages')).toBe('结论')
  })
})

describe('createChatClient', () => {
  it('OpenAI 兼容：带 Bearer 密钥发消息并取回文本', async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ choices: [{ message: { content: '结论' } }] }))
    const client = createChatClient(model, { fetchImpl })
    const turn = await client.complete([{ role: 'user', content: '问题' }])

    expect(turn.content).toBe('结论')
    expect(turn.toolCalls).toEqual([])
    expect(calls[0]?.url).toBe('https://api.example.com/v1/chat/completions')
    const init = calls[0]?.init
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    const body = JSON.parse(String(init?.body))
    expect(body.model).toBe('chat-model')
    expect(body.messages).toEqual([{ role: 'user', content: '问题' }])
  })

  it('Anthropic 兼容：system 单独成字段，密钥走 x-api-key', async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ content: [{ type: 'text', text: '结论' }] }))
    const client = createChatClient(
      { ...model, baseUrl: 'https://gw.example.com', api: 'anthropic-messages' },
      { fetchImpl },
    )
    const turn = await client.complete([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '问题' },
    ])

    expect(turn.content).toBe('结论')
    expect(calls[0]?.url).toBe('https://gw.example.com/v1/messages')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body.system).toBe('你是助手')
    expect(body.messages).toEqual([{ role: 'user', content: '问题' }])
  })

  it('Anthropic 兼容：authHeader 时按 Bearer 发密钥', async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ content: [{ type: 'text', text: 'ok' }] }))
    const client = createChatClient(
      { ...model, baseUrl: 'https://gw.example.com', api: 'anthropic-messages', authHeader: true },
      { fetchImpl },
    )
    await client.complete([{ role: 'user', content: '问题' }])

    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test')
    expect(headers['x-api-key']).toBeUndefined()
  })

  it('HTTP 失败时抛出带状态码的错误', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('boom', { status: 500 }))
    const client = createChatClient(model, { fetchImpl })
    await expect(client.complete([{ role: 'user', content: '问题' }])).rejects.toThrow(/chat:http-500/)
  })

  it('返回空内容时报错而不是静默通过', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ choices: [{ message: { content: '' } }] }))
    const client = createChatClient(model, { fetchImpl })
    await expect(client.complete([{ role: 'user', content: '问题' }])).rejects.toThrow(/chat:empty-response/)
  })
})
