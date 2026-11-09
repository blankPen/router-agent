import { describe, expect, it } from 'vitest'
import {
  chatCompletionsUrl,
  createVisionTranscriber,
  DEFAULT_VISION_PROMPT,
  parseChatCompletionText,
} from '../../src/infra/vision.js'

const model = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'vision-model' }
const image = { data: 'aGVsbG8=', mimeType: 'image/png' }

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
    expect(chatCompletionsUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1/chat/completions')
    expect(chatCompletionsUrl('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1/chat/completions')
    expect(() => chatCompletionsUrl('  ')).toThrow(/base-url-missing/)
  })
})

describe('parseChatCompletionText', () => {
  it('兼容字符串与分段数组两种 content', () => {
    expect(parseChatCompletionText({ choices: [{ message: { content: ' 你好 ' } }] })).toBe('你好')
    expect(parseChatCompletionText({
      choices: [{ message: { content: [{ type: 'text', text: '报错：' }, { type: 'image', text: '' }, { type: 'text', text: 'timeout' }] } }],
    })).toBe('报错：timeout')
    expect(parseChatCompletionText({})).toBe('')
  })
})

describe('createVisionTranscriber', () => {
  it('把图片作为 data URL 发给多模态模型，并返回转写文本', async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ choices: [{ message: { content: '截图里写着：登录超时 30 秒' } }] }))
    const transcriber = createVisionTranscriber(model, { fetchImpl, maxChars: 100 })

    const text = await transcriber.transcribe(image)
    expect(text).toBe('截图里写着：登录超时 30 秒')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.example.com/v1/chat/completions')

    const body = JSON.parse(String(calls[0]!.init.body))
    expect(body.model).toBe('vision-model')
    expect(body.messages[0].content[0]).toEqual({ type: 'text', text: DEFAULT_VISION_PROMPT })
    expect(body.messages[0].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,aGVsbG8=' },
    })
  })

  it('结果超过 maxChars 时截断', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ choices: [{ message: { content: 'x'.repeat(50) } }] }))
    const transcriber = createVisionTranscriber(model, { fetchImpl, maxChars: 10 })
    expect(await transcriber.transcribe(image)).toBe('xxxxxxxxxx…')
  })

  it('空结果按失败处理', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ choices: [{ message: { content: '   ' } }] }))
    const transcriber = createVisionTranscriber(model, { fetchImpl })
    await expect(transcriber.transcribe(image)).rejects.toThrow(/vision-empty/)
  })

  it('模型不支持图片时熔断，后续调用不再发请求', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('model does not support image', { status: 400 }))
    const transcriber = createVisionTranscriber(model, { fetchImpl })

    await expect(transcriber.transcribe(image)).rejects.toThrow(/vision-http-400/)
    await expect(transcriber.transcribe(image)).rejects.toThrow(/vision-unsupported/)
    expect(calls).toHaveLength(1)
  })

  it('图片过大等 400 不熔断，后续图片仍会重试', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('image too large', { status: 400 }))
    const transcriber = createVisionTranscriber(model, { fetchImpl })

    await expect(transcriber.transcribe(image)).rejects.toThrow(/vision-http-400/)
    await expect(transcriber.transcribe(image)).rejects.toThrow(/vision-http-400/)
    expect(calls).toHaveLength(2)
  })

  it('超时给出可读错误', async () => {
    const fetchImpl = (async () => {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      throw error
    }) as unknown as typeof fetch
    const transcriber = createVisionTranscriber(model, { fetchImpl, timeoutMs: 50 })
    await expect(transcriber.transcribe(image)).rejects.toThrow(/vision-timeout/)
  })
})
