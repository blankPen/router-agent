import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { createApiServer, type ApiServer } from '../../src/router/api.js'
import { DEFAULT_ADMISSION, type Policy } from '../../src/core/policy.js'
import { defaultConfig, type AppConfig, chatEntry } from '../../src/config.js'

const policy: Policy = {
  version: 'p1',
  acceptMode: 'auto',
  maxWorkers: 4,
  allowed: ['ou_alice'],
  bots: [],
  admission: DEFAULT_ADMISSION,
  receiveAll: true,
}

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

describe('HTTP 管理 API', () => {
  let store: Store
  let engine: Engine
  let server: ApiServer
  let config: AppConfig
  let ticketId: string
  let assignmentId: string
  let events: { event: string; [key: string]: unknown }[]
  let reports: Record<string, unknown>[]

  beforeEach(async () => {
    store = new Store(':memory:')
    let n = 0
    engine = new Engine({ store, policy, clock: { now: () => '2026-11-06T10:00:00.000Z' }, ids: { next: p => `${p}_${++n}` } })
    config = { ...defaultConfig(), feishu: { ...defaultConfig().feishu, chats: [chatEntry('oc_dev')], botOpenIds: ['ou_bot'] } }
    events = []
    reports = []
    server = await createApiServer({
      engine, store, config,
      clock: { now: () => '2026-11-06T10:00:05.000Z' },
      onEvent: event => events.push(event),
      onReport: state => { reports.push(state as unknown as Record<string, unknown>) },
    })

    engine.ingest({
      id: 't1', source: 'feishu', externalId: 'om_1', threadId: 'feishu:oc_dev:om_root', chatId: 'oc_dev', chatName: '研发群',
      actorId: 'ou_alice', actorName: 'Alice', isBot: false, text: '改登录超时', addressed: 'mention',
      receivedAt: '2026-11-06T09:59:00.000Z', disposition: 'pending',
    })
    const outcome = engine.decide({ triggerId: 't1', decision: 'accept', strength: 'explicit', reason: 'ok', title: '改登录超时' })
    ticketId = outcome.ticket!.id
    assignmentId = engine.startAssignment(ticketId, { backendId: 'orca', handle: 'h1', workdir: '/tmp/wt' }).id
  })

  afterEach(async () => {
    await server.close()
    store.close()
  })

  it('GET /api/tickets 按 stage 过滤并返回工单', async () => {
    const all = await call(server, 'GET', '/api/tickets')
    expect(all.status).toBe(200)
    expect(all.json.tickets).toHaveLength(1)
    const none = await call(server, 'GET', '/api/tickets?stage=running')
    expect(none.json.tickets).toHaveLength(0)
    const accepted = await call(server, 'GET', '/api/tickets?stage=assigned')
    expect(accepted.json.tickets[0].id).toBe(ticketId)
  })

  it('GET /api/tickets/:id 返回工单、Mandate、派工与输入', async () => {
    const res = await call(server, 'GET', `/api/tickets/${ticketId}`)
    expect(res.status).toBe(200)
    expect(res.json.ticket.id).toBe(ticketId)
    expect(res.json.mandate.ticketId).toBe(ticketId)
    expect(res.json.assignment.id).toBe(assignmentId)
  })

  it('POST /api/tickets/:id/input 投递 follow-up', async () => {
    const res = await call(server, 'POST', `/api/tickets/${ticketId}/input`, { kind: 'followup', text: '顺便补测试' })
    expect(res.status).toBe(201)
    expect(res.json.input.text).toBe('顺便补测试')
    expect(store.pendingInputs(ticketId)).toHaveLength(1)
    expect(events.find(event => event.event === 'api:input')).toMatchObject({ ticketId, text: '顺便补测试' })
  })

  it('POST /api/tickets/:id/stop 结束工单', async () => {
    const res = await call(server, 'POST', `/api/tickets/${ticketId}/stop`, { reason: '人工停止' })
    expect(res.status).toBe(200)
    expect(store.getTicket(ticketId)?.stage).toBe('closed')
    expect(events.find(event => event.event === 'api:stop')).toMatchObject({ ticketId })
  })

  it('GET / PUT /api/policy 读写策略', async () => {
    const before = await call(server, 'GET', '/api/policy')
    expect(before.json.policy.acceptMode).toBe('auto')
    const updated = await call(server, 'PUT', '/api/policy', { acceptMode: 'observe', maxWorkers: 2 })
    expect(updated.status).toBe(200)
    expect(updated.json.policy.acceptMode).toBe('observe')
    expect(updated.json.policy.maxWorkers).toBe(2)
    expect(engine.policy().acceptMode).toBe('observe')
  })

  it('PUT /api/policy 拒绝非法 acceptMode', async () => {
    const res = await call(server, 'PUT', '/api/policy', { acceptMode: 'yolo' })
    expect(res.status).toBe(400)
  })

  it('GET /api/sources/feishu/chats 返回配置的群', async () => {
    const res = await call(server, 'GET', '/api/sources/feishu/chats')
    expect(res.json.chats).toEqual([chatEntry('oc_dev')])
  })

  it('GET /api/status 汇总活跃工单与后端状态', async () => {
    const res = await call(server, 'GET', '/api/status')
    expect(res.json.stage).toBe('running')
    expect(res.json.tickets.open).toBe(1)
    expect(res.json.backend).toBe('orca')
  })

  it('POST /api/reports 把 ra report 的载荷转成 WorkerStateFile', async () => {
    const res = await call(server, 'POST', '/api/reports', {
      ticketId,
      state: 'ready',
      summary: '完成梳理',
      reply: '## 结论\n- A',
      ackedInputs: ['in_1'],
    })
    expect(res.status).toBe(201)
    expect(res.json).toMatchObject({ ok: true, ticketId, assignmentId, turn: 1, state: 'ready', reply: true })
    expect(reports[0]).toMatchObject({
      ticketId,
      assignmentId,
      turn: 1,
      state: 'ready',
      summary: '完成梳理',
      reply: '## 结论\n- A',
      ackedInputs: ['in_1'],
    })
  })

  it('POST /api/reports 兼容旧版 deliverable 字段', async () => {
    const res = await call(server, 'POST', '/api/reports', {
      ticketId,
      state: 'ready',
      summary: '旧版客户端',
      deliverable: { kind: 'doc', content: '# 全文', url: 'https://x.feishu.cn/docx/abc' },
    })
    expect(res.status).toBe(201)
    expect(reports[0]!.reply).toBe('# 全文\n\nhttps://x.feishu.cn/docx/abc')
  })

  it('POST /api/reports 校验 state / summary / 工单', async () => {
    expect((await call(server, 'POST', '/api/reports', { ticketId, state: 'done', summary: 'x' })).status).toBe(400)
    expect((await call(server, 'POST', '/api/reports', { ticketId, state: 'ready', summary: '  ' })).status).toBe(400)
    expect((await call(server, 'POST', '/api/reports', { ticketId: 'tk_nope', state: 'ready', summary: 'x' })).status).toBe(404)
  })

  it('未知路由返回 404 JSON', async () => {
    const res = await call(server, 'GET', '/api/nope')
    expect(res.status).toBe(404)
    expect(res.json.error).toBe('not-found')
  })
})
