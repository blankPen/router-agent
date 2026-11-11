import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'
import type { Store } from '../store/db.js'
import type { Engine } from '../core/engine.js'
import { applyConfigPatch, policyOf, publicConfig, publicDefaults, requiresRestart, writeConfig, type AppConfig, type PolicyResolution } from '../config.js'
import { InstallStartError, type AcpRuntimeAdmin } from '../worker/runtimes/acp/admin.js'
import { isWorkerRuntimeId, normalizeRuntimeId } from '../worker/runtimes/catalog.js'
import { ProjectSetupError, type ProjectSetupPort } from './project-setup.js'
import type { ChannelAdmin } from '../channels/port.js'
import type { AcceptMode } from '../core/policy.js'
import type { Ticket } from '../core/model.js'
import { noopSink, preview, type EventSink } from '../core/events.js'
import { noopLogger, errorMessage, type Logger } from '../infra/logger.js'
import type { IdentityStatusView } from '../sources/feishu-identity.js'
import type { WorkerStateFile } from '../worker/report-poller.js'
import type { ResumeHint } from '../worker/port.js'
import type { WorkspaceAdminPort } from '../worker/workspaces/overview.js'
import { readLogs } from './log-tail.js'
import { getSpec, listSpecs, resetSpec, saveSpec, SpecError } from '../specs/index.js'
import { PACKAGE_VERSION, type UpdateSnapshot } from '../update/index.js'
import {
  discoverLocalProviders,
  toLocalProviderView,
  type LocalProviderScan,
} from './provider-import.js'

/** 版本检查 / 升级端口；由 CLI 注入 UpdateService，单测可传假实现。 */
export interface UpdatePort {
  snapshot(): UpdateSnapshot
  check(force?: boolean): Promise<UpdateSnapshot>
  upgrade(options?: { force?: boolean }): Promise<UpdateSnapshot>
}

/**
 * 身份解析端口：面板保存允许名单后由它重新解析并刷新运行时快照。
 *
 * 允许名单支持邮箱后，名单不再是「写进配置就能用」：邮箱必须先解析成 open_id。
 * 面板保存后如果不重解析，用户会看到「保存成功了但机器人不理我」。
 */
export interface IdentityPort {
  /** 重新解析名单并刷新内存快照。 */
  refresh(): Promise<IdentityStatusView>
  /** 最近一次解析结果快照。 */
  snapshot(): IdentityStatusView
  /**
   * 解析出的 open_id 集合，供重建 Policy 用；缺省时沿用配置里的原始条目。
   *
   * `allowedOpenIds` 省略表示「这次没解析出来」，不等于「确认名单为空」——
   * 传空数组等于断言谁都不许，通讯录暂时查不通时不能这么干。
   */
  policyIds?(): PolicyResolution
}

/**
 * 没注入身份端口时的空状态：面板拿到结构完整的空快照，而不是 undefined。
 *
 * `bot.resolved` 的语义是「机器人身份可用或无需识别」；未启用属于后者，不是解析失败，
 * 所以这里是 true，避免面板弹出红色误报。
 */
