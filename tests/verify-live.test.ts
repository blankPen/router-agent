import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Store } from '../src/store/db.js'
import { Engine } from '../src/core/engine.js'
import { AgentLoop } from '../src/router/agent-loop.js'
import { PiDecisionEngine } from '../src/router/pi-decision-engine.js'
import { resolvePiModelConfig } from '../src/router/model-config.js'
import { RouterToolbox } from '../src/router/tools.js'
import { defaultConfig, loadConfig, policyOf, chatEntry } from '../src/config.js'
import { createApiServer } from '../src/router/api.js'
import { OrcaRuntime } from '@router-agent/runtime-orca'
import { realRunner } from '#infra/process.js'
import type { Trigger } from '#core/model.js'

const LIVE = process.env.RA_VERIFY === '1'

describe.runIf(LIVE)('真实环境验证', () => {
  it('真实 LLM 能对推断候选给出可解析的决定', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-live-'))
    const store = new Store(':memory:')
    const config = { ...defaultConfig(), home }
    config.policy = { acceptMode: 'auto', maxWorkers: 2, admission: { listedNotAddressed: 'inferred', unlistedAddressed: 'inferred', unlistedNotAddressed: 'ignore' }, interruptedRecovery: 'auto', maxAutoRecover: 1 }
    config.feishu = { ...config.feishu, chats: [chatEntry('oc_dev')], allowed: ['ou_alice'] }
    const engine = new Engine({ store, policy: policyOf(config) })
    const model = resolvePiModelConfig({ configPath: join(home, 'config.yaml') })
    const decisionEngine = new PiDecisionEngine({ model, toolbox: new RouterToolbox({ store }), agentDir: join(home, 'pi') })
    const loop = new AgentLoop({ engine, decisionEngine, batchWindowMs: 0 })

    const trigger: Trigger = {
      id: 'live_1', source: 'feishu', externalId: 'om_live_1', threadId: 'feishu:oc_dev:om_root',
      chatId: 'oc_dev', chatName: '研发群', actorId: 'ou_alice', actorName: 'Alice', isBot: false,
      text: '请把 README 里的服务端口说明从 3000 改成 3083，只改文档，不要动代码。',
      addressed: 'none', receivedAt: new Date(Date.now() - 60_000).toISOString(), disposition: 'pending',
    }
    engine.ingest(trigger)
    const result = await loop.tick()
    const stored = store.getTrigger('live_1')!
    const decision = store.getDecision(stored.decisionId!)
    console.log('LLM 决定:', decision)
    expect(decision).not.toBeNull()
    expect(decision!.decision).not.toBe('unavailable')
    expect(result.unavailable).toBe(0)
    store.close()
  }, 90_000)

  it('真实 HTTP 服务能返回 API 与 Web 面板', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-live-http-'))
    const store = new Store(':memory:')
    const config = loadConfig(home)
    const engine = new Engine({ store, policy: policyOf(config) })
    const server = await createApiServer({ engine, store, config, webRoot: join(process.cwd(), 'dist', 'web') })

    const get = (path: string): Promise<{ status: number; body: string; type: string }> => new Promise((resolve, reject) => {
      const address = server.server.address() as AddressInfo
      const req = request({ host: '127.0.0.1', port: address.port, path }, res => {
        let body = ''
        res.on('data', c => { body += String(c) })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, type: String(res.headers['content-type'] ?? '') }))
      })
      req.on('error', reject)
      req.end()
    })

    const status = await get('/api/status')
    expect(status.status).toBe(200)
    expect(JSON.parse(status.body).runtime).toBe('orca')

    const index = await get('/')
    expect(index.status).toBe(200)
    expect(index.type).toContain('text/html')
    expect(index.body).toContain('<div id="root">')

    const js = await get('/app.js')
    expect(js.status).toBe(200)
    expect(js.body.length).toBeGreaterThan(1000)

    await server.close()
    store.close()
  })

  it('Orca CLI 真实返回能被适配层解析', async () => {
    const adapter = new OrcaRuntime({
      runner: realRunner('orca'),
      workersDir: mkdtempSync(join(tmpdir(), 'ra-live-orca-')),
    })
    // 不存在的 handle 应返回 null 而不是抛错，证明 terminal list 解析路径可用
    const missing = await adapter.inspect('no-such-handle')
    expect(missing).toBeNull()

    const runner = realRunner('orca')
    const listed = await runner.run(['worktree', 'list', '--json'])
    expect(listed.code).toBe(0)
    const parsed = JSON.parse(listed.stdout) as Record<string, any>
    const worktrees = parsed.result?.worktrees ?? []
    expect(Array.isArray(worktrees)).toBe(true)
    expect(worktrees.length).toBeGreaterThan(0)
    console.log('Orca worktrees:', worktrees.length)
  }, 60_000)

})

describe.runIf(!LIVE)('真实环境验证（未开启）', () => {
  it('设置 RA_VERIFY=1 后运行真实验证', () => {
    expect(true).toBe(true)
  })
})
