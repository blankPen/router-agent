import { describe, expect, it } from 'vitest'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { createApiServer, type ApiServer } from '../../src/router/api.js'
import { defaultConfig, policyOf, type AppConfig } from '../../src/config.js'

function call(server: ApiServer, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
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
        resolve({ status: res.statusCode ?? 0, json })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

describe('事件 API', () => {
  it('列表、操作与注入都走事件端口', async () => {
    const store = new Store(':memory:')
    const config: AppConfig = defaultConfig()
    config.events.enabled = true
    config.events.sources.http = { enabled: true, kind: 'http', path: '/api/events/inject' }
    const engine = new Engine({ store, policy: policyOf(config), ids: { next: p => `${p}_1` } })
    const applied: Array<{ eventId: string; action: string }> = []
    const injected: Array<{ sourceId: string; externalId: string }> = []
    const api = await createApiServer({
      engine,
      store,
      config,
      events: {
        listEvents: () => [{ id: 'evt_1', title: '崩溃', priority: 'P1', status: 'review' }],
        listSources: () => [{ id: 'github', kind: 'github', enabled: true }],
        apply: async (eventId, action) => {
          applied.push({ eventId, action })
          return { id: eventId, status: 'pending' }
        },
        inject: (sourceId, envelope) => {
          injected.push({ sourceId, externalId: envelope.externalId })
          return { id: 'evt_2', title: envelope.title }
        },
        decision: () => ({ provider: 'rule', prompt: 'x', confidenceThreshold: 0.6, fallback: 'review', version: 3 }),
        sourceSecrets: () => ({ http: true }),
        counts: () => ({ pending: 0, review: 0, done: 0, invalid: 0 }),
      },
    })
    try {
      const list = await call(api, 'GET', '/api/events')
      expect(list.status).toBe(200)
      expect(list.json.events).toHaveLength(1)
      expect(list.json.decision.version).toBe(3)

      const action = await call(api, 'POST', '/api/events/evt_1/action', { action: 'approve' })
      expect(action.status).toBe(200)
      expect(applied[0]).toEqual({ eventId: 'evt_1', action: 'approve' })

      const invalid = await call(api, 'POST', '/api/events/evt_1/action', { action: 'explode' })
      expect(invalid.status).toBe(400)

      const inject = await call(api, 'POST', '/api/events/inject', { sourceId: 'http', externalId: 'x#1', title: '标题', body: '正文' })
      expect(inject.status).toBe(201)
      expect(injected[0]).toEqual({ sourceId: 'http', externalId: 'x#1' })
    } finally {
      await api.close()
    }
  })

  it('注入接口按来源配置的路径接收事件，挪走路径后默认路径不再接收', async () => {
    const store = new Store(':memory:')
    const config: AppConfig = defaultConfig()
    config.events.enabled = true
    config.events.sources.http = { enabled: true, kind: 'http', path: '/api/events/hook' }
    const engine = new Engine({ store, policy: policyOf(config), ids: { next: p => `${p}_1` } })
    const injected: Array<{ sourceId: string; externalId: string }> = []
    const api = await createApiServer({
      engine,
      store,
      config,
      events: {
        listEvents: () => [],
        listSources: () => [],
        apply: async () => null,
        inject: (sourceId, envelope) => {
          injected.push({ sourceId, externalId: envelope.externalId })
          return { id: 'evt_2' }
        },
        decision: () => ({ provider: 'rule', prompt: '', confidenceThreshold: 0.6, fallback: 'review', version: 1 }),
        sourceSecrets: () => ({ http: true }),
        counts: () => ({ pending: 0, review: 0, done: 0, invalid: 0 }),
      },
    })
    try {
      const hooked = await call(api, 'POST', '/api/events/hook', { externalId: 'x#1', title: 't', body: 'b' })
      expect(hooked.status).toBe(201)
      expect(injected[0]).toEqual({ sourceId: 'http', externalId: 'x#1' })

      const legacy = await call(api, 'POST', '/api/events/inject', { externalId: 'x#2', title: 't', body: 'b' })
      expect(legacy.status).toBe(404)
      expect(injected).toHaveLength(1)
    } finally {
      await api.close()
    }
  })

  it('注入超过来源每分钟上限时返回 429', async () => {
    const store = new Store(':memory:')
    const config: AppConfig = defaultConfig()
    config.events.enabled = true
    config.events.sources.http = { enabled: true, kind: 'http', path: '/api/events/inject' }
    const engine = new Engine({ store, policy: policyOf(config), ids: { next: p => `${p}_1` } })
    const api = await createApiServer({
      engine,
      store,
      config,
      events: {
        listEvents: () => [],
        listSources: () => [],
        apply: async () => null,
        inject: () => { throw new Error('event:rate-limited') },
        decision: () => ({ provider: 'rule', prompt: '', confidenceThreshold: 0.6, fallback: 'review', version: 1 }),
        sourceSecrets: () => ({ http: true }),
        counts: () => ({ pending: 0, review: 0, done: 0, invalid: 0 }),
      },
    })
    try {
      const limited = await call(api, 'POST', '/api/events/inject', { sourceId: 'http', externalId: 'x#1', title: 't', body: 'b' })
      expect(limited.status).toBe(429)
    } finally {
      await api.close()
    }
  })

  it('注入的密钥不对时拒绝', async () => {
    const store = new Store(':memory:')
    const config: AppConfig = defaultConfig()
    config.events.enabled = true
    config.events.sources.http = { enabled: true, kind: 'http', secret: 's3cret' }
    const engine = new Engine({ store, policy: policyOf(config), ids: { next: p => `${p}_1` } })
    const api = await createApiServer({
      engine,
      store,
      config,
      events: {
        listEvents: () => [],
        listSources: () => [],
        apply: async () => null,
        inject: () => ({ id: 'evt_2' }),
        decision: () => ({ provider: 'rule', prompt: '', confidenceThreshold: 0.6, fallback: 'review', version: 1 }),
        sourceSecrets: () => ({ http: true }),
        counts: () => ({ pending: 0, review: 0, done: 0, invalid: 0 }),
      },
    })
    try {
      const rejected = await call(api, 'POST', '/api/events/inject', { sourceId: 'http', externalId: 'x#1', title: 't', body: 'b' })
      expect(rejected.status).toBe(401)
      const accepted = await call(api, 'POST', '/api/events/inject', { sourceId: 'http', externalId: 'x#1', title: 't', body: 'b' }, { 'x-ra-event-secret': 's3cret' })
      expect(accepted.status).toBe(201)
    } finally {
      await api.close()
    }
  })
})

describe('事件注入的开关检查', () => {
  it('总开关关着时注入接口拒绝', async () => {
    const store = new Store(':memory:')
    const config: AppConfig = defaultConfig()
    config.events.enabled = false
    config.events.sources.http = { enabled: true, kind: 'http', path: '/api/events/inject', secret: 's3cret' }
    const engine = new Engine({ store, policy: policyOf(config), ids: { next: p => `${p}_1` } })
    const injected: Array<{ externalId: string }> = []
    const api = await createApiServer({
      engine, store, config,
      events: {
        listEvents: () => [], listSources: () => [], apply: async () => null,
        inject: (_sourceId, envelope) => { injected.push(envelope); return { id: 'evt_1' } },
        decision: () => ({ provider: 'rule', prompt: '', confidenceThreshold: 0.6, fallback: 'review', version: 1 }),
        sourceSecrets: () => ({ http: true }),
        counts: () => ({ pending: 0, review: 0, done: 0, invalid: 0 }),
      },
    })
    try {
      const res = await call(api, 'POST', '/api/events/inject', { externalId: 'x#1', title: 't', body: 'b' }, { 'x-ra-event-secret': 's3cret' })
      expect(res.status).toBe(404)
      expect(injected).toHaveLength(0)
    } finally { await api.close() }
  })

  it('来源开关关着时注入接口拒绝', async () => {
    const store = new Store(':memory:')
    const config: AppConfig = defaultConfig()
    config.events.enabled = true
    config.events.sources.http = { enabled: false, kind: 'http', path: '/api/events/inject', secret: 's3cret' }
    const engine = new Engine({ store, policy: policyOf(config), ids: { next: p => `${p}_1` } })
    const injected: Array<{ externalId: string }> = []
    const api = await createApiServer({
      engine, store, config,
      events: {
        listEvents: () => [], listSources: () => [], apply: async () => null,
        inject: (_sourceId, envelope) => { injected.push(envelope); return { id: 'evt_1' } },
        decision: () => ({ provider: 'rule', prompt: '', confidenceThreshold: 0.6, fallback: 'review', version: 1 }),
        sourceSecrets: () => ({ http: true }),
        counts: () => ({ pending: 0, review: 0, done: 0, invalid: 0 }),
      },
    })
    try {
      const res = await call(api, 'POST', '/api/events/inject', { externalId: 'x#1', title: 't', body: 'b' }, { 'x-ra-event-secret': 's3cret' })
      expect(res.status).toBe(404)
      expect(injected).toHaveLength(0)
    } finally { await api.close() }
  })
})
