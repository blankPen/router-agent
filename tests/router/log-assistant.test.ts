import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createLogAssistant,
  ensureEvidence,
  matchSymptoms,
  nextStepsFor,
  nextStepsFromCauses,
  redactFields,
  ruleDiagnosis,
  selectEvidence,
  tokenize,
} from '../../src/router/log-assistant.js'
import type { LogEntry } from '../../src/router/log-tail.js'
import { logDimensions } from '#core/events.js'
import type { DiagnosisTool } from '../../src/router/diagnosis-tools.js'

function entry(at: string, level: string, message: string, data?: Record<string, unknown>): LogEntry {
  // 维度按真实日志的推导方式补齐，测试里的条目与线上结构一致。
  const dimensions = logDimensions(message, data ?? {})
  return {
    at,
    level,
    domain: dimensions.domain,
    event: dimensions.event,
    ...(dimensions.trace ? { trace: dimensions.trace } : {}),
    message,
    ...(data ? { data } : {}),
  }
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

  it('同时点名两类症状时，命中关键词多的那类排最前', () => {
    const entries = [
      entry('2026-11-09T10:00:00.000Z', 'info', 'router:decision', { triggerId: 'om_x' }),
      entry('2026-11-09T10:01:00.000Z', 'info', 'trigger:ingested', { triggerId: 'om_x' }),
      entry('2026-11-09T10:02:00.000Z', 'error', 'codex:turn-failed', { ticketId: 'tk-1' }),
    ]
    const hits = matchSymptoms(entries)
    // 问题同时提到「工单」与「worker 卡住」，worker 类命中两个关键词应当排最前。
    const diagnosis = ruleDiagnosis('工单里的 worker 好像卡住了，一直没有进展', [], hits)
    expect(diagnosis.causes[0]?.title).toContain('Worker 卡住')
  })
})

describe('redactFields', () => {
  it('抹掉带用户消息正文的字段，保留其它字段', () => {
    const text = redactFields({ text: '帮我改一下 README 的端口', reason: 'not-allowed', count: 3 })
    expect(text).toContain('text=（内容已省略）')
    expect(text).not.toContain('README')
    expect(text).toContain('reason=not-allowed')
    expect(text).toContain('count=3')
  })

  it('没有字段时返回空串', () => {
    expect(redactFields(undefined)).toBe('')
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
      `${JSON.stringify({ at: '2026-11-09T10:03:00.000Z', level: 'info', message: 'input:queued', ticketId: 'tk-7', text: '帮我改一下 README 的端口' })}`,
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
    let sent = ''
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sent = String(init?.body ?? '')
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify({
          summary: '消息被允许名单挡掉了',
          causes: [{ title: '允许名单没解析出来', detail: 'trigger:dropped reason=not-allowed', events: ['trigger:dropped'] }],
          actions: ['检查允许名单里的邮箱'],
        }) } }],
      })
    }) as unknown as typeof fetch

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
    // 发给模型的请求里带上证据，但正文类字段要抹掉。
    expect(sent).toContain('trigger:dropped')
    expect(sent).toContain('（内容已省略）')
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

describe('nextStepsFor', () => {
  it('配置类症状引导去配置页', () => {
    const hits = matchSymptoms([entry('2026-11-09T10:01:00.000Z', 'warn', 'trigger:dropped')])
    const steps = nextStepsFor(hits, '机器人没反应')
    expect(steps[0]?.kind).toBe('config')
    expect(steps[0]?.section).toBe('feishu')
  })

  it('缺陷类症状给出一键上报 issue', () => {
    const hits = matchSymptoms([entry('2026-11-09T10:02:00.000Z', 'error', 'codex:turn-failed')])
    const steps = nextStepsFor(hits, 'worker 卡住了')
    expect(steps.map(step => step.kind)).toContain('issue')
    expect(steps.find(step => step.kind === 'issue')?.issueTitle).toContain('Worker')
  })

  it('问题点名配置类症状但日志没命中时也给配置引导', () => {
    const steps = nextStepsFor([], '配置改了不生效')
    expect(steps[0]?.kind).toBe('config')
  })

  it('配置类与缺陷类同时命中时两个入口都给，缺陷不能被配置引导挡住', () => {
    const hits = matchSymptoms([
      entry('2026-11-09T10:01:00.000Z', 'warn', 'trigger:dropped'),
      entry('2026-11-09T10:02:00.000Z', 'error', 'codex:turn-failed'),
    ])
    const steps = nextStepsFor(hits, '机器人没反应')
    expect(steps.map(step => step.kind)).toEqual(['config', 'issue'])
  })

  it('正常事件不当作症状命中：消息进线与建单本身不是「没建工单」', () => {
    const hits = matchSymptoms([
      entry('2026-11-09T10:01:00.000Z', 'info', 'trigger:ingested'),
      entry('2026-11-09T10:02:00.000Z', 'info', 'thread:created'),
      entry('2026-11-09T10:03:00.000Z', 'info', 'router:decision'),
      entry('2026-11-09T10:04:00.000Z', 'info', 'launch'),
      entry('2026-11-09T10:05:00.000Z', 'info', 'api:config'),
    ])
    expect(hits).toEqual([])
  })
})

