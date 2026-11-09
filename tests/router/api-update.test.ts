import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { createApiServer, type ApiServer, type UpdatePort } from '../../src/router/api.js'
import { defaultConfig, policyOf } from '../../src/config.js'
import { PACKAGE_VERSION, type UpdateSnapshot } from '../../src/update/index.js'

function call(server: ApiServer, method: string, path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const address = server.server.address() as AddressInfo
    const req = request({
      host: '127.0.0.1',
      port: address.port,
      path,
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
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
    if (method === 'POST') req.write('{}')
    req.end()
  })
}

function snapshot(over: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    current: PACKAGE_VERSION,
    latest: '99.0.0',
    installedVersion: null,
    hasUpdate: true,
    checkedAt: '2026-11-09T10:00:00.000Z',
    phase: 'idle',
    error: null,
    message: null,
    ...over,
  }
}

describe('版本更新 API', () => {
  let store: Store
  let engine: Engine
  let server: ApiServer | null
  let restarts: number
  let checks: boolean[]
  let upgrades: { force?: boolean }[]
  let current: UpdateSnapshot

  beforeEach(() => {
    store = new Store(':memory:')
    engine = new Engine({ store, policy: policyOf(defaultConfig()) })
    restarts = 0
    checks = []
    upgrades = []
    current = snapshot()
    server = null
  })

  afterEach(async () => {
    await server?.close()
    store.close()
  })

  async function start(port?: UpdatePort, hooks: { onEvent?: (event: { event: string; [key: string]: unknown }) => void } = {}): Promise<void> {
    server = await createApiServer({
      engine,
      store,
      config: defaultConfig(),
      update: port,
      onEvent: hooks.onEvent,
      onRestart: () => { restarts += 1 },
    })
  }

  const port: UpdatePort = {
    snapshot: () => current,
    check: async force => {
      checks.push(force === true)
      current = snapshot({ checkedAt: '2026-11-09T11:00:00.000Z' })
      return current
    },
    upgrade: async options => {
      upgrades.push(options ?? {})
      current = snapshot({
        phase: 'updated',
        hasUpdate: false,
        installedVersion: '99.0.0',
        message: '已更新到 v99.0.0，重启后生效',
      })
      return current
    },
  }

  it('GET /api/update 返回缓存快照', async () => {
    await start(port)
    const res = await call(server!, 'GET', '/api/update')
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ current: PACKAGE_VERSION, latest: '99.0.0', hasUpdate: true })
  })

  it('POST /api/update/check 强制重新检查', async () => {
    await start(port)
    const res = await call(server!, 'POST', '/api/update/check')
    expect(res.status).toBe(200)
    expect(checks).toEqual([true])
    expect(res.json.checkedAt).toBe('2026-11-09T11:00:00.000Z')
  })

  it('POST /api/update 安装成功后回包并触发自动重启', async () => {
    const events: { event: string; [key: string]: unknown }[] = []
    await start(port, { onEvent: event => events.push(event) })

    const res = await call(server!, 'POST', '/api/update')
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ phase: 'updated', restarting: true, installedVersion: '99.0.0' })
    expect(upgrades).toEqual([{ force: false }])

    // 重启在响应结束后异步执行：给 setImmediate 一拍，确认回调确实被触发。
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(restarts).toBe(1)
    expect(events.at(-1)).toMatchObject({ event: 'api:update', phase: 'updated', from: PACKAGE_VERSION, to: '99.0.0' })
  })

  it('安装失败返回 500 且不重启', async () => {
    const failing: UpdatePort = {
      snapshot: () => snapshot({ phase: 'failed', error: 'install-failed', message: 'npm ERR! EACCES' }),
      check: async () => snapshot(),
      upgrade: async () => snapshot({ phase: 'failed', error: 'install-failed', message: 'npm ERR! EACCES' }),
    }
    await start(failing)

    const res = await call(server!, 'POST', '/api/update')
    expect(res.status).toBe(500)
    expect(res.json).toMatchObject({ phase: 'failed', restarting: false })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(restarts).toBe(0)
  })

  it('未注入 update 端口时返回 404', async () => {
    await start(undefined)
    const res = await call(server!, 'GET', '/api/update')
    expect(res.status).toBe(404)
  })

  it('/api/status 带当前版本号', async () => {
    await start(port)
    const res = await call(server!, 'GET', '/api/status')
    expect(res.json.version).toBe(PACKAGE_VERSION)
  })
})