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
