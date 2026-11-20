import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  applyConfigPatch,
  policyOf,
  requiresRestart,
  writeConfig,
  type AppConfig,
  type PolicyResolution,
} from '../config.js'
import type { Logger } from '#infra/logger.js'
import type { EventSink } from '#core/events.js'
import type { ApiServerOptions } from './api.js'
import { errorMessage } from '#infra/logger.js'
import { preview } from '#core/events.js'
import { isReplyPayload, type ReplyPayload } from '#core/reply.js'
import { ReportRejectedError } from '#runtime/evidence-gate.js'
import type { WorkerStateFile } from '#runtime/report-poller.js'
import type { ResumeHint } from '#runtime/port.js'
import type { LogDiagnosis } from './log-assistant.js'
import { getSpec, listSpecs, resetSpec, saveSpec } from '../specs/index.js'
import { InstallStartError } from '@router-agent/runtime-acp'
import { PluginInstallStartError } from './plugin-admin.js'
import type { AcceptMode } from '#core/policy.js'
import { readLogs } from './log-tail.js'
import {
  toLocalProviderView,
  type LocalProviderScan,
} from './provider-import.js'

/**
 * API 路由表。
 *
 * 每条记录 = 一个端点。**数组顺序即匹配顺序**：先命中先处理，
 * 与拆分前那串 if 的判断顺序完全一致（有的路径会被多条规则命中，靠顺序区分）。
 *
 * `match` 只判定「这条路由接不接」；`handle` 负责写响应。
 * 路径参数由 `match` 从正则捕获组里取到 `ctx.params`，`handle` 再取用。
 */

/** 路由判定与处理所需的上下文。 */
export interface ApiRouteContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  path: string
  /** 路径参数；由 match 从正则捕获组里取出。 */
  params: string[]
}

export interface ApiRoute {
  match(ctx: ApiRouteContext): boolean
  handle(ctx: ApiRouteContext): Promise<void>
}

/** 精确匹配路径 + 方法；method 传空串表示不限方法。 */
function exact(path: string, method: string): ApiRoute['match'] {
  return ctx => ctx.path === path && (method === '' || ctx.req.method === method)
}

/** 正则匹配路径 + 方法；捕获组作为路径参数。 */
function pattern(regexp: RegExp, method: string): ApiRoute['match'] {
  return ctx => {
    const matched = regexp.exec(ctx.path)
    if (!matched) return false
    ctx.params = matched.slice(1)
    return method === '' || ctx.req.method === method
  }
}

/** 路由表需要的依赖：全部来自 createApiServer 的闭包。 */
export interface ApiRouteDeps {
  opts: ApiServerOptions
  config: AppConfig
  clock: { now(): string }
  logger: Logger
  onEvent: EventSink
  readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>
  respond: (res: ServerResponse, status: number, body: unknown, after?: () => void) => void
  /** 面板配置读写共用的载荷构造。 */
  configPayload: (
    config: AppConfig,
    runtimeAdmin?: ApiServerOptions['runtimeAdmin'],
    identity?: ApiServerOptions['identity'],
    plugins?: ApiServerOptions['plugins'],
  ) => Record<string, unknown>
  /** 身份解析结果 → 策略层形态。 */
  identityResolution: (identity?: ApiServerOptions['identity']) => PolicyResolution | undefined
  /** 本次保存是否涉及允许名单。 */
  touchesIdentity: (changed: string[]) => boolean
  /** 请求体里的运行时 id；未知值返回 null。 */
  readRuntimeId: (body: Record<string, unknown>, fallback: string, config: AppConfig) => string | null
  /** 规范存储的可预期失败 → 4xx。 */
  respondSpecError: (res: ServerResponse, error: unknown) => void
  /** 项目登记的可预期失败 → 400。 */
  respondProjectSetupError: (res: ServerResponse, error: unknown) => void
  /** 兼容旧版 deliverable。 */
  legacyReply: (raw: unknown) => string
  /** 上报里的三态布尔。 */
  optionalBoolean: (value: unknown) => boolean | undefined
  /** 是不是普通对象。 */
  isRecord: (value: unknown) => value is Record<string, unknown>
  /** 组装 issue 正文。 */
  buildIssueBody: (input: { question: string; diagnosis: LogDiagnosis; version: string }) => string
  /** 当前版本号。 */
  version: string
  /** 服务日志路径。 */
  logPath: string
  /** 本机 Provider 扫描。 */
  localProviders: { discover(): Promise<LocalProviderScan> }
}

