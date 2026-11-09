import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { createApiServer, type ApiServer } from '../../src/router/api.js'
import { defaultConfig, policyOf, type AppConfig } from '../../src/config.js'
import { specPath } from '../../src/specs/index.js'

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

describe('规范 markdown API', () => {
  let store: Store
  let engine: Engine
  let config: AppConfig
  let server: ApiServer
  let home: string

  beforeEach(async () => {
    store = new Store(':memory:')
    home = mkdtempSync(join(tmpdir(), 'ra-api-specs-'))
    config = { ...defaultConfig(), home }
    engine = new Engine({ store, policy: policyOf(config) })
    server = await createApiServer({ engine, store, config })
  })

  afterEach(async () => {
    await server.close()
    store.close()
    rmSync(home, { recursive: true, force: true })
  })

  it('GET /api/specs 返回全部规范与当前内容', async () => {
    const res = await call(server, 'GET', '/api/specs')
    expect(res.status).toBe(200)
    expect(res.json.specs).toHaveLength(7)
    const soul = res.json.specs.find((spec: { id: string }) => spec.id === 'router.soul')
    expect(soul.isCustom).toBe(false)
    expect(soul.content.length).toBeGreaterThan(0)
  })

  it('PUT /api/specs/:id 保存覆盖内容并落盘', async () => {
    const saved = await call(server, 'PUT', '/api/specs/router.soul', { content: '# 面板编辑\n' })
    expect(saved.status).toBe(200)
    expect(saved.json.spec).toMatchObject({ id: 'router.soul', isCustom: true, content: '# 面板编辑\n' })
    expect(readFileSync(specPath(home, 'router.soul'), 'utf8')).toBe('# 面板编辑\n')

    const detail = await call(server, 'GET', '/api/specs/router.soul')
    expect(detail.status).toBe(200)
    expect(detail.json.spec.content).toBe('# 面板编辑\n')
  })

  it('PUT 拒绝空内容与未知规范', async () => {
    const empty = await call(server, 'PUT', '/api/specs/router.soul', { content: '  ' })
    expect(empty.status).toBe(400)
    expect(empty.json.error).toBe('empty-content')

    const unknown = await call(server, 'PUT', '/api/specs/router.nope', { content: 'x' })
    expect(unknown.status).toBe(404)
    expect(unknown.json.error).toBe('unknown-spec')
  })

  it('POST /api/specs/:id/reset 删除覆盖文件并恢复内置内容', async () => {
    const builtin = (await call(server, 'GET', '/api/specs/router.orchestrator')).json.spec.content
    await call(server, 'PUT', '/api/specs/router.orchestrator', { content: '自定义' })
    expect(existsSync(specPath(home, 'router.orchestrator'))).toBe(true)

    const reset = await call(server, 'POST', '/api/specs/router.orchestrator/reset')
    expect(reset.status).toBe(200)
    expect(reset.json.spec.isCustom).toBe(false)
    expect(reset.json.spec.content).toBe(builtin)
    expect(existsSync(specPath(home, 'router.orchestrator'))).toBe(false)
  })
})
