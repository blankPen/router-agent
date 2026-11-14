import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { createApiServer, type ApiServer } from '../../src/router/api.js'
import { EventBus } from '../../src/router/event-bus.js'
import { EventWebhookGateway } from '../../src/router/event-sources.js'
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
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
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
  let store: Store
  let engine: Engine
  let server: ApiServer
  let config: AppConfig
  let bus: EventBus

  beforeEach(async () => {
    store = new Store(':memory:')
    config = defaultConfig()
    config.event.enabled = true
    config.event.sources = [{
      id: 'ops-hook',
      type: 'webhook',
      mode: 'webhook',
      repos: [],
      labels: [],
      state: '',
      intervalMs: 60_000,
      cron: '',
      path: '/api/events/in/ops-hook',
      secretRef: 'RA_EVENT_OPS_TOKEN',
      notifyChat: '',
      project: 'router-agent',
      priorityHint: 50,
      costClass: 'cheap',
      lane: '',
    }]
    let n = 0
    engine = new Engine({ store, policy: policyOf(config), clock: { now: () => '2026-11-06T10:00:00.000Z' }, ids: { next: p => `${p}_${++n}` } })
    bus = new EventBus({
      store,
      engine,
      settings: () => config.event,
      clock: { now: () => '2026-11-06T10:00:00.000Z' },
      ids: { next: p => `${p}_${++n}` },
      resolveDispatch: () => ({ repo: '/repos/router-agent', branch: 'main', missing: [] }),
    })
    const gateway = new EventWebhookGateway({
      config: () => config.event,
      store,
      runner: { async run() { return { code: 0, stdout: '', stderr: '' } } },
      env: { RA_EVENT_OPS_TOKEN: 'tok' },
      clock: { now: () => '2026-11-06T10:00:00.000Z' },
    })
    server = await createApiServer({ engine, store, config, eventBus: bus, eventWebhook: gateway })
  })

  afterEach(async () => {
    await server.close()
  })

  it('webhook 鉴权不过时拒绝入队', async () => {
    const res = await call(server, 'POST', '/api/events/in/ops-hook', { id: 'evt-1', type: 'alert.fired', subject: 'svc/api', summary: '5xx 突增', actor: { id: 'u1', name: '监控' } })
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('event:token-invalid')
  })

  it('webhook 通过鉴权后事件入队并可列出', async () => {
    const res = await call(server, 'POST', '/api/events/in/ops-hook', { id: 'evt-1', type: 'alert.fired', subject: 'svc/api', summary: '5xx 突增', actor: { id: 'u1', name: '监控' } }, { Authorization: 'Bearer tok' })
    expect(res.status).toBe(201)
    expect(res.json.accepted).toBe(true)
    const list = await call(server, 'GET', '/api/events')
    expect(list.json.events).toHaveLength(1)
    expect(list.json.events[0].event.subject).toBe('svc/api')
  })

  it('同一事件重复投递不会产生第二条', async () => {
    const body = { id: 'evt-1', type: 'alert.fired', subject: 'svc/api', summary: '5xx 突增', actor: { id: 'u1', name: '监控' } }
    await call(server, 'POST', '/api/events/in/ops-hook', body, { Authorization: 'Bearer tok' })
    const again = await call(server, 'POST', '/api/events/in/ops-hook', body, { Authorization: 'Bearer tok' })
    expect(again.status).toBe(200)
    expect(again.json.duplicate).toBe(true)
    const list = await call(server, 'GET', '/api/events')
    expect(list.json.events).toHaveLength(1)
  })

  it('统计接口给出队列现状', async () => {
    await call(server, 'POST', '/api/events/in/ops-hook', { id: 'evt-1', type: 'alert.fired', subject: 'svc/api', summary: '5xx', actor: { id: 'u1', name: '监控' } }, { Authorization: 'Bearer tok' })
    const stats = await call(server, 'GET', '/api/events/stats')
    expect(stats.json.stats.total).toBe(1)
    expect(stats.json.stats.byState.queued).toBe(1)
  })

  it('成本闸门配置可读可写', async () => {
    const before = await call(server, 'GET', '/api/events/config')
    expect(before.json.event.enabled).toBe(true)
    const saved = await call(server, 'PUT', '/api/events/config', { 'event.budget.dailyEvents': 20 })
    expect(saved.status).toBe(200)
    expect(saved.json.event.budget.dailyEvents).toBe(20)
  })

  it('时间窗写坏时返回校验错误', async () => {
    const res = await call(server, 'PUT', '/api/events/config', { 'event.windows': [{ id: 'w', from: '9:00', to: '20:00', allow: ['t0'] }] })
    expect(res.status).toBe(400)
    expect(res.json.errors[0].path).toBe('event.windows')
  })
})