export function emptyIdentityStatus(): IdentityStatusView {
  return {
    entries: [],
    bot: { botOpenIds: [], botNames: [], resolved: true, detail: '未启用' },
    invalidCount: 0,
    pendingCount: 0,
  }
}

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
  /** 面板「重启服务」：由服务层关闭当前进程并拉起新的 daemon。 */
  onRestart?: () => void | Promise<void>
  /** 版本检查 / 升级；缺省时 `/api/update` 返回 404。 */
  update?: UpdatePort
  onEvent?: EventSink
  /** Worker 通过 `ra report` POST 上来的状态；由服务层接到 onWorkerState。 */
  onReport?: (state: WorkerStateFile) => void | Promise<void>
  /** 工单详情里的恢复命令；缺省时 resume 恒为 null。 */
  resumeHint?: (ticketId: string) => Promise<ResumeHint | null> | ResumeHint | null
  /** ACP 运行时探测与安装；缺省时新端点返回 404。 */
  runtimeAdmin?: AcpRuntimeAdmin
  /** 通道管理能力（飞书实现由 FeishuBotAdmin 提供）；缺省时相关端点返回 404。 */
  feishuBot?: ChannelAdmin
  /** 面板「日志」页读取的日志文件；缺省时用 `<home>/logs/router-agent.log`。 */
  logPath?: string
  /** 项目登记：目录选择、Git 探测、clone 与 Orca 仓库登记；缺省时端点返回 404。 */
  projectSetup?: ProjectSetupPort
  /** 面板「停止」：由服务层关单并排 workspace 回收；缺省时只停 worker（Web-only 模式）。 */
  onStopTicket?: (ticketId: string, reason: string) => Ticket
  /** 工单页「批量清理工作区」：按运行时列出与回收遗留 worktree；缺省时端点返回 501。 */
  workspaceAdmin?: WorkspaceAdminPort
  /** 本机 LLM Provider 发现；缺省扫描当前用户主目录下的 Claude Code / CCSwitch / Pi 配置。 */
  localProviders?: { discover(): Promise<LocalProviderScan> }
  /** 允许名单的解析能力；缺省时面板只拿到空状态，名单按原始条目生效。 */
  identity?: IdentityPort
  /** 请求级异常与配置写入失败的日志出口。 */
  logger?: Logger
}

export interface ApiServer {
  server: Server
  close(): Promise<void>
}

