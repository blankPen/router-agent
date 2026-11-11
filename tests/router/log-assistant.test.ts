import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createLogAssistant,
  ensureEvidence,
  matchSymptoms,
  ruleDiagnosis,
  selectEvidence,
  tokenize,
} from '../../src/router/log-assistant.js'
import type { LogEntry } from '../../src/router/log-tail.js'

function entry(at: string, level: string, message: string, data?: Record<string, unknown>): LogEntry {
  return { at, level, message, ...(data ? { data } : {}) }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('tokenize', () => {
  it('中文按二元组切，英文数字按整词切', () => {
    const tokens = tokenize('飞书消息没反应 codex timeout')
    expect(tokens).toContain('飞书')
    expect(tokens).toContain('消息')
    expect(tokens).toContain('codex')
    expect(tokens).toContain('timeout')
  })

  it('丢掉常见虚词组合', () => {
    expect(tokenize('这是什么')).not.toContain('什么')
  })
})

describe('selectEvidence', () => {
  const entries: LogEntry[] = [
    entry('2026-11-09T10:00:00.000Z', 'info', 'api:listening', { port: 8787 }),
    entry('2026-11-09T10:01:00.000Z', 'warn', 'trigger:dropped', { reason: 'not-allowed' }),
    entry('2026-11-09T10:02:00.000Z', 'error', 'outbox:failed', { error: 'http-500' }),
  ]

  it('错误优先于普通信息', () => {
    const evidence = selectEvidence(entries, { question: '消息没发出去' })
    expect(evidence[0]?.message).toBe('outbox:failed')
  })

  it('级别过滤生效', () => {
    const evidence = selectEvidence(entries, { question: '消息', level: 'warn' })
    expect(evidence.map(item => item.message)).toEqual(['trigger:dropped'])
  })

  it('关键字过滤生效', () => {
    const evidence = selectEvidence(entries, { question: '消息', keyword: 'outbox' })
    expect(evidence.map(item => item.message)).toEqual(['outbox:failed'])
  })

  it('证据带出结构化字段摘要', () => {
    const evidence = selectEvidence(entries, { question: 'outbox' })
    expect(evidence[0]?.detail).toContain('error=http-500')
  })
})

describe('matchSymptoms', () => {
  it('按事件名命中已知问题模式', () => {
    const hits = matchSymptoms([
      entry('2026-11-09T10:00:00.000Z', 'warn', 'trigger:dropped', { reason: 'not-allowed' }),
    ])
    expect(hits[0]?.symptom.id).toBe('message-ignored')
    expect(hits[0]?.events).toEqual(['trigger:dropped'])
  })

  it('没有已知事件时不命中', () => {
    expect(matchSymptoms([entry('2026-11-09T10:00:00.000Z', 'info', 'api:listening')])).toEqual([])
  })
})

describe('ensureEvidence', () => {
  it('把结论里引用但证据里没有的事件补进来', () => {
    const entries = [
      entry('2026-11-09T10:00:00.000Z', 'info', 'api:listening'),
      entry('2026-11-09T10:01:00.000Z', 'warn', 'trigger:dropped'),
    ]
    const merged = ensureEvidence([{ at: '2026-11-09T10:00:00.000Z', level: 'info', message: 'api:listening' }], entries, ['trigger:dropped'])
    expect(merged.map(item => item.message)).toContain('trigger:dropped')
  })
})

describe('ruleDiagnosis', () => {
  it('命中已知模式时给出原因与建议', () => {
    const entries = [entry('2026-11-09T10:01:00.000Z', 'warn', 'trigger:dropped', { reason: 'not-allowed' })]
    const hits = matchSymptoms(entries)
    const diagnosis = ruleDiagnosis('机器人没反应', [], hits)

    expect(diagnosis.source).toBe('rules')
    expect(diagnosis.causes[0]?.title).toContain('被过滤')
    expect(diagnosis.actions.length).toBeGreaterThan(0)
  })

  it('没有问题模式命中时如实说明', () => {
    const diagnosis = ruleDiagnosis('随便问问', [{ at: '2026-11-09T10:00:00.000Z', level: 'info', message: 'api:listening' }], [])
    expect(diagnosis.summary).toContain('没有命中已知问题模式')
    expect(diagnosis.causes).toEqual([])
  })

  it('问题点名的那类症状排在最前并写进结论', () => {
    const entries = [
      entry('2026-11-09T10:00:00.000Z', 'info', 'router:decision', { triggerId: 'om_x' }),
      entry('2026-11-09T10:01:00.000Z', 'warn', 'trigger:dropped', { reason: 'not-allowed' }),
    ]
    const hits = matchSymptoms(entries)
    const diagnosis = ruleDiagnosis('机器人没反应', [], hits)

    expect(diagnosis.causes[0]?.title).toContain('被过滤')
    expect(diagnosis.summary).toContain('最可能是')
    expect(diagnosis.causes.length).toBeLessThanOrEqual(3)
  })
})

describe('createLogAssistant', () => {
  let home: string
  let logPath: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ra-log-assistant-'))
    mkdirSync(join(home, 'logs'), { recursive: true })
    logPath = join(home, 'logs', 'router-agent.log')
    writeFileSync(logPath, [
      `${JSON.stringify({ at: '2026-11-09T10:00:00.000Z', level: 'info', message: 'feishu:ready' })}`,
      `${JSON.stringify({ at: '2026-11-09T10:01:00.000Z', level: 'warn', message: 'trigger:dropped', reason: 'not-allowed', chat: 'oc_x' })}`,
      `${JSON.stringify({ at: '2026-11-09T10:02:00.000Z', level: 'error', message: 'outbox:failed', error: 'http-500' })}`,
    ].join('\n') + '\n', 'utf8')
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('没有模型时走规则式排查并给出已知问题', async () => {
    const assistant = createLogAssistant({ logPath })
    expect(assistant.llmConfigured()).toBe(false)

    const diagnosis = await assistant.diagnose({ question: '飞书消息机器人没反应' })
    expect(diagnosis.source).toBe('rules')
    expect(diagnosis.causes.map(cause => cause.title).join()).toContain('被过滤')
    expect(diagnosis.evidence.length).toBeGreaterThan(0)
  })

  it('配了模型时用模型总结', async () => {
    const fetchImpl = (async () => jsonResponse({
      choices: [{ message: { content: JSON.stringify({
        summary: '消息被允许名单挡掉了',
        causes: [{ title: '允许名单没解析出来', detail: 'trigger:dropped reason=not-allowed', events: ['trigger:dropped'] }],
        actions: ['检查允许名单里的邮箱'],
      }) } }],
    })) as unknown as typeof fetch

    const assistant = createLogAssistant({
      logPath,
      model: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'chat-model' },
      fetchImpl,
    })
    expect(assistant.llmConfigured()).toBe(true)

    const diagnosis = await assistant.diagnose({ question: '消息没反应' })
    expect(diagnosis.source).toBe('llm')
    expect(diagnosis.summary).toBe('消息被允许名单挡掉了')
    expect(diagnosis.causes[0]?.events).toEqual(['trigger:dropped'])
  })

  it('模型调用失败时降级为规则排查并说明原因', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const assistant = createLogAssistant({
      logPath,
      model: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'chat-model' },
      fetchImpl,
    })

    const diagnosis = await assistant.diagnose({ question: '消息没反应' })
    expect(diagnosis.source).toBe('rules')
    expect(diagnosis.degraded).toContain('模型总结失败')
    expect(diagnosis.causes.length).toBeGreaterThan(0)
  })

  it('模型返回的不是 JSON 时同样降级', async () => {
    const fetchImpl = (async () => jsonResponse({ choices: [{ message: { content: '随便说点什么' } }] })) as unknown as typeof fetch
    const assistant = createLogAssistant({
      logPath,
      model: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'chat-model' },
      fetchImpl,
    })

    const diagnosis = await assistant.diagnose({ question: '消息没反应' })
    expect(diagnosis.source).toBe('rules')
    expect(diagnosis.degraded).toContain('模型总结失败')
  })
})