describe('nextStepsFromCauses', () => {
  it('模型标了分类才给按钮：config 给配置引导、defect 给上报', () => {
    expect(nextStepsFromCauses([{ title: 'a', detail: '', events: [], category: 'config' }]).map(step => step.kind))
      .toEqual(['config'])
    expect(nextStepsFromCauses([{ title: 'a', detail: '', events: [], category: 'defect' }]).map(step => step.kind))
      .toEqual(['issue'])
  })

  it('没有分类时不给按钮，避免给错方向', () => {
    expect(nextStepsFromCauses([{ title: 'a', detail: '', events: [] }])).toEqual([])
  })

  it('多条原因分类不同时，两个入口都给，缺陷不会被配置引导吞掉', () => {
    expect(nextStepsFromCauses([
      { title: '主因', detail: '', events: [], category: 'defect' },
      { title: '次因', detail: '', events: [], category: 'config' },
    ]).map(step => step.kind)).toEqual(['issue'])
    expect(nextStepsFromCauses([
      { title: '主因', detail: '', events: [], category: 'config' },
      { title: '次因', detail: '', events: [], category: 'defect' },
    ]).map(step => step.kind)).toEqual(['config', 'issue'])
  })
})

describe('工具调用', () => {
  let home: string
  let logPath: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ra-log-assistant-tools-'))
    mkdirSync(join(home, 'logs'), { recursive: true })
    logPath = join(home, 'logs', 'router-agent.log')
    writeFileSync(logPath, [
      `${JSON.stringify({ at: '2026-11-09T10:00:00.000Z', level: 'error', message: 'outbox:failed', error: 'http-500' })}`,
    ].join('\n') + '\n', 'utf8')
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function fakeTool(): DiagnosisTool {
    return {
      spec: {
        name: 'read_config',
        description: '读配置',
        parameters: { type: 'object', properties: {} },
      },
      run: () => '配置文件：/tmp/config.yaml',
    }
  }

  it('模型请求工具时执行工具并把结果回灌，结论里记录用过的工具', async () => {
    const bodies: string[] = []
    let round = 0
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      round += 1
      if (round === 1) {
        return jsonResponse({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'read_config', arguments: '{}' },
              }],
            },
          }],
        })
      }
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify({
          summary: '配置里允许名单是空的',
          causes: [{ title: '允许名单为空', detail: 'read_config 显示名单为空', events: [], category: 'config' }],
          actions: ['去面板补上允许名单'],
        }) } }],
      })
    }) as unknown as typeof fetch

    const assistant = createLogAssistant({
      logPath,
      model: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'chat-model' },
      tools: [fakeTool()],
      fetchImpl,
    })

    const diagnosis = await assistant.diagnose({ question: '消息没反应' })

    expect(diagnosis.source).toBe('llm')
    expect(diagnosis.toolsUsed).toEqual(['read_config'])
    expect(diagnosis.causes[0]?.category).toBe('config')
    expect(diagnosis.next?.map(step => step.kind)).toEqual(['config'])
    // 第二次请求里带上了工具结果。
    expect(bodies[1]).toContain('/tmp/config.yaml')
    expect(bodies[1]).toContain('read_config')
  })

  it('模型请求不存在的工具时把可用工具告诉它，不中断排查', async () => {
    let round = 0
    const fetchImpl = (async () => {
      round += 1
      if (round === 1) {
        return jsonResponse({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'rm_rf', arguments: '{}' },
              }],
            },
          }],
        })
      }
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ summary: '结论', causes: [], actions: [] }) } }] })
    }) as unknown as typeof fetch

    const assistant = createLogAssistant({
      logPath,
      model: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'chat-model' },
      tools: [fakeTool()],
      fetchImpl,
    })

    const diagnosis = await assistant.diagnose({ question: '消息没反应' })
    expect(diagnosis.source).toBe('llm')
    expect(diagnosis.summary).toBe('结论')
  })
})
