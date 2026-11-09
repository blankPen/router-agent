import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { createApiServer, type ApiServer } from '../../src/router/api.js'
import { defaultConfig, policyOf, type AppConfig } from '../../src/config.js'

function call(server: ApiServer, path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const address = server.server.address() as AddressInfo
    const req = request({ host: '127.0.0.1', port: address.port, path, method: 'GET' }, res => {
      let data = ''
      res.on('data', chunk => { data += String(chunk) })
      res.on('end', () => {
        let json: any = null
        try { json = data ? JSON.parse(data) : null } catch { json = data }
        resolve({ status: res.statusCode ?? 0, json })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function line(message: string): string {
  return `${JSON.stringify({ at: '2026-11-09T10:00:00.000Z', level: 'info', message })}\n`
}

describe('GET /api/logs', () => {
  let store: Store
  let engine: Engine
  let config: AppConfig
  let server: ApiServer
  let home: string
  let logPath: string

  beforeEach(async () => {
    store = new Store(':memory:')
    home = mkdtempSync(join(tmpdir(), 'ra-api-logs-'))
    mkdirSync(join(home, 'logs'), { recursive: true })
    logPath = join(home, 'logs', 'router-agent.log')
    writeFileSync(logPath, line('api:listening') + line('trigger:ingested'), 'utf8')
    config = { ...defaultConfig(), home }
    engine = new Engine({ store, policy: policyOf(config) })
    server = await createApiServer({ engine, store, config })
  })

  afterEach(async () => {
    await server.close()
    store.close()
    rmSync(home, { recursive: true, force: true })
  })

  it('首次读取返回尾部日志与游标', async () => {
    const res = await call(server, '/api/logs?limit=10')
    expect(res.status).toBe(200)
    expect(res.json.exists).toBe(true)
    expect(res.json.path).toBe(logPath)
    expect(res.json.entries.map((entry: { message: string }) => entry.message)).toEqual(['api:listening', 'trigger:ingested'])
    expect(res.json.cursor).toBeGreaterThan(0)
  })

  it('带 cursor 只返回新增行', async () => {
    const first = await call(server, '/api/logs')
    appendFileSync(logPath, line('report:received'), 'utf8')
    const next = await call(server, `/api/logs?cursor=${first.json.cursor}`)
    expect(next.status).toBe(200)
    expect(next.json.entries.map((entry: { message: string }) => entry.message)).toEqual(['report:received'])
  })

  it('日志文件不存在时返回空结果而不是报错', async () => {
    rmSync(logPath)
    const res = await call(server, '/api/logs')
    expect(res.status).toBe(200)
    expect(res.json.exists).toBe(false)
    expect(res.json.entries).toEqual([])
  })

  it('未配置 home 时返回空结果', async () => {
    const bare = await createApiServer({ engine, store, config: defaultConfig() })
    try {
      const res = await call(bare, '/api/logs')
      expect(res.status).toBe(200)
      expect(res.json.exists).toBe(false)
      expect(res.json.path).toBe('')
    } finally {
      await bare.close()
    }
  })

  it('非法 cursor 返回 400', async () => {
    const res = await call(server, '/api/logs?cursor=abc')
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('invalid-cursor')
  })

  it('logPath 选项可覆盖默认日志文件位置', async () => {
    const custom = join(home, 'custom.log')
    writeFileSync(custom, line('custom-entry'), 'utf8')
    const other = await createApiServer({ engine, store, config, logPath: custom })
    try {
      const res = await call(other, '/api/logs')
      expect(res.json.path).toBe(custom)
      expect(res.json.entries[0].message).toBe('custom-entry')
    } finally {
      await other.close()
    }
  })
})
