import { describe, expect, it } from 'vitest'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { createApiServer, type ApiServer } from '../../src/router/api.js'
import { defaultConfig, policyOf, type AppConfig } from '../../src/config.js'
import { compileRuleTemplate } from '../../src/events/rules.js'

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
  it('列表与操作都走事件端口', async () => {
    const store = new Store(':memory:')
    const config: AppConfig = defaultConfig()
    config.events.enabled = true
    config.events.sources.github = { enabled: true, kind: 'github', repo: 'a/b' }
    const engine = new Engine({ store, policy: policyOf(config), ids: { next: p => `${p}_1` } })
    const applied: Array<{ eventId: string; action: string }> = []
    const rule = compileRuleTemplate({ id: 'rule-issue', eventType: 'github.issues.opened', intent: '处理 issue' })
    config.events.rules = [rule]
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
        decision: () => ({ provider: 'rule', confidenceThreshold: 0.6, fallback: 'review' }),
        rules: () => config.events.rules,
        ruleStats: () => ({ 'rule-issue': { pending: 1, review: 2, done: 3, invalid: 4 } }),
        compileRule: async input => compileRuleTemplate({
          id: input.id,
          eventType: input.eventType,
          intent: input.intent,
          workflowPrompt: input.workflowPrompt,
        }),
        counts: () => ({ pending: 0, review: 0, done: 0, invalid: 0 }),
      },
    })
    try {
      const list = await call(api, 'GET', '/api/events')
      expect(list.status).toBe(200)
      expect(list.json.events).toHaveLength(1)
      expect(list.json.decision.provider).toBe('rule')
      expect(list.json.rules).toHaveLength(1)
      expect(list.json.ruleStats['rule-issue'].done).toBe(3)

      const rules = await call(api, 'GET', '/api/events/rules')
      expect(rules.status).toBe(200)
      expect(rules.json.ruleStats['rule-issue'].review).toBe(2)

      const created = await call(api, 'POST', '/api/events/rules', {
        rule: compileRuleTemplate({ id: 'rule-ci', eventType: 'github.workflow_run.failure', intent: '修复 CI' }),
      })
      expect(created.status).toBe(200)
      expect(created.json.rule.id).toBe('rule-ci')
      expect(config.events.rules.map(item => item.id)).toContain('rule-ci')

      const deleted = await call(api, 'DELETE', '/api/events/rules/rule-ci')
      expect(deleted.status).toBe(200)
      expect(config.events.rules.map(item => item.id)).not.toContain('rule-ci')

      const compiled = await call(api, 'POST', '/api/events/rules/compile', {
        id: 'rule-ci',
        eventType: 'github.workflow_run.failure',
        intent: '修复 CI',
      })
      expect(compiled.status).toBe(200)
      expect(compiled.json.rule.eventType).toBe('github.workflow_run.failure')

      const action = await call(api, 'POST', '/api/events/evt_1/action', { action: 'approve' })
      expect(action.status).toBe(200)
      expect(applied[0]).toEqual({ eventId: 'evt_1', action: 'approve' })

      const invalid = await call(api, 'POST', '/api/events/evt_1/action', { action: 'explode' })
      expect(invalid.status).toBe(400)
    } finally {
      await api.close()
    }
  })

  it('没有事件端口时相关端点返回 404', async () => {
    const store = new Store(':memory:')
    const config: AppConfig = defaultConfig()
    const engine = new Engine({ store, policy: policyOf(config), ids: { next: p => `${p}_1` } })
    const api = await createApiServer({ engine, store, config })
    try {
      const list = await call(api, 'GET', '/api/events')
      expect(list.status).toBe(404)
      const action = await call(api, 'POST', '/api/events/evt_1/action', { action: 'approve' })
      expect(action.status).toBe(404)
    } finally {
      await api.close()
    }
  })
})
