import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import type { Store } from '../store/db.js'
import type { Engine } from '../core/engine.js'
import { applyConfigPatch, policyOf, publicConfig, publicDefaults, requiresRestart, writeConfig, type AppConfig } from '../config.js'
import type { AcceptMode } from '../core/policy.js'
import { noopSink, preview, type EventSink } from '../core/events.js'
import type { WorkerStateFile } from '../worker/orca/report-poller.js'

export interface ApiServerOptions {
  engine: Engine
  store: Store
  config: AppConfig
  clock?: { now(): string }
  port?: number
  webRoot?: string
  onPolicyChange?: (config: AppConfig) => void | Promise<void>
  /** 配置面板保存后回调；服务层可据此提示「哪些项需要重启」。 */
  onConfigChange?: (config: AppConfig, changed: string[]) => void | Promise<void>
  onEvent?: EventSink
  /** Worker 通过 `ra report` POST 上来的状态；由服务层接到 onWorkerState。 */
  onReport?: (state: WorkerStateFile) => void | Promise<void>
}

export interface ApiServer {
  server: Server
  close(): Promise<void>
}

export async function createApiServer(opts: ApiServerOptions): Promise<ApiServer> {
  const clock = opts.clock ?? { now: () => new Date().toISOString() }
  const config = opts.config
  const onEvent = opts.onEvent ?? noopSink

  const server = createServer((req, res) => {
    handle(req, res).catch(error => {
      respond(res, 500, { error: 'internal', message: error instanceof Error ? error.message : String(error) })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    if (path === '/api/status' && req.method === 'GET') {
      const tickets = opts.store.listTickets({ limit: 500 })
      return respond(res, 200, {
        stage: 'running',
        backend: config.backend.default,
        tickets: {
          open: tickets.filter(t => t.stage !== 'closed').length,
          closed: tickets.filter(t => t.stage === 'closed').length,
          byStage: groupByStage(tickets.map(t => t.stage)),
        },
        policy: { version: opts.engine.policy().version, acceptMode: opts.engine.policy().acceptMode },
        now: clock.now(),
      })
    }

    if (path === '/api/tickets' && req.method === 'GET') {
      const stage = url.searchParams.get('stage') ?? undefined
      const limit = Number(url.searchParams.get('limit') ?? 200)
      return respond(res, 200, { tickets: opts.store.listTickets({ ...(stage ? { stage: stage as never } : {}), limit }) })
    }

    const detail = path.match(/^\/api\/tickets\/([^/]+)$/)
    if (detail && req.method === 'GET') {
      const ticket = opts.store.getTicket(detail[1]!)
      if (!ticket) return respond(res, 404, { error: 'ticket-not-found' })
      return respond(res, 200, {
        ticket,
        mandate: opts.store.getMandate(ticket.mandateId),
        assignment: opts.store.latestAssignment(ticket.id),
        reports: opts.store.listReports(ticket.id, 20),
        inputs: opts.store.listInputs(ticket.id),
        attention: opts.store.getAttention(ticket.id),
      })
    }

    const action = path.match(/^\/api\/tickets\/([^/]+)\/(input|stop|assignment)$/)
    if (action) {
      const ticketId = action[1]!
      const what = action[2]!
      const body = req.method === 'POST' ? await readJson(req) : {}
      const ticket = opts.store.getTicket(ticketId)
      if (!ticket) return respond(res, 404, { error: 'ticket-not-found' })

      if (what === 'input' && req.method === 'POST') {
        const text = String((body as Record<string, unknown>).text ?? '').trim()
        if (!text) return respond(res, 400, { error: 'text-required' })
        const kind = String((body as Record<string, unknown>).kind ?? 'followup') as never
        try {
          const input = opts.engine.deliverInput(ticketId, { kind, text })
          onEvent({ event: 'api:input', ticketId, inputId: input.id, kind, text: preview(text) })
          return respond(res, 201, { input })
        } catch (error) {
          return respond(res, 409, { error: error instanceof Error ? error.message : String(error) })
        }
      }

      if (what === 'stop' && req.method === 'POST') {
        const reason = String((body as Record<string, unknown>).reason ?? '面板停止')
        const stopped = opts.engine.stopTicket(ticketId, reason)
        onEvent({ event: 'api:stop', ticketId, reason: preview(reason) })
        opts.store.enqueueEffect({
          id: `ef_stop_${ticketId}_${Date.now()}`,
          key: `stop:${ticketId}`,
          kind: 'stop-worker',
          payload: { ticketId },
          now: clock.now(),
        })
        return respond(res, 200, { ticket: stopped })
      }

      if (what === 'assignment' && req.method === 'POST') {
        const handle = String((body as Record<string, unknown>).handle ?? '')
        const workdir = String((body as Record<string, unknown>).workdir ?? '')
        if (!handle) return respond(res, 400, { error: 'handle-required' })
        const assignment = opts.engine.startAssignment(ticketId, { backendId: config.backend.default, handle, workdir })
        return respond(res, 201, { assignment })
      }
      return respond(res, 405, { error: 'method-not-allowed' })
    }

    if (path === '/api/reports' && req.method === 'POST') {
      if (!opts.onReport) return respond(res, 501, { error: 'report-not-supported' })
      const body = (await readJson(req)) as Record<string, any>
      const ticketId = String(body.ticketId ?? body.ticket_id ?? '')
      const ticket = opts.store.getTicket(ticketId)
      if (!ticket) return respond(res, 404, { error: 'ticket-not-found' })

      const assignment = (body.assignmentId ? opts.store.getAssignment(String(body.assignmentId)) : null) ?? opts.store.latestAssignment(ticketId)
      if (!assignment) return respond(res, 409, { error: 'no-assignment' })

      const state = String(body.state ?? '')
      if (!['progress', 'ready', 'blocked', 'failed', 'dropped', 'waiting'].includes(state)) {
        return respond(res, 400, { error: 'invalid-state' })
      }
      const summary = String(body.summary ?? '').trim()
      if (!summary) return respond(res, 400, { error: 'summary-required' })

      // worker 不传 turn 时按已有序号自增，避免同一 turn 的多次回答被幂等键吞掉。
      const latest = opts.store.latestReport(ticketId)
      const requestedTurn = Number(body.turn)
      const turn = Number.isFinite(requestedTurn) && requestedTurn >= 0 ? requestedTurn : (latest?.turn ?? 0) + 1
      const reply = String(body.reply ?? legacyReply(body.deliverable) ?? '').trim()

      const payload: WorkerStateFile = {
        ticketId,
        assignmentId: assignment.id,
        turn,
        state: state as WorkerStateFile['state'],
        summary,
        ...(body.humanAction ? { humanAction: String(body.humanAction) } : {}),
        prNumber: Number(body.prNumber ?? 0) || 0,
        prUrl: String(body.prUrl ?? ''),
        ...(reply ? { reply } : {}),
        ackedInputs: Array.isArray(body.ackedInputs) ? body.ackedInputs.map(String) : [],
        updatedAt: String(body.updatedAt ?? clock.now()),
      }

      await opts.onReport(payload)
      onEvent({ event: 'api:report', ticketId, state, turn, replyChars: reply.length })
      return respond(res, 201, { ok: true, ticketId, assignmentId: assignment.id, turn, state, reply: Boolean(reply) })
    }

    if (path === '/api/config') {
      if (req.method === 'GET') {
        return respond(res, 200, configPayload(config))
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readJson(req)
        const patch = isRecord(body.patch) ? body.patch : body
        if (!isRecord(patch)) return respond(res, 400, { error: 'patch-required' })

        // 先在克隆上校验并试写，确认能落盘再改内存里的配置，避免「面板显示已保存但文件没写成」。
        const preview = structuredClone(config)
        const result = applyConfigPatch(preview, patch)
        if (result.errors.length > 0) {
          return respond(res, 400, { error: 'invalid-config', errors: result.errors })
        }
        if (config.home && result.changed.length > 0) {
          try {
            writeConfig(config.home, preview)
          } catch (error) {
            return respond(res, 500, {
              error: 'config-write-failed',
              message: error instanceof Error ? error.message : String(error),
            })
          }
        }
        // 试写成功后，把同一批补丁作用到活配置对象上（服务里其他模块持有它的引用）。
        applyConfigPatch(config, patch)

        const beforePolicy = opts.engine.policy()
        const nextPolicy = opts.engine.updatePolicy(policyOf(config))
        const policyChanged = nextPolicy.version !== beforePolicy.version
        if (policyChanged) await opts.onPolicyChange?.(config)
        await opts.onConfigChange?.(config, result.changed)
        onEvent({ event: 'api:config', changed: result.changed })
        return respond(res, 200, {
          ...configPayload(config),
          ok: true,
          changed: result.changed,
          policyChanged,
          restartRequired: requiresRestart(result.changed),
        })
      }
      return respond(res, 405, { error: 'method-not-allowed' })
    }

    if (path === '/api/sources/feishu/chats' && req.method === 'GET') {
      return respond(res, 200, {
        chats: config.feishu.chats,
        directMessages: config.feishu.directMessages,
        allowed: config.feishu.allowed,
      })
    }

    if (path === '/api/policy') {
      if (req.method === 'GET') {
        return respond(res, 200, { policy: opts.engine.policy(), config: config.policy })
      }
      if (req.method === 'PUT') {
        const body = (await readJson(req)) as Record<string, unknown>
        const acceptMode = body.acceptMode
        if (acceptMode !== undefined && !['off', 'observe', 'auto'].includes(String(acceptMode))) {
          return respond(res, 400, { error: 'invalid-acceptMode' })
        }
        const maxWorkers = body.maxWorkers === undefined ? undefined : Number(body.maxWorkers)
        if (maxWorkers !== undefined && (!Number.isFinite(maxWorkers) || maxWorkers < 1)) {
          return respond(res, 400, { error: 'invalid-maxWorkers' })
        }
        if (acceptMode !== undefined) config.policy.acceptMode = acceptMode as AcceptMode
        if (maxWorkers !== undefined) config.policy.maxWorkers = maxWorkers
        if (body.admission && typeof body.admission === 'object') {
          config.policy.admission = { ...config.policy.admission, ...(body.admission as object) }
        }
        const policy = opts.engine.updatePolicy(policyOf(config))
        // 面板保存要落盘，否则重启后策略又回到旧值；home 为空（单测）时跳过写文件。
        if (config.home) writeConfig(config.home, config)
        onEvent({ event: 'api:policy', acceptMode: policy.acceptMode, maxWorkers: policy.maxWorkers, version: policy.version })
        await opts.onPolicyChange?.(config)
        await opts.onConfigChange?.(config, ['policy.acceptMode', 'policy.maxWorkers', 'policy.admission'])
        return respond(res, 200, { policy, config: config.policy })
      }
      return respond(res, 405, { error: 'method-not-allowed' })
    }

    if (path.startsWith('/api/')) return respond(res, 404, { error: 'not-found' })

    return serveStatic(res, path, opts.webRoot)
  }

  const port = opts.port ?? 0
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolvePromise()
    })
  })

  return {
    server,
    close: () => new Promise<void>(resolvePromise => {
      server.close(() => resolvePromise())
    }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 配置面板的读/写都用同一份口径：安全快照 + 默认值 + 配置文件路径。 */
function configPayload(config: AppConfig): Record<string, unknown> {
  return {
    config: publicConfig(config),
    defaults: publicDefaults(),
    configPath: config.home ? join(config.home, 'config.yaml') : '',
  }
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    let data = ''
    req.on('data', chunk => {
      data += String(chunk)
      if (data.length > 1_000_000) {
        reject(new Error('body-too-large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!data.trim()) return resolvePromise({})
      try {
        resolvePromise(JSON.parse(data) as Record<string, unknown>)
      } catch {
        reject(new Error('invalid-json'))
      }
    })
    req.on('error', reject)
  })
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

function serveStatic(res: ServerResponse, path: string, webRoot?: string): void {
  if (!webRoot) return respond(res, 404, { error: 'not-found' })
  const root = resolve(webRoot)
  const candidate = normalize(join(root, path === '/' ? 'index.html' : path))
  if (!candidate.startsWith(root) || !existsSync(candidate) || !statSync(candidate).isFile()) {
    const index = join(root, 'index.html')
    if (existsSync(index)) {
      res.writeHead(200, { 'Content-Type': MIME['.html']! })
      res.end(readFileSync(index))
      return
    }
    return respond(res, 404, { error: 'not-found' })
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(candidate)] ?? 'application/octet-stream' })
  res.end(readFileSync(candidate))
}

function groupByStage(stages: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const stage of stages) out[stage] = (out[stage] ?? 0) + 1
  return out
}

/** 兼容旧版 deliverable：内容 + 链接拼成纯回复。 */
function legacyReply(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return ''
  const value = raw as Record<string, unknown>
  return [String(value.content ?? '').trim(), String(value.url ?? '').trim()].filter(Boolean).join('\n\n')
}