export async function createApiServer(opts: ApiServerOptions): Promise<ApiServer> {
  const clock = opts.clock ?? { now: () => new Date().toISOString() }
  const config = opts.config
  const onEvent = opts.onEvent ?? noopSink
  const logger = opts.logger ?? noopLogger
  const logPath = opts.logPath ?? (config.home ? join(config.home, 'logs', 'router-agent.log') : '')
  const localProviders = opts.localProviders ?? {
    discover: () => discoverLocalProviders({ home: homedir() }),
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(error => {
      // 详情接口 / 配置保存等路径可能抛出未预期异常：先写日志，避免只看到一个 500。
      logger.error('api:request-failed', {
        method: req.method,
        path: req.url,
        message: errorMessage(error),
      })
      respond(res, 500, { error: 'internal', message: errorMessage(error) })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    if (path === '/api/status' && req.method === 'GET') {
      const tickets = opts.store.listTickets({ limit: 500 })
      return respond(res, 200, {
        stage: 'running',
        version: PACKAGE_VERSION,
        runtime: config.runtime.default,
        pid: process.pid,
        startedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
        tickets: {
          open: tickets.filter(t => t.stage !== 'done').length,
          closed: tickets.filter(t => t.stage === 'done').length,
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
      const assignment = opts.store.latestAssignment(ticket.id)
      let resume: ResumeHint | null = null
      if (assignment && opts.resumeHint) {
        try {
          resume = await opts.resumeHint(ticket.id)
        } catch (error) {
          // 恢复命令只是详情页的辅助信息，失败不能拖垮整个详情接口。
          logger.warn('ticket:resume-failed', { ticketId: ticket.id, message: errorMessage(error) })
          resume = null
        }
      }
      return respond(res, 200, {
        ticket,
        mandate: opts.store.getMandate(ticket.mandateId),
        assignment,
        reports: opts.store.listReports(ticket.id, 20),
        inputs: opts.store.listInputs(ticket.id),
        attention: opts.store.getAttention(ticket.id),
        resume,
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
        // 有服务层时由它统一关单 + 回收 workspace；Web-only 模式退回只停 worker。
        const stopped = opts.onStopTicket
          ? opts.onStopTicket(ticketId, reason)
          : opts.engine.stopTicket(ticketId, reason)
        onEvent({ event: 'api:stop', ticketId, reason: preview(reason) })
        if (!opts.onStopTicket) {
          opts.store.enqueueEffect({
            id: `ef_stop_${ticketId}_${Date.now()}`,
            key: `stop:${ticketId}`,
            kind: 'stop-worker',
            payload: { ticketId },
            now: clock.now(),
          })
        }
        return respond(res, 200, { ticket: stopped })
      }

      if (what === 'assignment' && req.method === 'POST') {
        const handle = String((body as Record<string, unknown>).handle ?? '')
        const workdir = String((body as Record<string, unknown>).workdir ?? '')
        if (!handle) return respond(res, 400, { error: 'handle-required' })
        if (ticket.stage === 'done') return respond(res, 409, { error: 'ticket-closed' })
        // 手工重绑通常是在恢复丢失的 worker：清掉转人工状态并恢复话题订阅，
        // 否则工单会停在 blocked，后续消息也不会再扇出到这张工单。
        opts.engine.clearAttention(ticketId)
        const assignment = opts.engine.startAssignment(ticketId, { runtimeId: config.runtime.default, handle, workdir })
        opts.engine.subscribe(ticket.threadId, ticket.id)
        return respond(res, 201, { assignment })
      }
      return respond(res, 405, { error: 'method-not-allowed' })
    }

    // 工作区批量清理：按运行时分组列出 / 回收已关闭工单的遗留 worktree。
    if (path === '/api/workspaces' && req.method === 'GET') {
      if (!opts.workspaceAdmin) return respond(res, 501, { error: 'workspace-admin-not-supported' })
      return respond(res, 200, await opts.workspaceAdmin.list())
    }

    if (path === '/api/workspaces/cleanup' && req.method === 'POST') {
      if (!opts.workspaceAdmin) return respond(res, 501, { error: 'workspace-admin-not-supported' })
      const body = await readJson(req)
      if (body.ticketIds !== undefined && !Array.isArray(body.ticketIds)) {
        return respond(res, 400, { error: 'ticket-ids-invalid', message: 'ticketIds 必须是工单号数组' })
      }
      const ticketIds = Array.isArray(body.ticketIds)
        ? [...new Set(body.ticketIds.map(id => String(id).trim()).filter(Boolean))]
        : []
      const runtimeId = typeof body.runtimeId === 'string' ? body.runtimeId.trim() : ''
      if (ticketIds.length === 0 && !runtimeId) {
        return respond(res, 400, { error: 'selection-required', message: '请至少勾选一个工单，或指定要清理的运行时' })
      }
      try {
        const result = await opts.workspaceAdmin.cleanup({
          ...(ticketIds.length > 0 ? { ticketIds } : {}),
          ...(runtimeId ? { runtimeId } : {}),
        })
        onEvent({
          event: 'api:workspace-cleanup',
          requested: ticketIds.length,
          runtimeId,
          removed: result.removed.length,
          skipped: result.skipped.length,
        })
        return respond(res, 200, result)
      } catch (error) {
        return respond(res, 400, {
          error: 'workspace-cleanup-failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
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
        return respond(res, 200, configPayload(config, opts.runtimeAdmin, opts.identity))
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readJson(req)
        const patch = isRecord(body.patch) ? body.patch : body
        if (!isRecord(patch)) return respond(res, 400, { error: 'patch-required' })

        // 先在克隆上校验并试写，确认能落盘再改内存里的配置，避免「面板显示已保存但文件没写成」。
        const preview = structuredClone(config)
        const result = applyConfigPatch(preview, patch)
        if (result.errors.length > 0) {
          logger.warn('config:patch-rejected', { errors: result.errors })
          return respond(res, 400, { error: 'invalid-config', errors: result.errors })
        }
        if (config.home && result.changed.length > 0) {
          try {
            writeConfig(config.home, preview)
          } catch (error) {
            logger.error('config:write-failed', { home: config.home, message: errorMessage(error) })
            return respond(res, 500, {
              error: 'config-write-failed',
              message: errorMessage(error),
            })
          }
        }
        // 试写成功后，把同一批补丁作用到活配置对象上（服务里其他模块持有它的引用）。
        applyConfigPatch(config, patch)

        // 允许名单改成邮箱后必须立刻重解析：否则新名单要等重启才生效。
        // 解析失败不阻断保存——配置已经落盘，名单先按上一次的结果继续用。
        const identityChanged = touchesIdentity(result.changed)
        // 名单是否已即时生效：本次没改名单、重解析成功、或没有解析能力
        // （原始条目直接进策略）都算生效；只有重解析失败才算没生效。
        let identityEffective = true
        if (identityChanged && opts.identity) {
          try {
            await opts.identity.refresh()
          } catch (error) {
            // 重解析失败：策略里仍是上一次的名单，新名单没生效，但保存照常成功。
            logger.warn('identity:refresh-failed', { message: errorMessage(error) })
            identityEffective = false
          }
        }

        const beforePolicy = opts.engine.policy()
        // 重建策略必须带上解析结果：否则名单会退回原始条目，邮箱永远匹配不上 open_id。
        const nextPolicy = opts.engine.updatePolicy(policyOf(config, identityResolution(opts.identity)))
        const policyChanged = nextPolicy.version !== beforePolicy.version
        if (policyChanged) await opts.onPolicyChange?.(config)
        await opts.onConfigChange?.(config, result.changed)
        const restartRequired = requiresRestart(result.changed)
        onEvent({ event: 'api:config', changed: result.changed, policyChanged, restartRequired, identityEffective })
        return respond(res, 200, {
          ...configPayload(config, opts.runtimeAdmin, opts.identity),
          ok: true,
          changed: result.changed,
          policyChanged,
          restartRequired,
          // 名单已经即时生效（不用等重启）；restartRequired 说的是路径粒度的其它配置项。
          identityEffective,
        })
      }
      return respond(res, 405, { error: 'method-not-allowed' })
    }

    if (path === '/api/llm/local-providers' && req.method === 'GET') {
      try {
        const scan = await localProviders.discover()
        return respond(res, 200, {
          candidates: scan.candidates.map(toLocalProviderView),
          sources: scan.sources,
        })
      } catch (error) {
        logger.warn('llm:import-scan-failed', { message: errorMessage(error) })
        return respond(res, 500, { error: 'llm-import-scan-failed', message: errorMessage(error) })
      }
    }

    if (path === '/api/llm/local-providers/import' && req.method === 'POST') {
      const body = await readJson(req)
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (!id) return respond(res, 400, { error: 'id-required', message: '缺少要导入的候选 id' })

      let scan: LocalProviderScan
      try {
        scan = await localProviders.discover()
      } catch (error) {
        logger.warn('llm:import-scan-failed', { message: errorMessage(error) })
        return respond(res, 500, { error: 'llm-import-scan-failed', message: errorMessage(error) })
      }
      const candidate = scan.candidates.find(item => item.id === id)
      if (!candidate) {
        logger.warn('llm:import-missing', { id: preview(id, 120) })
        return respond(res, 404, { error: 'provider-not-found', message: '本地配置里已经没有这个 Provider，请刷新后重试' })
      }

      const patch: Record<string, unknown> = {
        'llm.baseUrl': candidate.baseUrl,
        'llm.model': candidate.model,
        'llm.apiKey': candidate.apiKey,
        'llm.api': candidate.api,
        'llm.authHeader': candidate.authHeader === true,
        ...(candidate.contextWindow ? { 'llm.contextWindow': candidate.contextWindow } : {}),
      }
      const previewConfig = structuredClone(config)
      const result = applyConfigPatch(previewConfig, patch)
      if (result.errors.length > 0) {
        logger.warn('llm:import-rejected', { id: preview(id, 120), errors: result.errors })
        return respond(res, 400, { error: 'invalid-config', errors: result.errors })
      }
      if (config.home && result.changed.length > 0) {
        try {
          writeConfig(config.home, previewConfig)
        } catch (error) {
          logger.error('llm:import-write-failed', { home: config.home, message: errorMessage(error) })
          return respond(res, 500, { error: 'config-write-failed', message: errorMessage(error) })
        }
      }
      applyConfigPatch(config, patch)
      await opts.onConfigChange?.(config, result.changed)
      logger.info('llm:import-applied', {
        source: candidate.source,
        name: candidate.name,
        api: candidate.api,
        baseUrl: candidate.baseUrl,
        changed: result.changed,
      })
      onEvent({ event: 'api:llm-import', source: candidate.source, model: candidate.model, changed: result.changed })
      return respond(res, 200, {
        ...configPayload(config, opts.runtimeAdmin, opts.identity),
        ok: true,
        changed: result.changed,
        restartRequired: requiresRestart(result.changed),
        policyChanged: false,
        // 这次没动允许名单，名单仍然是即时生效的。
        identityEffective: true,
        imported: {
          id: candidate.id,
          source: candidate.source,
          sourceLabel: candidate.sourceLabel,
          name: candidate.name,
          baseUrl: candidate.baseUrl,
          model: candidate.model,
          api: candidate.api,
        },
      })
    }

    if (path === '/api/feishu/status' && req.method === 'GET') {
      if (!opts.feishuBot) return respond(res, 404, { error: 'feishu-bot-not-available' })
      const status = await opts.feishuBot.status()
      return respond(res, 200, {
        profileHome: opts.feishuBot.profileHome,
        configAppId: config.feishu.appId,
        appId: status.appId,
        bot: status.bot,
        user: status.user,
      })
    }

    if (path === '/api/feishu/credentials' && req.method === 'POST') {
      if (!opts.feishuBot) return respond(res, 404, { error: 'feishu-bot-not-available' })
      const body = await readJson(req)
      const appId = typeof body.appId === 'string' ? body.appId.trim() : ''
      const appSecret = typeof body.appSecret === 'string' ? body.appSecret : ''
      if (!appId) return respond(res, 400, { error: 'app-id-required', message: 'App ID 不能为空' })
      if (!appSecret.trim()) return respond(res, 400, { error: 'app-secret-required', message: 'App Secret 不能为空' })
      const result = await opts.feishuBot.configure(appId, appSecret)
      if (!result.ok) return respond(res, 400, { error: 'feishu-credentials-failed', message: result.message })
      // 凭据写入成功后同步 appId，避免 config.yaml 与 lark-cli profile 指向两个应用。
      config.feishu.appId = appId
      if (config.home) {
        try {
          writeConfig(config.home, config)
        } catch (error) {
          return respond(res, 500, {
            error: 'config-write-failed',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return respond(res, 200, {
        ok: true,
        message: result.message,
        ...configPayload(config, opts.runtimeAdmin, opts.identity),
      })
    }

    if (path === '/api/feishu/auth/login' && req.method === 'POST') {
      if (!opts.feishuBot) return respond(res, 404, { error: 'feishu-bot-not-available' })
      try {
        return respond(res, 200, await opts.feishuBot.startLogin())
      } catch (error) {
        return respond(res, 400, {
          error: 'feishu-auth-start-failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    if (path === '/api/feishu/auth/complete' && req.method === 'POST') {
      if (!opts.feishuBot) return respond(res, 404, { error: 'feishu-bot-not-available' })
      const body = await readJson(req)
      const deviceCode = typeof body.deviceCode === 'string' ? body.deviceCode.trim() : ''
      if (!deviceCode) return respond(res, 400, { error: 'device-code-required', message: 'device code 不能为空' })
      try {
        return respond(res, 200, { ok: true, ...(await opts.feishuBot.completeLogin(deviceCode)) })
      } catch (error) {
        return respond(res, 400, {
          error: 'feishu-auth-complete-failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    if (path === '/api/sources/feishu/chats' && req.method === 'GET') {
      return respond(res, 200, {
        chats: config.feishu.chats,
        directMessages: config.feishu.directMessages,
        allowed: config.feishu.allowed,
      })
    }

    if (path === '/api/logs' && req.method === 'GET') {
      // 首次不带 cursor（回看尾部若干行），之后带上一次返回的 cursor 做增量拉取。
      const rawCursor = url.searchParams.get('cursor')
      const cursor = rawCursor === null || rawCursor.trim() === '' ? undefined : Number(rawCursor)
      if (cursor !== undefined && (!Number.isFinite(cursor) || cursor < 0)) {
        return respond(res, 400, { error: 'invalid-cursor' })
      }
      const limit = Number(url.searchParams.get('limit') ?? 200)
      return respond(res, 200, readLogs(logPath, {
        ...(cursor !== undefined ? { cursor } : {}),
        limit: Number.isFinite(limit) ? limit : undefined,
      }))
    }

    // 规范 markdown：列表 / 读取 / 保存 / 恢复默认。内容落在 `<home>/specs/`，不再配置外部路径。
    if (path === '/api/specs' && req.method === 'GET') {
      return respond(res, 200, { specs: listSpecs(config.home) })
    }

    const specDetail = path.match(/^\/api\/specs\/([^/]+)$/)
    if (specDetail) {
      const id = decodeURIComponent(specDetail[1]!)
      if (req.method === 'GET') {
        const spec = getSpec(config.home, id)
        if (!spec) return respond(res, 404, { error: 'spec-not-found', message: `未知规范：${id}` })
        return respond(res, 200, { spec })
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readJson(req)
        try {
          const spec = saveSpec(config.home, id, body.content)
          onEvent({ event: 'api:spec', spec: id, action: 'save' })
          return respond(res, 200, { ok: true, spec })
        } catch (error) {
          return respondSpecError(res, error)
        }
      }
      return respond(res, 405, { error: 'method-not-allowed' })
    }

    const specReset = path.match(/^\/api\/specs\/([^/]+)\/reset$/)
    if (specReset && req.method === 'POST') {
      const id = decodeURIComponent(specReset[1]!)
      try {
        const spec = resetSpec(config.home, id)
        onEvent({ event: 'api:spec', spec: id, action: 'reset' })
        return respond(res, 200, { ok: true, spec })
      } catch (error) {
        return respondSpecError(res, error)
      }
    }

    // 项目登记：本地目录选择 / Git 探测 / Git 地址 clone / Orca 仓库登记。
    if (path === '/api/projects/pick-directory' && req.method === 'POST') {
      if (!opts.projectSetup) return respond(res, 404, { error: 'project-setup-not-available' })
      try {
        return respond(res, 200, await opts.projectSetup.pickDirectory())
      } catch (error) {
        return respondProjectSetupError(res, error)
      }
    }

    if (path === '/api/projects/inspect' && req.method === 'POST') {
      if (!opts.projectSetup) return respond(res, 404, { error: 'project-setup-not-available' })
      const body = await readJson(req)
      const target = typeof body.path === 'string' ? body.path.trim() : ''
      if (!target) return respond(res, 400, { error: 'path-required', message: '请先选择或填写本地目录' })
      try {
        return respond(res, 200, await opts.projectSetup.inspectDirectory(target))
      } catch (error) {
        return respondProjectSetupError(res, error)
      }
    }

    if (path === '/api/projects/register' && req.method === 'POST') {
      if (!opts.projectSetup) return respond(res, 404, { error: 'project-setup-not-available' })
      const body = await readJson(req)
      const target = typeof body.path === 'string' ? body.path.trim() : ''
      if (!target) return respond(res, 400, { error: 'path-required', message: '请先选择或填写本地目录' })
      const runtimeId = readRuntimeId(body, config.runtime.default)
      if (runtimeId === null) return respond(res, 400, { error: 'invalid-runtime', message: '未知的 Worker 运行时' })
      try {
        return respond(res, 200, await opts.projectSetup.prepareLocal(target, runtimeId))
      } catch (error) {
        return respondProjectSetupError(res, error)
      }
    }

    if (path === '/api/projects/clone' && req.method === 'POST') {
      if (!opts.projectSetup) return respond(res, 404, { error: 'project-setup-not-available' })
      const body = await readJson(req)
      const url = typeof body.url === 'string' ? body.url.trim() : ''
      if (!url) return respond(res, 400, { error: 'url-required', message: '请填写 Git 地址' })
      const runtimeId = readRuntimeId(body, config.runtime.default)
      if (runtimeId === null) return respond(res, 400, { error: 'invalid-runtime', message: '未知的 Worker 运行时' })
      try {
        return respond(res, 200, await opts.projectSetup.cloneRepository(url, runtimeId))
      } catch (error) {
        return respondProjectSetupError(res, error)
      }
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
        const policy = opts.engine.updatePolicy(policyOf(config, identityResolution(opts.identity)))
        // 面板保存要落盘，否则重启后策略又回到旧值；home 为空（单测）时跳过写文件。
        if (config.home) writeConfig(config.home, config)
        onEvent({ event: 'api:policy', acceptMode: policy.acceptMode, maxWorkers: policy.maxWorkers, version: policy.version })
        await opts.onPolicyChange?.(config)
        await opts.onConfigChange?.(config, ['policy.acceptMode', 'policy.maxWorkers', 'policy.admission'])
        return respond(res, 200, { policy, config: config.policy })
      }
      return respond(res, 405, { error: 'method-not-allowed' })
    }

    if (path === '/api/restart' && req.method === 'POST') {
      if (!opts.onRestart) return respond(res, 501, { error: 'restart-not-supported' })
      // 先把 202 刷回浏览器，再关闭端口、拉起新进程；页面不用刷新，轮询状态即可。
      return respond(res, 202, { ok: true, restarting: true }, () => {
        setImmediate(() => { void opts.onRestart?.() })
      })
    }

    // 版本更新三件套：读缓存 / 主动检查 / 安装并重启。
    if (path === '/api/update' && req.method === 'GET') {
      if (!opts.update) return respond(res, 404, { error: 'update-not-available' })
      return respond(res, 200, opts.update.snapshot())
    }

    if (path === '/api/update/check' && req.method === 'POST') {
      if (!opts.update) return respond(res, 404, { error: 'update-not-available' })
      return respond(res, 200, await opts.update.check(true))
    }

    if (path === '/api/update' && req.method === 'POST') {
      if (!opts.update) return respond(res, 404, { error: 'update-not-available' })
      const body = await readJson(req)
      const snapshot = await opts.update.upgrade({ force: body.force === true })
      const failed = snapshot.phase === 'failed'
      const restarting = !failed && snapshot.phase === 'updated' && Boolean(opts.onRestart)
      onEvent({
        event: 'api:update',
        phase: snapshot.phase,
        from: snapshot.current,
        to: snapshot.installedVersion ?? snapshot.latest,
        ...(failed && snapshot.error ? { reason: snapshot.error } : {}),
      })
      // 安装成功后先回包再重启：重启会关掉当前进程，先让浏览器拿到结果。
      return respond(
        res,
        failed ? 500 : 200,
        { ...snapshot, restarting },
        restarting ? () => { setImmediate(() => { void opts.onRestart?.() }) } : undefined,
      )
    }

    if (path === '/api/runtimes' && req.method === 'GET') {
      if (!opts.runtimeAdmin) return respond(res, 404, { error: 'runtime-admin-not-available' })
      const snapshot = opts.runtimeAdmin.snapshot()
      return respond(res, 200, {
        ...(snapshot ?? { detectedAt: null, choices: [] }),
        detecting: opts.runtimeAdmin.isDetecting(),
      })
    }

    if (path === '/api/runtimes/detect' && req.method === 'POST') {
      if (!opts.runtimeAdmin) return respond(res, 404, { error: 'runtime-admin-not-available' })
      const snapshot = await opts.runtimeAdmin.detect()
      return respond(res, 200, { ...snapshot, detecting: false })
    }

    if (path === '/api/runtimes/check' && req.method === 'POST') {
      if (!opts.runtimeAdmin) return respond(res, 404, { error: 'runtime-admin-not-available' })
      const body = await readJson(req)
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (!id) return respond(res, 400, { error: 'id-required' })
      const result = await opts.runtimeAdmin.check(id)
      return respond(res, 200, result)
    }

    if (path === '/api/runtimes/install' && req.method === 'POST') {
      if (!opts.runtimeAdmin) return respond(res, 404, { error: 'runtime-admin-not-available' })
      const body = await readJson(req)
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (!id) return respond(res, 400, { error: 'id-required' })
      try {
        const job = opts.runtimeAdmin.startInstall(id, typeof body.version === 'string' ? { version: body.version } : {})
        return respond(res, 202, { ok: true, ...job })
      } catch (error) {
        if (error instanceof InstallStartError) {
          return respond(res, error.code === 'busy' ? 409 : 400, { error: error.code, message: error.message })
        }
        throw error
      }
    }

    const installJobPath = /^\/api\/runtimes\/install\/([^/]+)$/.exec(path)
    if (installJobPath && req.method === 'GET') {
      if (!opts.runtimeAdmin) return respond(res, 404, { error: 'runtime-admin-not-available' })
      const job = opts.runtimeAdmin.installJob(installJobPath[1]!)
      if (!job) return respond(res, 404, { error: 'job-not-found' })
      return respond(res, 200, job)
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
      // keep-alive 连接不会自己断，重启时会让 close 一直挂到超时，这里主动断开。
      server.closeAllConnections?.()
    }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 配置面板的读/写都用同一份口径：安全快照 + 默认值 + 配置文件路径。 */
function configPayload(config: AppConfig, runtimeAdmin?: AcpRuntimeAdmin, identity?: IdentityPort): Record<string, unknown> {
  const snapshot = runtimeAdmin?.snapshot()
  return {
    config: publicConfig(config),
    defaults: publicDefaults(),
    configPath: config.home ? join(config.home, 'config.yaml') : '',
    runtimeChoices: snapshot?.choices ?? [],
    detecting: runtimeAdmin?.isDetecting() ?? false,
    identity: identity?.snapshot() ?? emptyIdentityStatus(),
  }
}

/**
 * 端口给出的解析结果 → 策略层要注入的形态。
 *
 * `allowedOpenIds` 为空时不注入：空集合等于断言「谁都不许」，
 * 而实际可能只是通讯录暂时查不通（原因见 `feishu:allowlist-empty` 事件）。
 */
function identityResolution(identity?: IdentityPort): PolicyResolution | undefined {
  if (!identity?.policyIds) return undefined
  const ids = identity.policyIds()
  return {
    ...(ids.allowedOpenIds && ids.allowedOpenIds.length > 0 ? { allowedOpenIds: ids.allowedOpenIds } : {}),
    ...(ids.allowedByChatOpenIds ? { allowedByChatOpenIds: ids.allowedByChatOpenIds } : {}),
    ...(ids.names ? { names: ids.names } : {}),
  }
}

/** 改动后必须重新解析名单的配置路径（允许名单、群名单、机器人身份、应用 id）。 */
const IDENTITY_PATHS = ['feishu.allowed', 'feishu.chats', 'feishu.appId', 'feishu.botOpenIds', 'feishu.botNames']

/** 本次保存是否涉及允许名单：涉及才需要重新解析并重建策略。 */
function touchesIdentity(changed: string[]): boolean {
  return changed.some(path => IDENTITY_PATHS.includes(path))
}

function respond(res: ServerResponse, status: number, body: unknown, after?: () => void): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload, after)
}

/** 项目登记的可预期失败统一返回 400；未知异常继续抛给外层兜底。 */
function respondProjectSetupError(res: ServerResponse, error: unknown): void {
  if (error instanceof ProjectSetupError) {
    respond(res, 400, { error: error.code, message: error.message, ...(error.detail ?? {}) })
    return
  }
  throw error
}

/** 规范存储的可预期失败：未知规范 404，其余（空内容 / 过大 / 无状态目录）400。 */
function respondSpecError(res: ServerResponse, error: unknown): void {
  if (error instanceof SpecError) {
    respond(res, error.code === 'unknown-spec' ? 404 : 400, { error: error.code, message: error.message })
    return
  }
  throw error
}

/**
 * 面板里切换运行时后未必已经保存，所以允许请求显式带 runtimeId；
 * 不传时沿用当前默认运行时，传了未知值则返回 null 让调用方报 400。
 */
function readRuntimeId(body: Record<string, unknown>, fallback: string): string | null {
  if (typeof body.runtimeId !== 'string' || !body.runtimeId.trim()) return fallback
  const id = normalizeRuntimeId(body.runtimeId)
  return isWorkerRuntimeId(id) ? id : null
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
