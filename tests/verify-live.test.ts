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
import { OrcaAdapter } from '../src/worker/orca/index.js'
import { realRunner } from '../src/infra/process.js'
import { backfillChats, historyCursorKey } from '../src/sources/feishu-backfill.js'
import type { FeishuConfig } from '../src/sources/feishu.js'
import type { Trigger } from '../src/core/model.js'

const LIVE = process.env.RA_VERIFY === '1'

describe.runIf(LIVE)('真实环境验证', () => {
  it('真实 LLM 能对推断候选给出可解析的决定', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-live-'))
    const store = new Store(':memory:')
    const config = { ...defaultConfig(), home }
    config.policy = { acceptMode: 'auto', maxWorkers: 2, admission: { listedNotAddressed: 'inferred', unlistedAddressed: 'inferred', unlistedNotAddressed: 'ignore' } }
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
    expect(JSON.parse(status.body).backend).toBe('orca')

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
    const adapter = new OrcaAdapter({
      runner: realRunner('orca'),
      workersDir: mkdtempSync(join(tmpdir(), 'ra-live-orca-')),
      spec: 'prompt',
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

  it('飞书事件消费预检与历史补拉可用', async () => {
    const runner = realRunner('lark-cli')
    const dry = await runner.run(['event', 'consume', 'im.message.receive_v1', '--as', 'bot', '--dry-run'])
    console.log('lark dry-run:', dry.stdout.slice(0, 300))
    expect(dry.code).toBe(0)

    const cfg: FeishuConfig = {
      chats: [chatEntry('oc_8b3cca4baea9469cb04ec6ab198a8c5e')],
      directMessages: false,
      botOpenIds: ['ou_fb2410f09780e92091df335d14387897', 'cli_a9225095e04cdbc2'],
      botNames: ['Pz小助手'],
    }
    // 首次运行只记基线：不把整段历史当新需求
    const cursors = new Map<string, string>()
    const cursorStore = {
      get: (key: string) => cursors.get(key) ?? null,
      set: (key: string, value: string) => { cursors.set(key, value) },
    }
    const chatIds = cfg.chats.map(chat => chat.chat)
    const first = await backfillChats({ runner, chats: chatIds, cfg, cursors: cursorStore })
    expect(first.baselined).toEqual(chatIds)
    expect(first.triggers).toHaveLength(0)

    // 把游标回拨 7 天，验证增量通道确实能拉到消息
    cursors.set(historyCursorKey(chatIds[0]!), String(Date.now() - 7 * 24 * 3600 * 1000))
    const second = await backfillChats({ runner, chats: chatIds, cfg, cursors: cursorStore })
    console.log('补拉条数:', second.triggers.length, second.triggers[0]?.text.slice(0, 40))
    expect(second.triggers.length).toBeGreaterThan(0)
    // 机器人自己的消息必须被过滤
    expect(second.triggers.every(t => !cfg.botOpenIds.includes(t.actorId))).toBe(true)
  }, 60_000)
})

describe.runIf(!LIVE)('真实环境验证（未开启）', () => {
  it('设置 RA_VERIFY=1 后运行真实验证', () => {
    expect(true).toBe(true)
  })
})
