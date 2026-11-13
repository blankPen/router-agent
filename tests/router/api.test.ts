import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { createApiServer, type ApiServer, type IdentityPort } from '../../src/router/api.js'
import { InstallStartError } from '@router-agent/runtime-acp'
import type { ResumeHint } from '#runtime/port.js'
import { defaultConfig, loadConfig, policyOf, projectsForRuntime, type AppConfig, chatEntry, type PolicyResolution } from '../../src/config.js'
import { FeishuBotAdmin } from '@router-agent/channel-feishu'
import type { IdentityStatusView } from '@router-agent/channel-feishu'
import { ReportRejectedError } from '#runtime/evidence-gate.js'
import type { ChannelAdmin } from '#channel/port.js'

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
  let reportRejection: Error | null

  beforeEach(async () => {
    store = new Store(':memory:')
    config = { ...defaultConfig(), feishu: { ...defaultConfig().feishu, chats: [chatEntry('oc_dev')], botOpenIds: ['ou_bot'] } }
    let n = 0
    engine = new Engine({ store, policy: policyOf(config), clock: { now: () => '2026-11-06T10:00:00.000Z' }, ids: { next: p => `${p}_${++n}` } })
    events = []
    reports = []
    resumeHints = {}
    resumeCalls = []
    reportRejection = null
    server = await createApiServer({
      engine, store, config,
      clock: { now: () => '2026-11-06T10:00:05.000Z' },
      onEvent: event => events.push(event),
      onReport: state => {
        if (reportRejection) throw reportRejection
        reports.push(state as unknown as Record<string, unknown>)
      },
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
    const none = await call(server, 'GET', '/api/tickets?stage=todo')
    expect(none.json.tickets).toHaveLength(0)
    const running = await call(server, 'GET', '/api/tickets?stage=running')
    expect(running.json.tickets[0].id).toBe(ticketId)
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
    expect(store.getTicket(ticketId)?.stage).toBe('blocked')

    const res = await call(server, 'POST', `/api/tickets/${ticketId}/assignment`, { handle: 'h2', workdir: '/tmp/wt2' })
    expect(res.status).toBe(201)
    expect(store.latestAssignment(ticketId)?.handle).toBe('h2')
    expect(store.getTicket(ticketId)?.stage).toBe('running')
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
    expect(store.getTicket(ticketId)?.stage).toBe('done')
    expect(events.find(event => event.event === 'api:stop')).toMatchObject({ ticketId })
    // Web-only 模式没有服务层：退回只排 stop-worker。
    expect(store.claimEffects('2026-11-06T10:00:10.000Z', 10).some(item => item.kind === 'stop-worker')).toBe(true)
  })

  it('POST /api/tickets/:id/stop 有服务层时由服务层关单并回收 workspace', async () => {
    const calls: string[] = []
    const extra = await createApiServer({
      engine, store, config,
      onEvent: event => events.push(event),
      onStopTicket: (id, reason) => {
        calls.push(`${id}:${reason}`)
        return engine.stopTicket(id, reason)
      },
    })
    try {
      const res = await call(extra, 'POST', `/api/tickets/${ticketId}/stop`, { reason: '人工停止' })
      expect(res.status).toBe(200)
      expect(calls).toEqual([`${ticketId}:人工停止`])
      // 服务层会排 cleanup-workspace（先停进程再删目录），不再重复排 stop-worker。
      expect(store.claimEffects('2026-11-06T10:00:10.000Z', 10)).toHaveLength(0)
    } finally {
      await extra.close()
    }
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
    expect(res.json.config.llm).toEqual({
      baseUrl: 'https://api.example.com/v1',
      model: 'demo',
      api: 'openai-completions',
      authHeader: false,
      apiKeySet: true,
    })
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
    expect(events.find(event => event.event === 'api:config')).toMatchObject({
      changed: ['progress.syncMs', 'feishu.images.maxChars'],
      policyChanged: false,
      restartRequired: true,
    })
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

  it('PUT /api/config 写入 llm.apiKey，但响应不回显明文', async () => {
    config.home = mkdtempSync(join(tmpdir(), 'ra-api-config-'))
    const res = await call(server, 'PUT', '/api/config', { patch: { 'llm.apiKey': 'sk-leak' } })
    expect(res.status).toBe(200)
    expect(res.json.changed).toEqual(['llm.apiKey'])
    expect(loadConfig(config.home!).llm?.apiKey).toBe('sk-leak')
    expect(res.json.config.llm.apiKey).toBeUndefined()
    expect(res.json.config.llm.apiKeySet).toBe(true)
    expect(JSON.stringify(res.json)).not.toContain('sk-leak')
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
      probe: async () => ({ ok: true, detail: '版本探测通过', choice }),
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

      const probed = await call(runtimeServer, 'POST', '/api/runtimes/probe', { id: 'acp-codex' })
      expect(probed.status).toBe(200)
      expect(probed.json).toMatchObject({ ok: true, choice: { id: 'acp-codex', status: 'ready' } })
      expect((await call(runtimeServer, 'POST', '/api/runtimes/probe', {})).status).toBe(400)

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

  it('运行时检测失败时记录 runtime:check-failed / runtime:probe-failed', async () => {
    const logs: { message: string; extra?: Record<string, unknown> }[] = []
    const admin = {
      snapshot: () => null,
      isDetecting: () => false,
      detect: async () => ({ detectedAt: '2026-11-06T10:00:00.000Z', choices: [] }),
      check: async () => ({ ok: false, detail: '未知 ACP Agent: herdr' }),
      probe: async () => ({ ok: false, detail: '未找到 t3 CLI' }),
      startInstall: () => ({ jobId: 'job-1' }),
      installJob: () => null,
    }
    const runtimeServer = await createApiServer({
      engine, store, config,
      runtimeAdmin: admin as never,
      logger: { info: () => {}, warn: (message, extra) => logs.push({ message, ...(extra ? { extra } : {}) }), error: () => {} },
    })
    try {
      await call(runtimeServer, 'POST', '/api/runtimes/check', { id: 'herdr' })
      await call(runtimeServer, 'POST', '/api/runtimes/probe', { id: 't3code' })
      const checked = logs.find(log => log.message === 'runtime:check-failed')
      expect(checked?.extra).toMatchObject({ runtimeId: 'herdr', detail: '未知 ACP Agent: herdr' })
      const probed = logs.find(log => log.message === 'runtime:probe-failed')
      expect(probed?.extra).toMatchObject({ runtimeId: 't3code', detail: '未找到 t3 CLI' })
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
        'projects': [{ name: 'router-agent', repo: '/Users/me/router-agent', defaultBranch: 'main' }],
        'runtime.projects.claude-code': [{ name: 'router-agent', repo: '/Users/me/router-agent', defaultBranch: 'main' }],
      },
    })
    expect(res.status).toBe(200)
    expect(res.json.config.runtime.projects['claude-code']).toHaveLength(1)
    const saved = loadConfig(config.home!)
    expect(saved.runtime.default).toBe('claude-code')
    expect(saved.projects[0]?.repo).toBe('/Users/me/router-agent')
    expect(projectsForRuntime(saved, 'claude-code')[0]?.repo).toBe('/Users/me/router-agent')
  })

  it('PUT /api/config 拒绝清单里的 Orca 选择器（所有 runtime 统一要本地绝对路径）', async () => {
    config.home = mkdtempSync(join(tmpdir(), 'ra-api-config-'))
    const res = await call(server, 'PUT', '/api/config', {
      patch: {
        'runtime.projects.claude-code': [{ name: 'router-agent', repo: 'name:dsh/router-agent', defaultBranch: 'main' }],
      },
    })
    expect(res.status).toBe(400)
    expect(res.json.errors[0].path).toBe('runtime.projects.claude-code')
  })

  it('PUT /api/config 拒绝 orca 清单里的 name: 选择器', async () => {
    config.home = mkdtempSync(join(tmpdir(), 'ra-api-config-'))
    const res = await call(server, 'PUT', '/api/config', {
      patch: {
        'projects': [{ name: 'router-agent', repo: 'name:dsh/router-agent', defaultBranch: 'main' }],
      },
    })
    expect(res.status).toBe(400)
    expect(res.json.errors[0].path).toBe('projects')
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

  it('GET /api/workspaces 返回按运行时分组的工作区，未注入时 501', async () => {
    const overview = {
      runtimes: [{
        runtimeId: 'orca',
        label: 'orca',
        isDefault: true,
        supported: true,
        entries: [],
        cleanableCount: 0,
      }],
      cleanableCount: 0,
    }
    const extra = await createApiServer({
      engine, store, config,
      workspaceAdmin: {
        list: async () => overview,
        cleanup: async () => ({ removed: [], skipped: [] }),
      },
    })
    try {
      const res = await call(extra, 'GET', '/api/workspaces')
      expect(res.status).toBe(200)
      expect(res.json).toEqual(overview)
    } finally {
      await extra.close()
    }

    const unsupported = await call(server, 'GET', '/api/workspaces')
    expect(unsupported.status).toBe(501)
    expect(unsupported.json.error).toBe('workspace-admin-not-supported')
  })

  it('POST /api/workspaces/cleanup 按勾选的工单批量清理并回传结果', async () => {
    const calls: unknown[] = []
    const extra = await createApiServer({
      engine, store, config,
      onEvent: event => events.push(event),
      workspaceAdmin: {
        list: async () => ({ runtimes: [], cleanableCount: 0 }),
        cleanup: async request => {
          calls.push(request)
          return { removed: [{ ticketId, workdir: '/tmp/wt' }], skipped: [] }
        },
      },
    })
    try {
      const res = await call(extra, 'POST', '/api/workspaces/cleanup', { ticketIds: [ticketId, ticketId, ' '] })
      expect(res.status).toBe(200)
      // 去重并丢掉空值。
      expect(calls).toEqual([{ ticketIds: [ticketId] }])
      expect(res.json).toEqual({ removed: [{ ticketId, workdir: '/tmp/wt' }], skipped: [] })
      expect(events.some(event => event.event === 'api:workspace-cleanup' && event.requested === 1)).toBe(true)
    } finally {
      await extra.close()
    }
  })

  it('POST /api/workspaces/cleanup 支持按运行时清理，缺选择或清理失败返回 400', async () => {
    const calls: unknown[] = []
    const extra = await createApiServer({
      engine, store, config,
      workspaceAdmin: {
        list: async () => ({ runtimes: [], cleanableCount: 0 }),
        cleanup: async request => {
          calls.push(request)
          if (request.runtimeId === 'nope') throw new Error('未知的 Worker 运行时: nope')
          return { removed: [], skipped: [] }
        },
      },
    })
    try {
      const runtime = await call(extra, 'POST', '/api/workspaces/cleanup', { runtimeId: 'orca' })
      expect(runtime.status).toBe(200)
      expect(calls).toEqual([{ runtimeId: 'orca' }])

      const missing = await call(extra, 'POST', '/api/workspaces/cleanup', {})
      expect(missing.status).toBe(400)
      expect(missing.json.error).toBe('selection-required')

      const invalid = await call(extra, 'POST', '/api/workspaces/cleanup', { ticketIds: ticketId })
      expect(invalid.status).toBe(400)
      expect(invalid.json.error).toBe('ticket-ids-invalid')

      const failed = await call(extra, 'POST', '/api/workspaces/cleanup', { runtimeId: 'nope' })
      expect(failed.status).toBe(400)
      expect(failed.json.error).toBe('workspace-cleanup-failed')
      expect(failed.json.message).toContain('未知的 Worker 运行时')
    } finally {
      await extra.close()
    }
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

  it('POST /api/reports 透传 --ui-change 声明', async () => {
    const res = await call(server, 'POST', '/api/reports', {
      ticketId,
      state: 'ready',
      summary: '改了按钮',
      uiChange: true,
    })
    expect(res.status).toBe(201)
    expect(reports[0]).toMatchObject({ uiChange: true })
  })

  it('POST /api/reports 透传结构化 replyPayload', async () => {
    const replyPayload = {
      blocks: [{ type: 'markdown', text: '## 结论\n- A' }],
      fallbackText: '## 结论\n- A',
    }
    const res = await call(server, 'POST', '/api/reports', {
      ticketId,
      state: 'ready',
      summary: '完成梳理',
      replyPayload,
    })

    expect(res.status).toBe(201)
    expect(reports[0]).toMatchObject({ replyPayload })
  })

  it('POST /api/reports 拒绝结构不合法的 replyPayload', async () => {
    const res = await call(server, 'POST', '/api/reports', {
      ticketId,
      state: 'ready',
      summary: '坏载荷',
      replyPayload: { blocks: [{ type: 'image' }], fallbackText: 'x' },
    })

    expect(res.status).toBe(400)
    expect(res.json).toMatchObject({ error: 'invalid-reply-payload' })
    expect(reports).toHaveLength(0)
  })

  it('POST /api/reports 证据门禁拒绝时返回 422 与补证指引', async () => {
    reportRejection = new ReportRejectedError('evidence-missing', 'UI 工单缺少 PR / MR 证据：Before 标识。', {
      ticketId,
      missing: ['Before 标识'],
    })
    const res = await call(server, 'POST', '/api/reports', {
      ticketId,
      state: 'ready',
      summary: '改了按钮',
      uiChange: true,
    })
    expect(res.status).toBe(422)
    expect(res.json).toMatchObject({
      error: 'evidence-missing',
      message: expect.stringContaining('Before 标识'),
      missing: ['Before 标识'],
    })
    expect(reports).toHaveLength(0)
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

  it('飞书机器人：状态 / 写入凭据 / 发起与完成授权', async () => {
    const calls: { argv: string[]; input?: string }[] = []
    const lark = {
      async run(argv: string[], opts: { input?: string } = {}) {
        calls.push({ argv, ...(opts.input !== undefined ? { input: opts.input } : {}) })
        if (argv[0] === 'config' && argv[1] === 'init') {
          return { code: 0, stdout: 'configuration saved', stderr: '' }
        }
        if (argv[0] === 'auth' && argv[1] === 'status') {
          return {
            code: 0,
            stdout: JSON.stringify({
              appId: 'cli_x',
              identities: {
                bot: { available: true, status: 'ready' },
                user: { available: true, status: 'ready', openId: 'ou_me', userName: '我' },
              },
            }),
            stderr: '',
          }
        }
        if (argv[0] === 'auth' && argv[1] === 'login' && argv.includes('--no-wait')) {
          return { code: 0, stdout: JSON.stringify({ device_code: 'dc_1', verification_url: 'https://example.com/auth' }), stderr: '' }
        }
        return { code: 0, stdout: '{}', stderr: '' }
      },
    }
    const botConfig: AppConfig = { ...defaultConfig(), home: mkdtempSync(join(tmpdir(), 'ra-api-feishu-')) }
    const botEngine = new Engine({ store, policy: policyOf(botConfig) })
    const botServer = await createApiServer({
      engine: botEngine,
      store,
      config: botConfig,
      feishuBot: new FeishuBotAdmin({ lark, profileHome: botConfig.home }),
    })
    try {
      const status = await call(botServer, 'GET', '/api/feishu/status')
      expect(status.status).toBe(200)
      expect(status.json).toMatchObject({ profileHome: botConfig.home, bot: { available: true }, user: { available: true } })

      const credentials = await call(botServer, 'POST', '/api/feishu/credentials', { appId: 'cli_x', appSecret: 'shh' })
      expect(credentials.status).toBe(200)
      expect(botConfig.feishu.appId).toBe('cli_x')
      const initCall = calls.find(item => item.argv[0] === 'config' && item.argv[1] === 'init')
      expect(initCall?.argv).toEqual(['config', 'init', '--app-id', 'cli_x', '--app-secret-stdin'])
      expect(initCall?.input).toBe('shh\n')
      const written = readFileSync(join(botConfig.home, 'config.yaml'), 'utf8')
      expect(written).toContain('cli_x')
      expect(written).not.toContain('shh')

      const login = await call(botServer, 'POST', '/api/feishu/auth/login')
      expect(login.status).toBe(200)
      expect(login.json).toMatchObject({ deviceCode: 'dc_1', verificationUrl: 'https://example.com/auth' })
      const startCall = calls.find(item => item.argv.includes('--no-wait'))
      expect(startCall?.argv).toContain('im,docs,drive,contact')

      const complete = await call(botServer, 'POST', '/api/feishu/auth/complete', { deviceCode: 'dc_1' })
      expect(complete.status).toBe(200)
      expect(complete.json).toMatchObject({ ok: true, bot: { available: true } })
      expect(calls.some(item => item.argv.includes('--device-code') && item.argv.includes('dc_1'))).toBe(true)
    } finally {
      await botServer.close()
    }
  })

  it('未注入飞书机器人能力时相关端点返回 404', async () => {
    expect((await call(server, 'GET', '/api/feishu/status')).status).toBe(404)
    expect((await call(server, 'POST', '/api/feishu/credentials', { appId: 'a', appSecret: 'b' })).status).toBe(404)
  })

  it('未知路由返回 404 JSON', async () => {
    const res = await call(server, 'GET', '/api/nope')
    expect(res.status).toBe(404)
    expect(res.json.error).toBe('not-found')
  })
})

describe('允许名单保存后立即生效', () => {
  let store: Store
  let engine: Engine
  let config: AppConfig
  let logs: { level: string; message: string; extra?: Record<string, unknown> }[]
  let refreshCalls: number
  let status: IdentityStatusView
  let ids: PolicyResolution

  /** 假身份端口：记录刷新次数，返回预置的解析状态与解析结果。 */
  function identityPort(overrides: Partial<IdentityPort> = {}): IdentityPort {
    return {
      refresh: async () => { refreshCalls += 1; return status },
      snapshot: () => status,
      policyIds: () => ids,
      ...overrides,
    }
  }

  beforeEach(() => {    store = new Store(':memory:')
    config = { ...defaultConfig(), feishu: { ...defaultConfig().feishu, chats: [chatEntry('oc_dev')] } }
    engine = new Engine({ store, policy: policyOf(config) })
    logs = []
    refreshCalls = 0
    status = {
      entries: [],
      bot: { botOpenIds: [], botNames: [], resolved: false, detail: '未启用' },
      invalidCount: 0,
      pendingCount: 0,
    }
    ids = {}
  })

  afterEach(() => store.close())

  it('GET /api/config 返回允许名单的解析状态', async () => {
    status = {
      entries: [
        { entry: 'alice@example.com', kind: 'email', openId: 'ou_alice', name: 'Alice', status: 'resolved', detail: '' },
        { entry: 'ou_bob', kind: 'open_id', openId: 'ou_bob', name: '', status: 'pending', detail: '通讯录查询失败' },
      ],
      bot: { botOpenIds: ['ou_bot'], botNames: ['机器人'], resolved: true, detail: '已识别' },
      invalidCount: 0,
      pendingCount: 1,
    }
    const server = await createApiServer({ engine, store, config, identity: identityPort() })
    try {
      const res = await call(server, 'GET', '/api/config')
      expect(res.status).toBe(200)
      expect(res.json.identity.entries).toHaveLength(2)
      expect(res.json.identity.entries[0]).toMatchObject({
        entry: 'alice@example.com',
        kind: 'email',
        status: 'resolved',
        name: 'Alice',
      })
      expect(res.json.identity.entries[1].status).toBe('pending')
      expect(res.json.identity.bot).toMatchObject({ resolved: true, botOpenIds: ['ou_bot'] })
      expect(res.json.identity.pendingCount).toBe(1)
    } finally {
      await server.close()
    }
  })

  it('没注入身份端口时返回空状态，而不是 undefined', async () => {
    const server = await createApiServer({ engine, store, config })
    try {
      const res = await call(server, 'GET', '/api/config')
      expect(res.status).toBe(200)
      expect(res.json.identity).toEqual({
        entries: [],
        // 未启用不是失败：缺省快照的机器人身份按「可用」表示，避免面板红色误报。
        bot: { botOpenIds: [], botNames: [], resolved: true, detail: '未启用' },
        invalidCount: 0,
        pendingCount: 0,
      })
    } finally {
      await server.close()
    }
  })

  it('PUT /api/config 保存允许名单后立即重解析，新名单直接生效', async () => {
    status = {
      entries: [{ entry: 'alice@example.com', kind: 'email', openId: 'ou_alice', name: 'Alice', status: 'resolved', detail: '' }],
      bot: { botOpenIds: ['ou_bot'], botNames: [], resolved: true, detail: '已识别' },
      invalidCount: 0,
      pendingCount: 0,
    }
    ids = { allowedOpenIds: ['ou_alice'], allowedByChatOpenIds: {}, names: { ou_alice: 'Alice' } }
    const server = await createApiServer({ engine, store, config, identity: identityPort() })
    try {
      const res = await call(server, 'PUT', '/api/config', { patch: { 'feishu.allowed': ['alice@example.com'] } })
      expect(res.status).toBe(200)
      expect(refreshCalls).toBe(1)
      expect(res.json.policyChanged).toBe(true)
      expect(res.json.identityEffective).toBe(true)
      // 策略里用的是解析出的 open_id，不是原始邮箱。
      expect(engine.policy().allowedOpenIds).toEqual(['ou_alice'])
      expect(res.json.identity.entries[0].status).toBe('resolved')
    } finally {
      await server.close()
    }
  })

  it('解析失败的邮箱不阻断保存，状态里能看出失败条数', async () => {
    status = {
      entries: [{ entry: 'nobody@example.com', kind: 'email', openId: '', name: '', status: 'invalid', detail: '查无此人' }],
      bot: { botOpenIds: [], botNames: [], resolved: false, detail: '未启用' },
      invalidCount: 1,
      pendingCount: 0,
    }
    ids = { allowedOpenIds: [], allowedByChatOpenIds: {} }
    const server = await createApiServer({ engine, store, config, identity: identityPort() })
    try {
      const res = await call(server, 'PUT', '/api/config', { patch: { 'feishu.allowed': ['nobody@example.com'] } })
      expect(res.status).toBe(200)
      expect(res.json.identity.invalidCount).toBe(1)
      expect(res.json.identityEffective).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('重解析失败不阻断保存，但记录 identity:refresh-failed', async () => {
    const server = await createApiServer({
      engine, store, config,
      identity: identityPort({ refresh: async () => { throw new Error('通讯录查不通') } }),
      logger: {
        info: () => {},
        warn: (message, extra) => { logs.push({ level: 'warn', message, ...(extra ? { extra } : {}) }) },
        error: (message, extra) => { logs.push({ level: 'error', message, ...(extra ? { extra } : {}) }) },
      },
    })
    try {
      const res = await call(server, 'PUT', '/api/config', { patch: { 'feishu.allowed': ['alice@example.com'] } })
      expect(res.status).toBe(200)
      expect(res.json.identityEffective).toBe(false)
      const entry = logs.find(log => log.message === 'identity:refresh-failed')
      expect(entry?.level).toBe('warn')
      expect(entry?.extra?.message).toContain('通讯录查不通')
    } finally {
      await server.close()
    }
  })

  it('没改允许名单时不触发重解析', async () => {
    const server = await createApiServer({ engine, store, config, identity: identityPort() })
    try {
      const res = await call(server, 'PUT', '/api/config', { patch: { 'policy.acceptMode': 'observe' } })
      expect(res.status).toBe(200)
      expect(refreshCalls).toBe(0)
      expect(res.json.identityEffective).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('没有身份端口时名单按原始条目进策略，同样算即时生效', async () => {
    const server = await createApiServer({ engine, store, config })
    try {
      const res = await call(server, 'PUT', '/api/config', { patch: { 'feishu.allowed': ['ou_alice'] } })
      expect(res.status).toBe(200)
      expect(res.json.identityEffective).toBe(true)
      expect(engine.policy().allowed).toEqual(['ou_alice'])
    } finally {
      await server.close()
    }
  })

  it('PUT /api/policy 不丢掉解析出的名单', async () => {
    ids = { allowedOpenIds: ['ou_alice'], allowedByChatOpenIds: { oc_dev: ['ou_alice'] }, names: { ou_alice: 'Alice' } }
    engine.updatePolicy(policyOf(config, { allowedOpenIds: ['ou_alice'], allowedByChatOpenIds: { oc_dev: ['ou_alice'] } }))
    const server = await createApiServer({ engine, store, config, identity: identityPort() })
    try {
      const res = await call(server, 'PUT', '/api/policy', { acceptMode: 'observe' })
      expect(res.status).toBe(200)
      expect(res.json.policy.acceptMode).toBe('observe')
      // 策略重建时必须带上解析结果，否则名单会退回原始条目，邮箱永远匹配不上 open_id。
      expect(engine.policy().allowedOpenIds).toEqual(['ou_alice'])
      expect(engine.policy().allowedByChatOpenIds).toEqual({ oc_dev: ['ou_alice'] })
    } finally {
      await server.close()
    }
  })
})

describe('API 异常日志', () => {
  it('请求处理抛错时返回 500 并记录 api:request-failed', async () => {
    const store = new Store(':memory:')
    const config = { ...defaultConfig(), feishu: { ...defaultConfig().feishu, chats: [chatEntry('oc_dev')], botOpenIds: ['ou_bot'] } }
    let n = 0
    const engine = new Engine({ store, policy: policyOf(config), clock: { now: () => '2026-11-06T10:00:00.000Z' }, ids: { next: p => `${p}_${++n}` } })
    engine.ingest({
      id: 't1', source: 'feishu', externalId: 'om_1', threadId: 'feishu:oc_dev:om_root', chatId: 'oc_dev', chatName: '研发群',
      actorId: 'ou_alice', actorName: 'Alice', isBot: false, text: '改登录超时', addressed: 'mention',
      receivedAt: '2026-11-06T09:59:00.000Z', disposition: 'pending',
    })
    const ticketId = engine.decide({ triggerId: 't1', decision: 'accept', strength: 'explicit', reason: 'ok', title: '改登录超时' }).ticket!.id
    engine.startAssignment(ticketId, { runtimeId: 'orca', handle: 'h1', workdir: '/tmp/wt' })

    const logs: { level: string; message: string; extra?: Record<string, unknown> }[] = []
    const server = await createApiServer({
      engine, store, config,
      logger: {
        info: () => {},
        warn: () => {},
        error: (message, extra) => logs.push({ level: 'error', message, ...(extra ? { extra } : {}) }),
      },
      onReport: () => { throw new Error('report sink down') },
    })
    try {
      const res = await call(server, 'POST', '/api/reports', { ticketId, state: 'ready', summary: 'x' })
      expect(res.status).toBe(500)
      const entry = logs.find(log => log.message === 'api:request-failed')
      expect(entry?.extra?.message).toBe('report sink down')
      expect(String(entry?.extra?.path)).toContain('/api/reports')
    } finally {
      await server.close()
      store.close()
    }
  })

  it('恢复命令抛错时详情仍可用，并记录 ticket:resume-failed', async () => {
    const store = new Store(':memory:')
    const config = { ...defaultConfig(), feishu: { ...defaultConfig().feishu, chats: [chatEntry('oc_dev')], botOpenIds: ['ou_bot'] } }
    let n = 0
    const engine = new Engine({ store, policy: policyOf(config), clock: { now: () => '2026-11-06T10:00:00.000Z' }, ids: { next: p => `${p}_${++n}` } })
    engine.ingest({
      id: 't1', source: 'feishu', externalId: 'om_1', threadId: 'feishu:oc_dev:om_root', chatId: 'oc_dev', chatName: '研发群',
      actorId: 'ou_alice', actorName: 'Alice', isBot: false, text: '改登录超时', addressed: 'mention',
      receivedAt: '2026-11-06T09:59:00.000Z', disposition: 'pending',
    })
    const ticketId = engine.decide({ triggerId: 't1', decision: 'accept', strength: 'explicit', reason: 'ok', title: '改登录超时' }).ticket!.id
    engine.startAssignment(ticketId, { runtimeId: 'orca', handle: 'h1', workdir: '/tmp/wt' })

    const logs: { message: string; extra?: Record<string, unknown> }[] = []
    const server = await createApiServer({
      engine, store, config,
      logger: { info: () => {}, warn: (message, extra) => logs.push({ message, ...(extra ? { extra } : {}) }), error: () => {} },
      resumeHint: () => { throw new Error('resume down') },
    })
    try {
      const res = await call(server, 'GET', `/api/tickets/${ticketId}`)
      expect(res.status).toBe(200)
      expect(res.json.resume).toBeNull()
      const entry = logs.find(log => log.message === 'ticket:resume-failed')
      expect(entry?.extra?.message).toBe('resume down')
    } finally {
      await server.close()
      store.close()
    }
  })

  it('清理工作区失败时记录 api:workspace-cleanup-failed', async () => {
    const store = new Store(':memory:')
    const config = { ...defaultConfig(), feishu: { ...defaultConfig().feishu, chats: [chatEntry('oc_dev')], botOpenIds: ['ou_bot'] } }
    const engine = new Engine({ store, policy: policyOf(config), clock: { now: () => '2026-11-06T10:00:00.000Z' } })
    const logs: { message: string; extra?: Record<string, unknown> }[] = []
    const extra = await createApiServer({
      engine, store, config,
      logger: {
        info: () => {},
        warn: (message, extra) => logs.push({ message, ...(extra ? { extra } : {}) }),
        error: () => {},
      },
      workspaceAdmin: {
        list: async () => ({ runtimes: [], cleanableCount: 0 }),
        cleanup: async () => { throw new Error('未知的 Worker 运行时: nope') },
      },
    })
    try {
      const res = await call(extra, 'POST', '/api/workspaces/cleanup', { runtimeId: 'nope' })
      expect(res.status).toBe(400)
      expect(res.json.error).toBe('workspace-cleanup-failed')
      const entry = logs.find(log => log.message === 'api:workspace-cleanup-failed')
      expect(entry?.extra?.runtimeId).toBe('nope')
      expect(entry?.extra?.requested).toBe(0)
      expect(entry?.extra?.message).toBe('未知的 Worker 运行时: nope')
    } finally {
      await extra.close()
      store.close()
    }
  })

  it('飞书凭据保存时配置落盘失败记录 config:write-failed', async () => {
    const store = new Store(':memory:')
    const engine = new Engine({ store, policy: policyOf(defaultConfig()), clock: { now: () => '2026-11-06T10:00:00.000Z' } })
    const logs: { message: string; extra?: Record<string, unknown> }[] = []
    const tmp = mkdtempSync(join(tmpdir(), 'ra-cred-write-fail-'))
    const blocker = join(tmp, 'blocker')
    writeFileSync(blocker, 'x')
    const cfg = {
      ...defaultConfig(),
      home: join(blocker, 'home'),
      feishu: { ...defaultConfig().feishu, chats: [chatEntry('oc_dev')], botOpenIds: ['ou_bot'] },
    }
    const extra = await createApiServer({
      engine, store, config: cfg,
      logger: {
        info: () => {},
        warn: () => {},
        error: (message, extra) => logs.push({ message, ...(extra ? { extra } : {}) }),
      },
      feishuBot: {
        profileHome: '/tmp/fake-lark',
        status: async () => ({ appId: '', bot: { available: false, status: '' }, user: { available: false, status: '', openId: '', userName: '' } }),
        configure: async () => ({ ok: true }),
        startLogin: async () => ({}),
        completeLogin: async () => ({}),
      } as unknown as ChannelAdmin,
    })
    try {
      const res = await call(extra, 'POST', '/api/feishu/credentials', { appId: 'cli_abc', appSecret: 'secret' })
      expect(res.status).toBe(500)
      expect(res.json.error).toBe('config-write-failed')
      const entry = logs.find(log => log.message === 'config:write-failed')
      expect(entry?.extra?.home).toBe(cfg.home)
      expect(entry?.extra?.message).toBeTruthy()
    } finally {
      await extra.close()
      store.close()
    }
  })
})
