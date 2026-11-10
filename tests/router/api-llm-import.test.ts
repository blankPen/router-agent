import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { parse as parseYaml } from 'yaml'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { createApiServer, type ApiServer } from '../../src/router/api.js'
import { defaultConfig, loadConfig, policyOf, type AppConfig } from '../../src/config.js'
import type { LocalProviderScan } from '../../src/router/provider-import.js'

function call(server: ApiServer, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const address = server.server.address() as AddressInfo
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request({
      host: '127.0.0.1',
      port: address.port,
      path,
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, res => {
      let data = ''
      res.on('data', chunk => { data += String(chunk) })
      res.on('end', () => {
        let json: any = null
        try { json = data ? JSON.parse(data) : null } catch { json = data }
        resolve({ status: res.statusCode ?? 0, json })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

const CANDIDATE = {
  id: 'cc-switch:claude:c1',
  source: 'cc-switch' as const,
  sourceLabel: 'CCSwitch',
  name: 'CCSwitch · Zhipu',
  baseUrl: 'https://open.bigmodel.cn/api/anthropic',
  model: 'glm-4.6',
  api: 'anthropic-messages' as const,
  authHeader: true,
  apiKey: 'sk-import-secret',
}

describe('LLM Provider 本地导入 API', () => {
  let store: Store
  let server: ApiServer
  let config: AppConfig
  let home: string
  let scan: LocalProviderScan
  let scanError: Error | null

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'ra-api-import-'))
    store = new Store(':memory:')
    config = defaultConfig()
    config.home = home
    scan = {
      candidates: [CANDIDATE],
      sources: [{ id: 'cc-switch', label: 'CCSwitch', path: join(home, '.cc-switch', 'cc-switch.db'), found: true }],
    }
    scanError = null
    const engine = new Engine({ store, policy: policyOf(config) })
    server = await createApiServer({
      engine,
      store,
      config,
      localProviders: {
        async discover() {
          if (scanError) throw scanError
          return scan
        },
      },
    })
  })

  afterEach(async () => {
    await server.close()
    store.close()
  })

  it('GET 返回候选列表但不泄露明文密钥', async () => {
    const res = await call(server, 'GET', '/api/llm/local-providers')
    expect(res.status).toBe(200)
    expect(res.json.candidates).toEqual([{
      id: CANDIDATE.id,
      source: 'cc-switch',
      sourceLabel: 'CCSwitch',
      name: CANDIDATE.name,
      baseUrl: CANDIDATE.baseUrl,
      model: CANDIDATE.model,
      api: CANDIDATE.api,
      authHeader: true,
      apiKeySet: true,
    }])
    expect(res.json.sources[0]).toMatchObject({ id: 'cc-switch', found: true })
    expect(JSON.stringify(res.json)).not.toContain('sk-import-secret')
  })

  it('POST 导入后写回 config.yaml，并返回需要重启', async () => {
    const res = await call(server, 'POST', '/api/llm/local-providers/import', { id: CANDIDATE.id })
    expect(res.status).toBe(200)
    expect(res.json.ok).toBe(true)
    expect(res.json.restartRequired).toBe(true)
    expect(res.json.imported).toMatchObject({ source: 'cc-switch', model: 'glm-4.6' })
    expect(res.json.config.llm).toMatchObject({
      baseUrl: CANDIDATE.baseUrl,
      model: CANDIDATE.model,
      api: 'anthropic-messages',
      authHeader: true,
      apiKeySet: true,
    })
    expect(JSON.stringify(res.json)).not.toContain('sk-import-secret')

    const written = parseYaml(readFileSync(join(home, 'config.yaml'), 'utf8')) as { llm?: Record<string, unknown> }
    expect(written.llm).toMatchObject({
      baseUrl: CANDIDATE.baseUrl,
      model: CANDIDATE.model,
      api: 'anthropic-messages',
      authHeader: true,
      apiKey: 'sk-import-secret',
    })
    // 重新从磁盘加载也应保留协议与鉴权方式。
    expect(loadConfig(home).llm).toMatchObject({ api: 'anthropic-messages', authHeader: true })
  })

  it('候选已消失时返回 404', async () => {
    scan = { candidates: [], sources: [] }
    const res = await call(server, 'POST', '/api/llm/local-providers/import', { id: CANDIDATE.id })
    expect(res.status).toBe(404)
    expect(res.json.error).toBe('provider-not-found')
  })

  it('缺少 id 时返回 400', async () => {
    const res = await call(server, 'POST', '/api/llm/local-providers/import', {})
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('id-required')
  })

  it('扫描异常时返回 500，不把异常抛给外层', async () => {
    scanError = new Error('scan exploded')
    const res = await call(server, 'GET', '/api/llm/local-providers')
    expect(res.status).toBe(500)
    expect(res.json.error).toBe('llm-import-scan-failed')
  })
})
