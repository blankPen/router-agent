import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { createApiServer, type ApiServer, type AutomationApiPort } from '../../src/router/api.js'
import { defaultConfig, policyOf, type AppConfig } from '../../src/config.js'

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

describe('自动化 HTTP API', () => {
  let store: Store
  let engine: Engine
  let config: AppConfig
  let server: ApiServer
  const dismissals: string[] = []
  const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = []
  const runs: Array<{ id: string; status: string }> = []

  const port: AutomationApiPort = {
    listTasks: () => [{ id: 'auto_1', name: '巡检' }],
    listRuns: () => [{ id: 'run_1', automationId: 'auto_1', status: 'success' }],
    getRun: id => runs.find(run => run.id === id) ?? null,
    listDrafts: () => [{ id: 'ad_1', draft: { name: '草稿' } }],
    dismissDraft: id => {
      dismissals.push(id)
      return id === 'ad_1'
    },
    trigger: async id => (id === 'auto_1' ? { id: 'run_2', status: 'success' } : null),
    generateScript: async id => (id === 'auto_1' ? '#!/bin/sh\necho hi' : null),
    draft: async text => (text === '每天检查依赖' ? { name: '依赖巡检' } : null),
    invokeTool: async (id, name, args) => {
      toolCalls.push({ id, name, args })
      if (name === 'missing') return { ok: false, status: 404, error: 'tool:not-found' }
      return { ok: true, status: 200, error: '', result: { ok: true } }
    },
  }

  beforeEach(async () => {
    runs.length = 0
    runs.push({ id: 'run_2', status: 'success' })
    store = new Store(':memory:')
    config = defaultConfig()
    engine = new Engine({ store, policy: policyOf(config) })
    server = await createApiServer({ engine, store, config, automation: port })
  })

  afterEach(async () => {
    await server.close()
    store.close()
  })

  it('GET /api/automations 同时返回任务、执行记录与待确认草稿', async () => {
    const res = await call(server, 'GET', '/api/automations')
    expect(res.status).toBe(200)
    expect(res.json.tasks[0].id).toBe('auto_1')
    expect(res.json.runs[0].id).toBe('run_1')
    expect(res.json.drafts[0].id).toBe('ad_1')
  })

  it('POST /api/automations/trigger 手动触发并返回执行记录', async () => {
    const res = await call(server, 'POST', '/api/automations/trigger', { id: 'auto_1' })
    expect(res.status).toBe(201)
    expect(res.json.run.id).toBe('run_2')
  })

  it('GET /api/automations/runs/:id 返回单条执行记录', async () => {
    const res = await call(server, 'GET', '/api/automations/runs/run_2')
    expect(res.status).toBe(200)
    expect(res.json.run.id).toBe('run_2')
  })

  it('GET /api/automations/runs/:id 记录不存在时返回 404', async () => {
    const res = await call(server, 'GET', '/api/automations/runs/nope')
    expect(res.status).toBe(404)
  })

  it('POST /api/automations/trigger 对未知任务返回 404', async () => {
    const res = await call(server, 'POST', '/api/automations/trigger', { id: 'nope' })
    expect(res.status).toBe(404)
  })

  it('POST /api/automations/tools 透传工具调用结果', async () => {
    const res = await call(server, 'POST', '/api/automations/tools', {
      automationId: 'auto_1',
      name: 'automation_list_tickets',
      args: { limit: 5 },
    })
    expect(res.status).toBe(200)
    expect(res.json.result.ok).toBe(true)
    expect(toolCalls.at(-1)).toEqual({ id: 'auto_1', name: 'automation_list_tickets', args: { limit: 5 } })
  })

  it('POST /api/automations/tools 未知工具按服务层状态码返回', async () => {
    const res = await call(server, 'POST', '/api/automations/tools', { automationId: 'auto_1', name: 'missing' })
    expect(res.status).toBe(404)
  })

  it('POST /api/automations/tools 缺少参数返回 400', async () => {
    const res = await call(server, 'POST', '/api/automations/tools', { automationId: 'auto_1' })
    expect(res.status).toBe(400)
  })

  it('POST /api/automations/drafts/dismiss 标记草稿已处理', async () => {
    const res = await call(server, 'POST', '/api/automations/drafts/dismiss', { id: 'ad_1' })
    expect(res.status).toBe(200)
    expect(dismissals).toEqual(['ad_1'])
  })

  it('POST /api/automations/script 生成脚本正文', async () => {
    const res = await call(server, 'POST', '/api/automations/script', { id: 'auto_1' })
    expect(res.status).toBe(200)
    expect(res.json.script).toBe('#!/bin/sh\necho hi')
  })

  it('POST /api/automations/script 生成失败时返回错误信息', async () => {
    const res = await call(server, 'POST', '/api/automations/script', { id: 'auto_x' })
    expect(res.status).toBe(502)
    expect(res.json.error).toBe('script:generate-failed')
  })

  it('POST /api/automations/script 缺少任务 id 返回 400', async () => {
    const res = await call(server, 'POST', '/api/automations/script', {})
    expect(res.status).toBe(400)
  })

  it('未装配自动化能力时端点返回 404', async () => {
    const bare = await createApiServer({ engine, store, config })
    try {
      const res = await call(bare, 'GET', '/api/automations')
      expect(res.status).toBe(404)
    } finally {
      await bare.close()
    }
  })
})
