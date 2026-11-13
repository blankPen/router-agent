import { describe, expect, it, vi } from 'vitest'
import { JevClient } from '#infra/decision/jev-client.js'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('JevClient.ask', () => {
  it('posts_state_and_questions_and_returns_noul_answers', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ answers: { needs_followup: { noul: 0.9 }, urgency: { noul: 0.3 } } }))
    const client = new JevClient({ apiKey: 'test-key', model: 'jev-latest' }, { fetch: fetchMock as unknown as typeof fetch })
    const answers = await client.ask({ message: '修个 bug' }, {
      needs_followup: { type: 'noul', instructions: '需要跟进吗？' },
      urgency: { type: 'noul', instructions: '多紧急？' },
    })
    expect(answers).toEqual({ needs_followup: 0.9, urgency: 0.3 })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-key', 'Content-Type': 'application/json' })
    const body = JSON.parse(String(init.body))
    expect(body.model).toBe('jev-latest')
    expect(body.state).toEqual({ message: '修个 bug' })
    expect(body.questions.needs_followup).toMatchObject({ type: 'noul', instructions: '需要跟进吗？' })
  })

  it('normalizes_score_answers_to_0_1_by_criteria_count', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ answers: { kind: { score: 2 } } }))
    const client = new JevClient({ apiKey: 'k', model: 'm' }, { fetch: fetchMock as unknown as typeof fetch })
    const answers = await client.ask({}, { kind: { type: 'score', instructions: '哪一类？', criteria: ['闲聊', '咨询', '需求'] } })
    expect(answers.kind).toBeCloseTo(1, 5)
  })

  it('uses_custom_base_url_when_configured', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ answers: { a: { noul: 0.5 } } }))
    const client = new JevClient({ apiKey: 'k', model: 'm', baseUrl: 'https://proxy.example/j' }, { fetch: fetchMock as unknown as typeof fetch })
    await client.ask({}, { a: { type: 'noul', instructions: 'x' } })
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit] | undefined
    expect(firstCall?.[0]).toBe('https://proxy.example/j')
  })

  it('throws_with_http_status_when_response_not_ok', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }))
    const client = new JevClient({ apiKey: 'k', model: 'm' }, { fetch: fetchMock as unknown as typeof fetch })
    await expect(client.ask({}, { a: { type: 'noul', instructions: 'x' } })).rejects.toThrow(/jev:http-500/)
  })

  it('throws_when_answer_missing_or_out_of_range', async () => {
    const missing = new JevClient({ apiKey: 'k', model: 'm' }, { fetch: (async () => jsonResponse({ answers: {} })) as unknown as typeof fetch })
    await expect(missing.ask({}, { a: { type: 'noul', instructions: 'x' } })).rejects.toThrow(/jev:malformed:a/)

    const outOfRange = new JevClient({ apiKey: 'k', model: 'm' }, { fetch: (async () => jsonResponse({ answers: { a: { noul: 1.5 } } })) as unknown as typeof fetch })
    await expect(outOfRange.ask({}, { a: { type: 'noul', instructions: 'x' } })).rejects.toThrow(/jev:malformed:a/)
  })

  it('askWithUsage 返回 provider 给的 token 用量', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      answers: { a: { noul: 0.5 } },
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    }))
    const client = new JevClient({ apiKey: 'k', model: 'm' }, { fetch: fetchMock as unknown as typeof fetch })
    const result = await client.askWithUsage({ message: 'x' }, { a: { type: 'noul', instructions: 'x' } })
    expect(result.usage).toEqual({ input: 120, output: 30, total: 150 })
    expect(result.answers.a).toBe(0.5)
  })

  it('provider 不给 usage 时按字符数估算 token', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ answers: { a: { noul: 0.5 } } }))
    const client = new JevClient({ apiKey: 'k', model: 'm' }, { fetch: fetchMock as unknown as typeof fetch })
    const result = await client.askWithUsage({ message: 'x'.repeat(400) }, { a: { type: 'noul', instructions: 'x' } })
    expect(result.usage.total).toBeGreaterThan(100)
    expect(result.usage.input).toBeGreaterThan(0)
    expect(result.usage.output).toBeGreaterThan(0)
  })

  it('fails_with_timeout_when_jev_slow', async () => {
    vi.useFakeTimers()
    const client = new JevClient({ apiKey: 'k', model: 'm' }, {
      timeoutMs: 100,
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })) as unknown as typeof fetch,
    })
    const promise = client.ask({}, { a: { type: 'noul', instructions: 'x' } })
    const assertion = expect(promise).rejects.toThrow(/jev:timeout/)
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    vi.useRealTimers()
  })
})