/** 按匹配顺序返回全部路由。 */
export function apiRoutes(deps: ApiRouteDeps): ApiRoute[] {
  const {
    opts, config, clock, logger, onEvent, readJson, respond,
    configPayload, identityResolution, touchesIdentity, readRuntimeId,
    respondSpecError, respondProjectSetupError, legacyReply, optionalBoolean,
    isRecord, buildIssueBody, version, logPath, localProviders,
  } = deps
  const PACKAGE_VERSION = version
  const groupByStage = (stages: string[]): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const stage of stages) out[stage] = (out[stage] ?? 0) + 1
    return out
  }

  return [
  {
    match: exact('/api/status', 'GET'),
    async handle({ req, res, url, path, params }) {
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
    },
  },

  {
    match: exact('/api/tickets', 'GET'),
    async handle({ req, res, url, path, params }) {
      const stage = url.searchParams.get('stage') ?? undefined
      const limit = Number(url.searchParams.get('limit') ?? 200)
      return respond(res, 200, { tickets: opts.store.listTickets({ ...(stage ? { stage: stage as never } : {}), limit }) })
    },
  },

  {
    match: pattern(/^\/api\/tickets\/([^/]+)$/, 'GET'),
    async handle({ req, res, url, path, params }) {
      const ticket = opts.store.getTicket(params[0]!)
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
    },
  },

  {
    match: pattern(/^\/api\/tickets\/([^/]+)\/(input|stop|assignment)$/, ''),
    async handle({ req, res, url, path, params }) {
      const ticketId = params[0]!
      const what = params[1]!
      const body = req.method === 'POST' ? await readJson(req) : {}
      const ticket = opts.store.getTicket(ticketId)
      if (!ticket) return respond(res, 404, { error: 'ticket-not-found' })

      if (what === 'input' && req.method === 'POST') {
        const text = String((body as Record<string, unknown>).text ?? '').trim()
        if (!text) return respond(res, 400, { error: 'text-required' })
        const kind = String((body as Record<string, unknown>).kind ?? 'followup') as never
        // 调用方可以自带来源标识做精确去重（例如面板按消息 id 提交）。
        const sourceKey = String((body as Record<string, unknown>).sourceKey ?? '').trim()
        try {
          const input = opts.engine.deliverInput(ticketId, { kind, text, ...(sourceKey ? { sourceKey } : {}) })
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
    },
  },

  {
    match: exact('/api/workspaces', 'GET'),
    async handle({ req, res, url, path, params }) {
      if (!opts.workspaceAdmin) return respond(res, 501, { error: 'workspace-admin-not-supported' })
      return respond(res, 200, await opts.workspaceAdmin.list())
    },
  },

  {
    match: exact('/api/workspaces/cleanup', 'POST'),
    async handle({ req, res, url, path, params }) {
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
        logger.warn('api:workspace-cleanup-failed', {
          requested: ticketIds.length,
          ...(runtimeId ? { runtimeId } : {}),
          message: errorMessage(error),
        })
        return respond(res, 400, {
          error: 'workspace-cleanup-failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
  },

  {
    match: exact('/api/reports', 'POST'),
    async handle({ req, res, url, path, params }) {
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
      const rawPayload = body.replyPayload
      if (rawPayload !== undefined && !isReplyPayload(rawPayload)) {
        return respond(res, 400, { error: 'invalid-reply-payload', message: 'replyPayload 结构不合法' })
      }
      const replyPayload = isReplyPayload(rawPayload) ? rawPayload as ReplyPayload : undefined
      const reply = String(body.reply ?? legacyReply(body.deliverable) ?? replyPayload?.fallbackText ?? '').trim()
      const uiChange = optionalBoolean(body.uiChange)

      const payload: WorkerStateFile = {
        ticketId,
        assignmentId: assignment.id,
        turn,
        state: state as WorkerStateFile['state'],
        summary,
        ...(body.humanAction ? { humanAction: String(body.humanAction) } : {}),
        prNumber: Number(body.prNumber ?? 0) || 0,
        prUrl: String(body.prUrl ?? ''),
        ...(uiChange !== undefined ? { uiChange } : {}),
        ...(reply ? { reply } : {}),
        ...(replyPayload ? { replyPayload } : {}),
        ackedInputs: Array.isArray(body.ackedInputs) ? body.ackedInputs.map(String) : [],
        updatedAt: String(body.updatedAt ?? clock.now()),
      }

      try {
        await opts.onReport(payload)
      } catch (error) {
        // UI 证据门禁的可预期拒绝：回 422，而不是 500，让 worker 能按文案修正或改报 blocked。
        if (error instanceof ReportRejectedError) {
          return respond(res, 422, { error: error.code, message: error.message, ...error.detail })
        }
        throw error
      }
      onEvent({ event: 'api:report', ticketId, state, turn, replyChars: reply.length })
      return respond(res, 201, { ok: true, ticketId, assignmentId: assignment.id, turn, state, reply: Boolean(reply) })
    },
  },

  {
    match: exact('/api/channels', 'GET'),
    async handle({ req, res, url, path, params }) {
      const registered = opts.channels?.list() ?? []
      onEvent({ event: 'api:channels', count: registered.length })
      return respond(res, 200, {
        channels: registered.map(channel => ({
          id: channel.id,
          kind: channel.kind,
          capabilities: channel.capabilities,
        })),
      })
    },
  },

  {
    match: exact('/api/config', ''),
    async handle({ req, res, url, path, params }) {
      if (req.method === 'GET') {
        return respond(res, 200, configPayload(config, opts.runtimeAdmin, opts.identity, opts.plugins))
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
          ...configPayload(config, opts.runtimeAdmin, opts.identity, opts.plugins),
          ok: true,
          changed: result.changed,
          policyChanged,
          restartRequired,
          // 名单已经即时生效（不用等重启）；restartRequired 说的是路径粒度的其它配置项。
          identityEffective,
        })
      }
      return respond(res, 405, { error: 'method-not-allowed' })
    },
  },

  {
    match: exact('/api/llm/local-providers', 'GET'),
    async handle({ req, res, url, path, params }) {
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
    },
  },

  {
    match: exact('/api/llm/local-providers/import', 'POST'),
    async handle({ req, res, url, path, params }) {
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
        ...configPayload(config, opts.runtimeAdmin, opts.identity, opts.plugins),
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
    },
  },

  {
    match: exact('/api/feishu/status', 'GET'),
    async handle({ req, res, url, path, params }) {
      if (!opts.feishuBot) return respond(res, 404, { error: 'feishu-bot-not-available' })
      const status = await opts.feishuBot.status()
      return respond(res, 200, {
        profileHome: opts.feishuBot.profileHome,
        configAppId: config.feishu.appId,
        appId: status.appId,
        bot: status.bot,
        user: status.user,
      })
    },
  },

  {
    match: exact('/api/feishu/credentials', 'POST'),
    async handle({ req, res, url, path, params }) {
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
          logger.error('config:write-failed', { home: config.home, message: errorMessage(error) })
          return respond(res, 500, {
            error: 'config-write-failed',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return respond(res, 200, {
        ok: true,
        message: result.message,
        ...configPayload(config, opts.runtimeAdmin, opts.identity, opts.plugins),
      })
    },
  },

  {
    match: exact('/api/feishu/auth/login', 'POST'),
    async handle({ req, res, url, path, params }) {
      if (!opts.feishuBot) return respond(res, 404, { error: 'feishu-bot-not-available' })
      try {
        return respond(res, 200, await opts.feishuBot.startLogin())
      } catch (error) {
        return respond(res, 400, {
          error: 'feishu-auth-start-failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
  },

  {
    match: exact('/api/feishu/auth/complete', 'POST'),
    async handle({ req, res, url, path, params }) {
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
    },
  },

  {
    match: exact('/api/sources/feishu/chats', 'GET'),
    async handle({ req, res, url, path, params }) {
      return respond(res, 200, {
        chats: config.feishu.chats,
        directMessages: config.feishu.directMessages,
        allowed: config.feishu.allowed,
      })
    },
  },

  {
    match: exact('/api/logs', 'GET'),
    async handle({ req, res, url, path, params }) {
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
    },
  },

  {
    match: exact('/api/logs/assistant', ''),
    async handle({ req, res, url, path, params }) {
      if (!opts.logAssistant) return respond(res, 404, { error: 'log-assistant-not-available' })
      if (req.method === 'GET') {
        return respond(res, 200, {
          llmConfigured: opts.logAssistant.llmConfigured(),
          overview: opts.logAssistant.overview(),
        })
      }
      if (req.method === 'POST') {
        const body = await readJson(req)
        const question = typeof body.question === 'string' ? body.question.trim() : ''
        const level = typeof body.level === 'string' ? body.level : undefined
        const keyword = typeof body.keyword === 'string' ? body.keyword : undefined
        try {
          const diagnosis = await opts.logAssistant.diagnose({
            question,
            ...(level ? { level } : {}),
            ...(keyword ? { keyword } : {}),
          })
          return respond(res, 200, { diagnosis })
        } catch (error) {
          logger.error('api:log-assistant-failed', {
            detail: errorMessage(error),
            question: preview(question, 120),
          })
          return respond(res, 500, { error: 'log-assistant-failed', message: errorMessage(error) })
        }
      }
      return respond(res, 405, { error: 'method-not-allowed' })
    },
  },

  {
    match: exact('/api/logs/assistant/issue', 'POST'),
    async handle({ req, res, url, path, params }) {
      if (!opts.issueReporter) return respond(res, 404, { error: 'issue-report-not-available' })
      const body = await readJson(req)
      const question = typeof body.question === 'string' ? body.question.trim() : ''
      const diagnosis = body.diagnosis as LogDiagnosis | undefined
      if (!diagnosis || typeof diagnosis.summary !== 'string') {
        return respond(res, 400, { error: 'diagnosis-required', message: '缺少排查结论' })
      }
      const title = typeof body.title === 'string' && body.title.trim()
        ? body.title.trim().slice(0, 200)
        : `[排查助手] ${(question || diagnosis.summary).slice(0, 120)}`
      try {
        const issue = await opts.issueReporter.create({
          title,
          body: buildIssueBody({ question, diagnosis, version: PACKAGE_VERSION }),
        })
        onEvent({ event: 'api:issue', number: issue.number, url: issue.url })
        return respond(res, 200, { issue })
      } catch (error) {
        logger.error('api:issue-create-failed', { detail: errorMessage(error) })
        return respond(res, 500, { error: 'issue-create-failed', message: errorMessage(error) })
      }
    },
  },

  {
    match: exact('/api/specs', 'GET'),
    async handle({ req, res, url, path, params }) {
      return respond(res, 200, { specs: listSpecs(config.home) })
    },
  },

  {
    match: pattern(/^\/api\/specs\/([^/]+)$/, ''),
    async handle({ req, res, url, path, params }) {
      const id = decodeURIComponent(params[0]!)
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
    },
  },

  {
    match: pattern(/^\/api\/specs\/([^/]+)\/reset$/, ''),
    async handle({ req, res, url, path, params }) {
      const id = decodeURIComponent(params[0]!)
      try {
        const spec = resetSpec(config.home, id)
        onEvent({ event: 'api:spec', spec: id, action: 'reset' })
        return respond(res, 200, { ok: true, spec })
      } catch (error) {
        return respondSpecError(res, error)
      }
    },
  },

  {
    match: exact('/api/projects/pick-directory', 'POST'),
    async handle({ req, res, url, path, params }) {
      if (!opts.projectSetup) return respond(res, 404, { error: 'project-setup-not-available' })
      try {
        return respond(res, 200, await opts.projectSetup.pickDirectory())
      } catch (error) {
        return respondProjectSetupError(res, error)
      }
    },
  },

  {
    match: exact('/api/projects/scan', 'POST'),
    async handle({ req, res, url, path, params }) {
      if (!opts.projectScan) return respond(res, 404, { error: 'project-scan-not-available' })
      try {
        const projects = await opts.projectScan.scan()
        onEvent({ event: 'project:scanned', count: projects.length })
        return respond(res, 200, { projects })
      } catch (error) {
        logger.warn('project:scan-failed', { detail: errorMessage(error) })
        return respond(res, 500, { error: 'project-scan-failed', message: errorMessage(error) })
      }
    },
  },

  {
    match: exact('/api/projects/inspect', 'POST'),
    async handle({ req, res, url, path, params }) {
      if (!opts.projectSetup) return respond(res, 404, { error: 'project-setup-not-available' })
      const body = await readJson(req)
      const target = typeof body.path === 'string' ? body.path.trim() : ''
      if (!target) return respond(res, 400, { error: 'path-required', message: '请先选择或填写本地目录' })
      try {
        return respond(res, 200, await opts.projectSetup.inspectDirectory(target))
      } catch (error) {
        return respondProjectSetupError(res, error)
      }
    },
  },

  {
    match: exact('/api/projects/register', 'POST'),
    async handle({ req, res, url, path, params }) {
      if (!opts.projectSetup) return respond(res, 404, { error: 'project-setup-not-available' })
      const body = await readJson(req)
      const target = typeof body.path === 'string' ? body.path.trim() : ''
      if (!target) return respond(res, 400, { error: 'path-required', message: '请先选择或填写本地目录' })
      const runtimeId = readRuntimeId(body, config.runtime.default, config)
      if (runtimeId === null) return respond(res, 400, { error: 'invalid-runtime', message: '未知的 Worker 运行时' })
      try {
        return respond(res, 200, await opts.projectSetup.prepareLocal(target, runtimeId))
      } catch (error) {
        return respondProjectSetupError(res, error)
      }
    },
  },

  {
    match: exact('/api/projects/clone', 'POST'),
    async handle({ req, res, url, path, params }) {
      if (!opts.projectSetup) return respond(res, 404, { error: 'project-setup-not-available' })
      const body = await readJson(req)
      const repoUrl = typeof body.url === 'string' ? body.url.trim() : ''
      if (!repoUrl) return respond(res, 400, { error: 'url-required', message: '请填写 Git 地址' })
      const runtimeId = readRuntimeId(body, config.runtime.default, config)
      if (runtimeId === null) return respond(res, 400, { error: 'invalid-runtime', message: '未知的 Worker 运行时' })
      try {
        return respond(res, 200, await opts.projectSetup.cloneRepository(repoUrl, runtimeId))
      } catch (error) {
        return respondProjectSetupError(res, error)
      }
    },
  },

  {
    match: exact('/api/policy', ''),
    async handle({ req, res, url, path, params }) {
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
        const policy = opts.engine.updatePolicy(policyOf(config, identityResolution(opts.identity)))
        // 面板保存要落盘，否则重启后策略又回到旧值；home 为空（单测）时跳过写文件。
        if (config.home) writeConfig(config.home, config)
        onEvent({ event: 'api:policy', acceptMode: policy.acceptMode, maxWorkers: policy.maxWorkers, version: policy.version })
        await opts.onPolicyChange?.(config)
        await opts.onConfigChange?.(config, ['policy.acceptMode', 'policy.maxWorkers'])
        return respond(res, 200, { policy, config: config.policy })
      }
      return respond(res, 405, { error: 'method-not-allowed' })
    },
  },

  {
    match: exact('/api/restart', 'POST'),
    async handle({ req, res, url, path, params }) {
      if (!opts.onRestart) return respond(res, 501, { error: 'restart-not-supported' })
      // 先把 202 刷回浏览器，再关闭端口、拉起新进程；页面不用刷新，轮询状态即可。
      return respond(res, 202, { ok: true, restarting: true }, () => {
        setImmediate(() => { void opts.onRestart?.() })
      })
    },
  },

  {
    match: exact('/api/update', 'GET'),
    async handle({ req, res, url, path, params }) {
      if (!opts.update) return respond(res, 404, { error: 'update-not-available' })
      return respond(res, 200, opts.update.snapshot())
    },
  },

  {
    match: exact('/api/update/check', 'POST'),
    async handle({ req, res, url, path, params }) {
      if (!opts.update) return respond(res, 404, { error: 'update-not-available' })
      return respond(res, 200, await opts.update.check(true))
    },
  },

  {
    match: exact('/api/update', 'POST'),
    async handle({ req, res, url, path, params }) {
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
    },
  },

  {
    match: exact('/api/runtimes', 'GET'),
    async handle({ req, res, url, path, params }) {
      if (!opts.runtimeAdmin) return respond(res, 404, { error: 'runtime-admin-not-available' })
      const snapshot = opts.runtimeAdmin.snapshot()
      return respond(res, 200, {
        ...(snapshot ?? { detectedAt: null, choices: [] }),
        detecting: opts.runtimeAdmin.isDetecting(),
      })
    },
  },

  {
    match: exact('/api/runtimes/detect', 'POST'),
    async handle({ req, res, url, path, params }) {
      if (!opts.runtimeAdmin) return respond(res, 404, { error: 'runtime-admin-not-available' })
      const snapshot = await opts.runtimeAdmin.detect()
      return respond(res, 200, { ...snapshot, detecting: false })
    },
  },

  {
    match: exact('/api/runtimes/check', 'POST'),
    async handle({ req, res, url, path, params }) {
      if (!opts.runtimeAdmin) return respond(res, 404, { error: 'runtime-admin-not-available' })
      const body = await readJson(req)
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (!id) return respond(res, 400, { error: 'id-required' })
      const result = await opts.runtimeAdmin.check(id)
      if (!result.ok) logger.warn('runtime:check-failed', { runtimeId: id, detail: result.detail })
      return respond(res, 200, result)
    },
  },

  {
    match: exact('/api/runtimes/probe', 'POST'),
    async handle({ req, res, url, path, params }) {
      if (!opts.runtimeAdmin) return respond(res, 404, { error: 'runtime-admin-not-available' })
      const body = await readJson(req)
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (!id) return respond(res, 400, { error: 'id-required' })
      const result = await opts.runtimeAdmin.probe(id)
      if (!result.ok) logger.warn('runtime:probe-failed', { runtimeId: id, detail: result.detail })
      return respond(res, 200, result)
    },
  },

  {
    match: exact('/api/runtimes/install', 'POST'),
    async handle({ req, res, url, path, params }) {
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
    },
  },

  {
    match: pattern(/^\/api\/runtimes\/install\/([^/]+)$/, 'GET'),
    async handle({ req, res, url, path, params }) {
      if (!opts.runtimeAdmin) return respond(res, 404, { error: 'runtime-admin-not-available' })
      const job = opts.runtimeAdmin.installJob(params[0]!)
      if (!job) return respond(res, 404, { error: 'job-not-found' })
      return respond(res, 200, job)
    },
  },

  {
    match: exact('/api/plugins/install', 'POST'),
    async handle({ req, res, url, path, params }) {
      if (!opts.pluginAdmin) return respond(res, 404, { error: 'plugin-admin-not-available' })
      const body = await readJson(req)
      const kind = body.kind === undefined || body.kind === 'runtime'
        ? 'runtime' as const
        : body.kind === 'channel' ? 'channel' as const : null
      if (!kind) return respond(res, 400, { error: 'invalid-kind', message: 'kind 只能是 runtime / channel' })
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      try {
        const installOpts: { version?: string; packageName?: string; entry?: string } = {}
        if (typeof body.version === 'string') installOpts.version = body.version
        if (typeof body.packageName === 'string') installOpts.packageName = body.packageName
        if (typeof body.entry === 'string') installOpts.entry = body.entry
        const job = opts.pluginAdmin.startInstall(kind, id, installOpts)
        onEvent({ event: 'api:plugin-install', kind, id, package: job.packageName, version: job.version })
        // jobId 与 ACP 安装端点保持同一字段名，面板轮询写同一套逻辑。
        return respond(res, 202, { ok: true, jobId: job.id, ...job })
      } catch (error) {
        if (error instanceof PluginInstallStartError) {
          return respond(res, error.code === 'busy' ? 409 : 400, { error: error.code, message: error.message })
        }
        throw error
      }
    },
  },

  {
    match: pattern(/^\/api\/plugins\/install\/([^/]+)$/, 'GET'),
    async handle({ req, res, url, path, params }) {
      if (!opts.pluginAdmin) return respond(res, 404, { error: 'plugin-admin-not-available' })
      const job = opts.pluginAdmin.installJob(params[0]!)
      if (!job) return respond(res, 404, { error: 'job-not-found' })
      return respond(res, 200, job)
    },
  },
  ]
}
