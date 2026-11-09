import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { createApiServer, type ApiServer } from '../../src/router/api.js'
import { InstallStartError } from '../../src/worker/runtimes/acp/admin.js'
import type { ResumeHint } from '../../src/worker/port.js'
import { defaultConfig, loadConfig, policyOf, projectsForRuntime, type AppConfig, chatEntry } from '../../src/config.js'

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
  let resumeHints: Record<string, ResumeHint | null>
  let resumeCalls: string[]

  beforeEach(async () => {
    store = new Store(':memory:')
    config = { ...defaultConfig(), feishu: { ...defaultConfig().feishu, chats: [chatEntry('oc_dev')], botOpenIds: ['ou_bot'] } }
    let n = 0
    engine = new Engine({ store, policy: policyOf(config), clock: { now: () => '2026-11-06T10:00:00.000Z' }, ids: { next: p => `${p}_${++n}` } })
    events = []
    reports = []
    resumeHints = {}
    resumeCalls = []
    server = await createApiServer({
      engine, store, config,
      clock: { now: () => '2026-11-06T10:00:05.000Z' },
      onEvent: event => events.push(event),
      onReport: state => { reports.push(state as unknown as Record<string, unknown>) },
      resumeHint: ticketId => {
        resumeCalls.push(ticketId)
        return resumeHints[ticketId] ?? null
      },
    })

    engine.ingest({
      id: 't1', source: 'feishu', externalId: 'om_1', threadId: 'feishu:oc_dev:om_root', chatId: 'oc_dev', chatName: '研发群',
      actorId: 'ou_alice', actorName: 'Alice', isBot: false, text: '改登录超时', addressed: 'mention',
      receivedAt: '2026-11-06T09:59:00.000Z', disposition: 'pending',
    })
    const outcome = engine.decide({ triggerId: 't1', decision: 'accept', strength: 'explicit', reason: 'ok', title: '改登录超时' })
    ticketId = outcome.ticket!.id
    assignmentId = engine.startAssignment(ticketId, { runtimeId: 'orca', handle: 'h1', workdir: '/tmp/wt' }).id
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
    expect(res.json.resume).toBeNull()
  })

  it('GET /api/tickets/:id 返回注入的恢复命令', async () => {
    const hint: ResumeHint = { command: "cd '/tmp/wt' && claude '--resume' 's1'", sessionId: 's1' }
    resumeHints[ticketId] = hint
    const res = await call(server, 'GET', `/api/tickets/${ticketId}`)
    expect(res.status).toBe(200)
    expect(res.json.resume).toEqual(hint)
  })

  it('恢复命令回调抛错或未注入时详情仍可用', async () => {
    const throwing = await createApiServer({
      engine, store, config,
      resumeHint: () => { throw new Error('boom') },
    })
    try {
      const res = await call(throwing, 'GET', `/api/tickets/${ticketId}`)
      expect(res.status).toBe(200)
      expect(res.json.resume).toBeNull()
    } finally {
      await throwing.close()
    }

    const bare = await createApiServer({ engine, store, config })
    try {
      const res = await call(bare, 'GET', `/api/tickets/${ticketId}`)
      expect(res.status).toBe(200)
      expect(res.json.resume).toBeNull()
    } finally {
      await bare.close()
    }
  })

  it('没有派工的工单不调用恢复命令回调', async () => {
    engine.ingest({
      id: 't2', source: 'feishu', externalId: 'om_2', threadId: 'feishu:oc_dev:om_root2', chatId: 'oc_dev', chatName: '研发群',
      actorId: 'ou_alice', actorName: 'Alice', isBot: false, text: '无派工工单', addressed: 'mention',
      receivedAt: '2026-11-06T09:59:30.000Z', disposition: 'pending',
    })
    const outcome = engine.decide({ triggerId: 't2', decision: 'accept', strength: 'explicit', reason: 'ok', title: '无派工工单' })
    const id = outcome.ticket!.id
    resumeCalls = []
    const res = await call(server, 'GET', `/api/tickets/${id}`)
    expect(res.status).toBe(200)
    expect(res.json.assignment).toBeNull()
    expect(res.json.resume).toBeNull()
    expect(resumeCalls).not.toContain(id)
  })

  it('POST /api/tickets/:id/assignment 手工重绑并恢复话题订阅', async () => {
    const ticket = store.getTicket(ticketId)!
    engine.unsubscribe(ticket.threadId, ticketId)
    engine.setAttention(ticketId, '执行会话已不存在')
    expect(store.getTicket(ticketId)?.stage).toBe('person')

    const res = await call(server, 'POST', `/api/tickets/${ticketId}/assignment`, { handle: 'h2', workdir: '/tmp/wt2' })
    expect(res.status).toBe(201)
    expect(store.latestAssignment(ticketId)?.handle).toBe('h2')
    expect(store.getTicket(ticketId)?.stage).toBe('assigned')
    expect(store.getAttention(ticketId)).toBeFalsy()
    expect(store.listSubscriptions(ticket.threadId).some(sub => sub.ticketId === ticketId)).toBe(true)
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

  it('GET /api/config 返回安全快照、默认值与配置文件路径', async () => {
    config.home = mkdtempSync(join(tmpdir(), 'ra-api-config-'))
    config.llm = { baseUrl: 'https://api.example.com/v1', model: 'demo', apiKey: 'sk-secret' }
    const res = await call(server, 'GET', '/api/config')
    expect(res.status).toBe(200)
    expect(res.json.config.policy.acceptMode).toBe('auto')
    expect(res.json.config.llm).toEqual({ baseUrl: 'https://api.example.com/v1', model: 'demo', apiKeySet: true })
    expect(JSON.stringify(res.json)).not.toContain('sk-secret')
    expect(res.json.defaults.policy.maxWorkers).toBe(4)
    expect(res.json.configPath).toBe(join(config.home, 'config.yaml'))
  })

  it('PUT /api/config 校验后落盘，策略项立即生效', async () => {
    config.home = mkdtempSync(join(tmpdir(), 'ra-api-config-'))
    const res = await call(server, 'PUT', '/api/config', {
      patch: { 'policy.acceptMode': 'observe', 'policy.maxWorkers': 2 },
    })
    expect(res.status).toBe(200)
    expect(res.json.changed).toEqual(['policy.acceptMode', 'policy.maxWorkers'])
    expect(res.json.policyChanged).toBe(true)
    expect(res.json.restartRequired).toBe(false)
    expect(engine.policy().acceptMode).toBe('observe')
    expect(engine.policy().maxWorkers).toBe(2)

    const saved = loadConfig(config.home!)
    expect(saved.policy.acceptMode).toBe('observe')
    expect(saved.policy.maxWorkers).toBe(2)
    expect(readFileSync(join(config.home!, 'config.yaml'), 'utf8')).toContain('observe')
  })

  it('PUT /api/config 非策略项落盘后提示需要重启', async () => {
    config.home = mkdtempSync(join(tmpdir(), 'ra-api-config-'))
    const res = await call(server, 'PUT', '/api/config', {
      patch: { 'progress.syncMs': 30_000, 'feishu.images.maxChars': 800 },
    })
    expect(res.status).toBe(200)
    expect(res.json.restartRequired).toBe(true)
    expect(res.json.policyChanged).toBe(false)
    const saved = loadConfig(config.home!)
    expect(saved.progress.syncMs).toBe(30_000)
    expect(saved.feishu.images.maxChars).toBe(800)
  })

  it('PUT /api/config 任意字段不合法时整体拒绝且不写文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ra-api-config-'))
    config.home = dir
    const before = engine.policy().version
    const bad = await call(server, 'PUT', '/api/config', {
      patch: { 'policy.acceptMode': 'observe', 'policy.maxWorkers': 0 },
    })
    expect(bad.status).toBe(400)
    expect(bad.json.error).toBe('invalid-config')
    expect(bad.json.errors[0]).toMatchObject({ path: 'policy.maxWorkers' })
    expect(engine.policy().version).toBe(before)
    // 整个请求被拒绝，合法字段也不应落盘。
    expect(loadConfig(dir).policy.acceptMode).toBe('auto')

    const unknown = await call(server, 'PUT', '/api/config', { patch: { 'policy.whatever': 1 } })
    expect(unknown.status).toBe(400)
  })

  it('PUT /api/config 整段更新群列表并做重复校验', async () => {
    config.home = mkdtempSync(join(tmpdir(), 'ra-api-config-'))
    const chats = [
      chatEntry('oc_a', { mode: 'mention', repo: 'router-agent', branch: 'main' }),
      chatEntry('oc_b', { allowed: ['ou_bob'] }),
    ]
    const ok = await call(server, 'PUT', '/api/config', { patch: { 'feishu.chats': chats } })
    expect(ok.status).toBe(200)
    expect(loadConfig(config.home!).feishu.chats).toEqual(chats)

    const dup = await call(server, 'PUT', '/api/config', {
      patch: { 'feishu.chats': [chatEntry('oc_a'), chatEntry('oc_a')] },
    })
    expect(dup.status).toBe(400)
    expect(dup.json.errors[0].message).toContain('群重复')
  })

  it('PUT /api/config 丢弃明文 llm.apiKey，避免面板覆盖密钥', async () => {
    config.home = mkdtempSync(join(tmpdir(), 'ra-api-config-'))
    const res = await call(server, 'PUT', '/api/config', { patch: { 'llm.apiKey': 'sk-leak' } })
    expect(res.status).toBe(200)
    expect(res.json.changed).toEqual([])
    expect(loadConfig(config.home!).llm?.apiKey).toBeUndefined()
  })

  it('运行时探测与安装 API', async () => {
    const choice = { id: 'acp-codex', label: 'Codex (ACP)', hint: 'h', status: 'ready' as const, installable: true, version: '1.11.0' }
    const job = {
      id: 'job-1',
      runtimeId: 'acp-codex',
      status: 'ok' as const,
      phase: 'succeeded',
      lines: ['ok'],
      startedAt: '2026-11-06T10:00:00.000Z',
    }
    const admin = {
      snapshot: () => ({ detectedAt: '2026-11-06T10:00:00.000Z', choices: [choice] }),
      isDetecting: () => true,
      detect: async () => ({ detectedAt: '2026-11-06T10:00:00.000Z', choices: [choice] }),
      startInstall: (id: string) => {
        if (id === 'busy') throw new InstallStartError('busy', '正在安装')
        return { jobId: 'job-1' }
      },
      check: async () => ({ ok: true, detail: 'ok', choice }),
      installJob: (id: string) => (id === 'job-1' ? job : null),
    }
    const runtimeServer = await createApiServer({ engine, store, config, runtimeAdmin: admin as never })
    try {
      const bundled = await call(runtimeServer, 'GET', '/api/config')
      expect(bundled.json.runtimeChoices).toEqual([choice])
      expect(bundled.json.detecting).toBe(true)

      const list = await call(runtimeServer, 'GET', '/api/runtimes')
      expect(list.status).toBe(200)
      expect(list.json.choices).toEqual([choice])
      expect(list.json.detecting).toBe(true)

      const detected = await call(runtimeServer, 'POST', '/api/runtimes/detect', {})
      expect(detected.status).toBe(200)
      expect(detected.json.detecting).toBe(false)

      const checked = await call(runtimeServer, 'POST', '/api/runtimes/check', { id: 'acp-codex' })
      expect(checked.status).toBe(200)
      expect(checked.json).toMatchObject({ ok: true, choice: { id: 'acp-codex', status: 'ready' } })

      const installed = await call(runtimeServer, 'POST', '/api/runtimes/install', { id: 'acp-codex' })
      expect(installed.status).toBe(202)
      expect(installed.json.jobId).toBe('job-1')

      const busy = await call(runtimeServer, 'POST', '/api/runtimes/install', { id: 'busy' })
      expect(busy.status).toBe(409)
      expect(busy.json.error).toBe('busy')

      const missing = await call(runtimeServer, 'POST', '/api/runtimes/install', {})
      expect(missing.status).toBe(400)

      const jobRes = await call(runtimeServer, 'GET', '/api/runtimes/install/job-1')
      expect(jobRes.status).toBe(200)
      expect(jobRes.json).toMatchObject({ id: 'job-1', status: 'ok' })
      expect((await call(runtimeServer, 'GET', '/api/runtimes/install/nope')).status).toBe(404)
    } finally {
      await runtimeServer.close()
    }
  })

  it('GET /api/sources/feishu/chats 返回配置的群', async () => {
    const res = await call(server, 'GET', '/api/sources/feishu/chats')
    expect(res.json.chats).toEqual([chatEntry('oc_dev')])
  })

  it('PUT /api/config 按运行时分别保存两套项目清单', async () => {
    config.home = mkdtempSync(join(tmpdir(), 'ra-api-config-'))
    const res = await call(server, 'PUT', '/api/config', {
      patch: {
        'runtime.default': 'claude-code',
        'projects': [{ name: 'router-agent', repo: 'name:dsh/router-agent', defaultBranch: 'main' }],
        'runtime.projects.claude-code': [{ name: 'router-agent', repo: '/Users/me/router-agent', defaultBranch: 'main' }],
      },
    })
    expect(res.status).toBe(200)
    expect(res.json.config.runtime.projects['claude-code']).toHaveLength(1)
    const saved = loadConfig(config.home!)
    expect(saved.runtime.default).toBe('claude-code')
    expect(saved.projects[0]?.repo).toBe('name:dsh/router-agent')
    expect(projectsForRuntime(saved, 'claude-code')[0]?.repo).toBe('/Users/me/router-agent')
  })

  it('PUT /api/config 拒绝 claude-code 清单里的 Orca 选择器', async () => {
    config.home = mkdtempSync(join(tmpdir(), 'ra-api-config-'))
    const res = await call(server, 'PUT', '/api/config', {
      patch: {
        'runtime.projects.claude-code': [{ name: 'router-agent', repo: 'name:dsh/router-agent', defaultBranch: 'main' }],
      },
    })
    expect(res.status).toBe(400)
    expect(res.json.errors[0].path).toBe('runtime.projects.claude-code')
  })

  it('GET /api/status 汇总活跃工单与运行时状态', async () => {
    const res = await call(server, 'GET', '/api/status')
    expect(res.json.stage).toBe('running')
    expect(res.json.tickets.open).toBe(1)
    expect(res.json.runtime).toBe('orca')
  })

  it('GET /api/status 带 pid 与启动时间，供面板判断是否完成重启', async () => {
    const res = await call(server, 'GET', '/api/status')
    expect(res.json.pid).toBe(process.pid)
    expect(typeof res.json.startedAt).toBe('string')
  })

  it('POST /api/restart 未注入回调时返回 501', async () => {
    const res = await call(server, 'POST', '/api/restart')
    expect(res.status).toBe(501)
  })

  it('POST /api/restart 先返回 202，再触发重启回调', async () => {
    let restarted = 0
    const extra = await createApiServer({ engine, store, config, onRestart: () => { restarted += 1 } })
    try {
      const res = await call(extra, 'POST', '/api/restart')
      expect(res.status).toBe(202)
      expect(res.json.restarting).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(restarted).toBe(1)
    } finally {
      await extra.close()
    }
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
