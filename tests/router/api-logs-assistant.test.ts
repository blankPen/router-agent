import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { createApiServer, type ApiServer } from '../../src/router/api.js'
import { defaultConfig, policyOf, type AppConfig } from '../../src/config.js'
import { createLogAssistant } from '../../src/router/log-assistant.js'

function call(server: ApiServer, path: string, method = 'GET', body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const address = server.server.address() as AddressInfo
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request(
      {
        host: '127.0.0.1',
        port: address.port,
        path,
        method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      res => {
        let data = ''
        res.on('data', chunk => { data += String(chunk) })
        res.on('end', () => {
          let json: any = null
          try { json = data ? JSON.parse(data) : null } catch { json = data }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function line(message: string, level = 'info'): string {
  return `${JSON.stringify({ at: '2026-11-09T10:00:00.000Z', level, message })}\n`
}

describe('/api/logs/assistant', () => {
  let store: Store
  let engine: Engine
  let config: AppConfig
  let server: ApiServer
  let home: string
  let logPath: string

  beforeEach(async () => {
    store = new Store(':memory:')
    home = mkdtempSync(join(tmpdir(), 'ra-api-assistant-'))
    mkdirSync(join(home, 'logs'), { recursive: true })
    logPath = join(home, 'logs', 'router-agent.log')
    writeFileSync(logPath, line('feishu:ready') + line('trigger:dropped', 'warn'), 'utf8')
    config = { ...defaultConfig(), home }
    engine = new Engine({ store, policy: policyOf(config) })
    server = await createApiServer({
      engine,
      store,
      config,
      logPath,
      logAssistant: createLogAssistant({ logPath }),
    })
  })

  afterEach(async () => {
    await server.close()
    store.close()
    rmSync(home, { recursive: true, force: true })
  })

  it('GET 返回模型状态与常见问题', async () => {
    const res = await call(server, '/api/logs/assistant')
    expect(res.status).toBe(200)
    expect(res.json.llmConfigured).toBe(false)
    expect(res.json.suggestions.length).toBeGreaterThan(0)
    expect(res.json.suggestions[0].example).toBeTruthy()
  })

  it('POST 给出排查结论', async () => {
    const res = await call(server, '/api/logs/assistant', 'POST', { question: '机器人没反应' })
    expect(res.status).toBe(200)
    expect(res.json.diagnosis.source).toBe('rules')
    expect(res.json.diagnosis.causes[0].title).toContain('被过滤')
    expect(res.json.diagnosis.evidence.length).toBeGreaterThan(0)
  })

  it('POST 带上级别过滤后只按该级别排查', async () => {
    const res = await call(server, '/api/logs/assistant', 'POST', { question: '机器人没反应', level: 'info' })
    expect(res.status).toBe(200)
    expect(res.json.diagnosis.evidence.every((item: { level: string }) => item.level === 'info')).toBe(true)
  })

  it('没装助手时端点返回 404', async () => {
    const bare = await createApiServer({ engine, store, config, logPath })
    try {
      const res = await call(bare, '/api/logs/assistant')
      expect(res.status).toBe(404)
      expect(res.json.error).toBe('log-assistant-not-available')
    } finally {
      await bare.close()
    }
  })
})

describe('/api/logs/assistant/issue', () => {
  let store: Store
  let engine: Engine
  let config: AppConfig
  let server: ApiServer
  let home: string
  let logPath: string
  let created: { title: string; body: string }[]

  beforeEach(async () => {
    store = new Store(':memory:')
    home = mkdtempSync(join(tmpdir(), 'ra-api-assistant-issue-'))
    mkdirSync(join(home, 'logs'), { recursive: true })
    logPath = join(home, 'logs', 'router-agent.log')
    writeFileSync(logPath, line('outbox:failed', 'error'), 'utf8')
    config = { ...defaultConfig(), home }
    engine = new Engine({ store, policy: policyOf(config) })
    created = []
    server = await createApiServer({
      engine,
      store,
      config,
      logPath,
      logAssistant: createLogAssistant({ logPath }),
      issueReporter: {
        async create(input) {
          created.push(input)
          return { number: 7, url: 'https://github.com/blankPen/router-agent/issues/7' }
        },
      },
    })
  })

  afterEach(async () => {
    await server.close()
    store.close()
    rmSync(home, { recursive: true, force: true })
  })

  const diagnosis = {
    summary: '投递失败了',
    causes: [{ title: '通道没注册', detail: 'outbox:failed', events: ['outbox:failed'] }],
    actions: ['检查通道注册'],
    evidence: [{ at: '2026-11-09T10:00:00.000Z', level: 'error', message: 'outbox:failed', detail: 'error=http-500' }],
    source: 'rules',
  }

  it('把问题与结论贴成 issue 并返回链接', async () => {
    const res = await call(server, '/api/logs/assistant/issue', 'POST', { question: '消息没发出去', diagnosis })
    expect(res.status).toBe(200)
    expect(res.json.issue).toEqual({ number: 7, url: 'https://github.com/blankPen/router-agent/issues/7' })
    expect(created[0]?.title).toContain('消息没发出去')
    expect(created[0]?.body).toContain('## 证据日志')
    expect(created[0]?.body).toContain('outbox:failed')
  })

  it('前端给了标题就用它，不用兜底标题', async () => {
    const res = await call(server, '/api/logs/assistant/issue', 'POST', {
      question: '消息没发出去',
      title: '[排查助手] Worker 卡住 / 执行失败',
      diagnosis,
    })
    expect(res.status).toBe(200)
    expect(created[0]?.title).toBe('[排查助手] Worker 卡住 / 执行失败')
  })

  it('缺少排查结论时返回 400', async () => {
    const res = await call(server, '/api/logs/assistant/issue', 'POST', { question: '消息没发出去' })
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('diagnosis-required')
    expect(created).toHaveLength(0)
  })

  it('没装上报器时端点返回 404', async () => {
    const bare = await createApiServer({ engine, store, config, logPath })
    try {
      const res = await call(bare, '/api/logs/assistant/issue', 'POST', { question: 'x', diagnosis })
      expect(res.status).toBe(404)
      expect(res.json.error).toBe('issue-report-not-available')
    } finally {
      await bare.close()
    }
  })

  it('上报失败时返回 500 并记录 api:issue-create-failed 事件', async () => {
    const events: { level: string; message: string; extra: Record<string, unknown> }[] = []
    const push = (level: string) => (message: string, extra: Record<string, unknown> = {}) => {
      events.push({ level, message, extra })
    }
    const failing = await createApiServer({
      engine,
      store,
      config,
      logPath,
      logger: { info: push('info'), warn: push('warn'), error: push('error') },
      issueReporter: {
        async create() {
          throw new Error('gh 退出码 1')
        },
      },
    })
    try {
      const res = await call(failing, '/api/logs/assistant/issue', 'POST', { question: 'x', diagnosis })
      expect(res.status).toBe(500)
      expect(res.json.error).toBe('issue-create-failed')
      const event = events.find(item => item.message === 'api:issue-create-failed')
      expect(event?.level).toBe('error')
      expect(String(event?.extra.detail)).toContain('gh 退出码 1')
    } finally {
      await failing.close()
    }
  })
})
