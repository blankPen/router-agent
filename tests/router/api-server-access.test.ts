/**
 * 面板的对外访问：监听地址 + 访问令牌。
 *
 * 只监听 127.0.0.1 时一切照旧；配了令牌后，所有请求都要带令牌。
 */
import { describe, expect, it } from 'vitest'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { createApiServer, type ApiServer } from '../../src/router/api.js'
import { defaultConfig, policyOf, type AppConfig } from '../../src/config.js'

function call(
  server: ApiServer,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: any; headers: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const address = server.server.address() as AddressInfo
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request({
      host: '127.0.0.1',
      port: address.port,
      path,
      method,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers },
    }, res => {
      let data = ''
      res.on('data', chunk => { data += String(chunk) })
      res.on('end', () => {
        let json: any = null
        try { json = data ? JSON.parse(data) : null } catch { json = data }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function makeServer(config: AppConfig, logs: Array<{ message: string; extra?: Record<string, unknown> }> = []): Promise<ApiServer> {
  const store = new Store(':memory:')
  const engine = new Engine({ store, policy: policyOf(config), ids: { next: p => `${p}_1` } })
  return createApiServer({
    engine,
    store,
    config,
    logger: {
      info: () => {},
      warn: (message, extra) => { logs.push({ message, ...(extra ? { extra } : {}) }) },
      error: () => {},
    },
  })
}

describe('面板对外访问', () => {
  it('只监听 127.0.0.1 时不接受外部连接', async () => {
    const config = defaultConfig()
    const server = await makeServer(config)
    const address = server.server.address() as AddressInfo
    expect(address.address).toBe('127.0.0.1')
    await server.close()
  })

  it('对外开放却没有令牌时拒绝启动，不开谁都能用的口子', async () => {
    const config = defaultConfig()
    config.server.host = '0.0.0.0'
    await expect(makeServer(config)).rejects.toThrow('访问令牌')
  })

  it('host 配成 0.0.0.0 时监听所有网卡', async () => {
    const config = defaultConfig()
    config.server.host = '0.0.0.0'
    config.server.token = 'lan-secret-token'
    const server = await makeServer(config)
    const address = server.server.address() as AddressInfo
    expect(address.address).toBe('0.0.0.0')
    await server.close()
  })

  it('配了令牌后，没带令牌的请求被拒绝并写告警日志', async () => {
    const config = defaultConfig()
    config.server.host = '0.0.0.0'
    config.server.token = 'lan-secret-token'
    const logs: Array<{ message: string; extra?: Record<string, unknown> }> = []
    const server = await makeServer(config, logs)

    const denied = await call(server, 'GET', '/api/status')
    expect(denied.status).toBe(401)
    expect(denied.json.error).toBe('token-required')
    expect(logs.some(log => log.message === 'api:access-denied')).toBe(true)
    await server.close()
  })

  it('配了令牌后，带正确请求头的请求正常通过', async () => {
    const config = defaultConfig()
    config.server.host = '0.0.0.0'
    config.server.token = 'lan-secret-token'
    const server = await makeServer(config)

    const allowed = await call(server, 'GET', '/api/status', { 'x-ra-token': 'lan-secret-token' })
    expect(allowed.status).toBe(200)
    await server.close()
  })

  it('没配令牌时不拦截请求', async () => {
    const config = defaultConfig()
    const server = await makeServer(config)

    const allowed = await call(server, 'GET', '/api/status')
    expect(allowed.status).toBe(200)
    await server.close()
  })

  it('事件注入口不拦：外部系统用来源自己的密钥鉴权', async () => {
    const config = defaultConfig()
    config.server.host = '0.0.0.0'
    config.server.token = 'lan-secret-token'
    config.events.enabled = true
    config.events.sources.http = { enabled: true, kind: 'http', path: '/api/events/inject' }
    const injected: string[] = []
    const store = new Store(':memory:')
    const engine = new Engine({ store, policy: policyOf(config), ids: { next: p => `${p}_1` } })
    const server = await createApiServer({
      engine,
      store,
      config,
      events: {
        listEvents: () => [],
        listSources: () => [],
        apply: async () => null,
        inject: (sourceId) => { injected.push(sourceId); return { id: 'evt_1' } },
        decision: () => ({ provider: 'rule', prompt: '', confidenceThreshold: 0.6, fallback: 'review', version: 1 }),
        sourceSecrets: () => ({ http: true }),
        counts: () => ({ pending: 0, review: 0, done: 0, invalid: 0 }),
      },
    })

    const res = await call(server, 'POST', '/api/events/inject', { sourceId: 'http', title: 't' })
    // 没带来源密钥也不该被面板令牌拦下：这一路有自己的鉴权。
    expect(res.status).toBe(201)
    expect(injected).toEqual(['http'])
    await server.close()
  })

  it('静态资源不拦：面板外壳本身不含敏感信息', async () => {
    const config = defaultConfig()
    config.server.host = '0.0.0.0'
    config.server.token = 'lan-secret-token'
    const server = await makeServer(config)

    const res = await call(server, 'GET', '/index.html')
    expect(res.status).not.toBe(401)
    await server.close()
  })
})
