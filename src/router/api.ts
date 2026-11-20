import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual as timingSafeEqualBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'
import type { Store } from '../store/db.js'
import type { Engine } from '../core/engine.js'
import { HOT_CONFIG_PREFIXES, isKnownRuntimeId, isLoopbackHost, projectsForRuntime, publicConfig, publicDefaults, publicPlugins, type AppConfig, type PolicyResolution } from '../config.js'
import type { AcpRuntimeAdmin } from '@router-agent/runtime-acp'
import { normalizeRuntimeId } from '#runtime/runtimes/catalog.js'
import { ProjectSetupError, type ProjectSetupPort } from './project-setup.js'
import type { ProjectScanPort } from './project-scan.js'
import type { ChannelAdmin } from '#channel/port.js'
import type { ChannelRegistry } from '#channel/registry.js'
import type { Ticket } from '#core/model.js'
import { noopSink, type EventSink } from '#core/events.js'
import { noopLogger, errorMessage, type Logger } from '#infra/logger.js'
import type { IdentityStatusView } from '@router-agent/channel-feishu'
import type { WorkerStateFile } from '#runtime/report-poller.js'
import type { ResumeHint } from '#runtime/port.js'
import type { WorkspaceAdminPort } from '#runtime/workspaces/overview.js'
import type { PluginPackageAdmin } from './plugin-admin.js'
import type { EventRule } from '../events/rules.js'
import { readLogs } from './log-tail.js'
import type { LogAssistantQuestion, LogAssistantOverview, LogDiagnosis } from './log-assistant.js'
import { buildIssueBody, type IssueReporter } from './issue-report.js'
import { SpecError } from '../specs/index.js'
import { PACKAGE_VERSION, type UpdateSnapshot } from '../update/index.js'
import { discoverLocalProviders, type LocalProviderScan } from './provider-import.js'
import { apiRoutes, type ApiRouteContext } from './api-routes.js'

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

/**
 * 日志页排查助手的端口。
 *
 * 缺省时面板不显示助手入口（端点返回 404），避免旧版本服务端让面板报错。
 */
export interface LogAssistantPort {
  /** 模型是否配齐；面板据此提示「去配置模型」。 */
  llmConfigured(): boolean
  /** 面板打开时展示的当前状态摘要（异常 + 配置问题）。 */
  overview(): LogAssistantOverview
  /** 基于最近日志给出排查结论。 */
  diagnose(question: LogAssistantQuestion): Promise<LogDiagnosis>
}

/** 事件总线的面板能力；缺省时事件相关端点返回 404。 */
export interface EventApiPort {
  listEvents(filter: { status?: string; priority?: string; sourceId?: string; limit?: number }): unknown[]
  listSources(): unknown[]
  /** 面板操作：批准 / 驳回 / 延后 / 忽略 / 重试 / 改优先级。 */
  apply(eventId: string, action: string, options: { priority?: string; project?: string }): Promise<unknown | null>
  /** 当前决策策略。 */
  decision(): { provider: string; confidenceThreshold: number; fallback: string }
  /** 当前规则集。 */
  rules(): EventRule[]
  /** 按规则统计事件命中分布（ruleId → status → 条数）。 */
  ruleStats(): Record<string, Record<string, number>>
  /** 自然语言提炼规则草稿；不可用时返回模板。 */
  compileRule(input: { id: string; eventType: string; intent: string; workflowPrompt?: string }): Promise<EventRule>
  /** 按状态统计事件条数（面板统计卡用；不受列表 limit 影响）。 */
  counts(): Record<string, number>
}

/** 自动化的面板能力；缺省时自动化相关端点返回 404。 */
export interface AutomationApiPort {
  /** 任务列表（含调度状态）。 */
  listTasks(): unknown[]
  /** 执行记录列表。 */
  listRuns(automationId?: string): unknown[]
  /** 单条执行记录；面板轮询用来看执行进度。 */
  getRun(id: string): unknown | null
  /** 待确认的对话式草稿。 */
  listDrafts(): unknown[]
  /** 忽略一条待确认草稿。 */
  dismissDraft(id: string): boolean
  /** 手动触发一次；返回执行记录。 */
  trigger(id: string): Promise<unknown | null>
  /** 生成脚本正文；返回脚本文本，生成不了时返回 null。 */
  generateScript(id: string): Promise<string | null>
  /**
   * 生成脚本正文并带上失败原因。
   *
   * 面板要能告诉用户到底卡在哪（没配模型 / 超时 / 额度被思考吃光），
   * 只返回 null 的话只能给出「生成失败，请重试」这种空话。
   */
  generateScriptWithReason?(id: string): Promise<{ script: string } | { error: string; reason: string }>
  /** 从自然语言生成任务草稿（对话式创建入口用）。 */
  draft(text: string): Promise<unknown | null>
  /** 调用自动化内置工具；范围与限流在服务层强制。 */
  invokeTool(automationId: string, name: string, args: Record<string, unknown>): Promise<{
    ok: boolean
    status: number
    error: string
    hint?: string
    result?: unknown
  }>
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
  /** 插件 npm 包安装任务；缺省时 `/api/plugins/install` 返回 404。 */
  pluginAdmin?: PluginPackageAdmin
  /** 通道管理能力（飞书实现由 FeishuBotAdmin 提供）；缺省时相关端点返回 404。 */
  feishuBot?: ChannelAdmin
  /** 已注册的消息通道；面板据此渲染「渠道配置」的渠道列表。缺省时返回空列表。 */
  channels?: ChannelRegistry
  /** 事件总线；缺省时事件相关端点返回 404。 */
  events?: EventApiPort
  /** 自动化；缺省时自动化相关端点返回 404。 */
  automation?: AutomationApiPort
  /** 面板「日志」页读取的日志文件；缺省时用 `<home>/logs/router-agent.log`。 */
  logPath?: string
  /** 项目登记：目录选择、Git 探测、clone 与 Orca 仓库登记；缺省时端点返回 404。 */
  projectSetup?: ProjectSetupPort
  /** 扫描本机会话日志里的候选项目；缺省时端点返回 404。 */
  projectScan?: ProjectScanPort
  /** 面板「停止」：由服务层关单并排 workspace 回收；缺省时只停 worker（Web-only 模式）。 */
  onStopTicket?: (ticketId: string, reason: string) => Ticket
  /** 工单页「批量清理工作区」：按运行时列出与回收遗留 worktree；缺省时端点返回 501。 */
  workspaceAdmin?: WorkspaceAdminPort
  /** 本机 LLM Provider 发现；缺省扫描当前用户主目录下的 Claude Code / CCSwitch / Pi 配置。 */
  localProviders?: { discover(): Promise<LocalProviderScan> }
  /** 允许名单的解析能力；缺省时面板只拿到空状态，名单按原始条目生效。 */
  identity?: IdentityPort
  /** 日志页的智能排查助手；缺省时相关端点返回 404。 */
  logAssistant?: LogAssistantPort
  /** 排查结果一键上报 GitHub issue；缺省时端点返回 404。 */
  issueReporter?: IssueReporter
  /** 请求级异常与配置写入失败的日志出口。 */
  logger?: Logger
  /** 当前进程加载的插件元数据；启动时由 CLI 注入，面板据此展示自定义运行时/通道。 */
  plugins?: {
    runtimes?: Array<{ id: string; name: string; label: string; hint: string; installHint?: string; installUrl?: string; packageName?: string; deprecated?: boolean; loadedIds?: string[] }>
    channels?: Array<{ id: string; name: string; hint: string; default?: boolean; packageName?: string; loadedIds?: string[] }>
    failures?: Array<{ kind: 'runtime' | 'channel' | 'event'; id: string; specifier: string; message: string }>
  }
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
  const routes = apiRoutes({
    opts,
    config,
    clock,
    logger,
    onEvent,
    version: PACKAGE_VERSION,
    logPath,
    localProviders,
    readJson,
    respond,
    configPayload,
    identityResolution,
    touchesIdentity,
    readRuntimeId,
    respondSpecError,
    respondProjectSetupError,
    legacyReply,
    optionalBoolean,
    isRecord,
    buildIssueBody,
  })
  // 被拒的来源按「路径 + 来源」记一次：面板开放时浏览器轮询会被反复拒绝，
  // 逐条打日志会把真正的错误淹没（AGENTS.md 高频路径降噪）。
  // 用「方法 + 路径」做键而不是原样记路径：路径由客户端决定，无界增长会变成内存问题。
  const deniedSeen = new Set<string>()
  const DENIED_SEEN_LIMIT = 200

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

    // 面板开放访问时（配了令牌），API 请求都要带令牌。
    // 不按来源 IP 放行本机：内网穿透的流量也是从 127.0.0.1 进来的，放行等于没有鉴权。
    // 静态资源不拦：面板外壳本身不含敏感信息，数据一律走 API。
    if (path.startsWith('/api/') && !isAuthorized(req, config.server.token)) {
      const remote = req.socket.remoteAddress ?? ''
      const key = `${req.method} ${path}`
      if (!deniedSeen.has(key)) {
        // 只保留最近的若干条：恶意客户端可以不断换路径，不能让它把内存撑爆。
        if (deniedSeen.size >= DENIED_SEEN_LIMIT) {
          const oldest = deniedSeen.values().next().value
          if (oldest !== undefined) deniedSeen.delete(oldest)
        }
        deniedSeen.add(key)
        logger.warn('api:access-denied', {
          method: req.method,
          path,
          remote,
          host: String(req.headers.host ?? ''),
        })
      }
      return respond(res, 401, { error: 'token-required', message: '面板已开放访问，请带 x-ra-token 请求头' })
    }

    for (const route of routes) {
      const ctx: ApiRouteContext = { req, res, url, path, params: [] }
      if (!route.match(ctx)) continue
      await route.handle(ctx)
      return
    }

    if (path.startsWith('/api/')) return respond(res, 404, { error: 'not-found' })

    return serveStatic(res, path, opts.webRoot)
  }

  const port = opts.port ?? 0
  const host = config.server.host
  // 对外监听却没有令牌：宁可起不来，也不能开一个谁都能改配置的口子。
  if (!isLoopbackHost(host) && !config.server.token) {
    logger.error('api:access-token-missing', { host })
    throw new Error(`监听 ${host} 需要配置访问令牌（server.token）`)
  }
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
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

/**
 * 请求是否被允许访问面板 API。
 *
 * 令牌为空时不做校验（只在本机监听时的默认形态）；
 * 令牌非空时，请求头 `x-ra-token` 里必须带对令牌。
 */
function isAuthorized(req: IncomingMessage, token: string): boolean {
  if (!token) return true
  const header = String(req.headers['x-ra-token'] ?? '')
  return Boolean(header) && timingSafeEqual(header, token)
}

/** 定长比较，避免令牌被逐字节试探；长度不同直接判否。 */
function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  // timingSafeEqual 要求等长输入，长度不同先判否。
  return left.length === right.length && timingSafeEqualBytes(left, right)
}

/** 上报里的三态布尔：true / false / 未声明。字符串兼容旧客户端。 */
function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

/** 配置面板的读/写都用同一份口径：安全快照 + 默认值 + 配置文件路径。 */
function configPayload(
  config: AppConfig,
  runtimeAdmin?: AcpRuntimeAdmin,
  identity?: IdentityPort,
  plugins?: ApiServerOptions['plugins'],
): Record<string, unknown> {
  const snapshot = runtimeAdmin?.snapshot()
  return {
    config: publicConfig(config),
    defaults: publicDefaults(),
    configPath: config.home ? join(config.home, 'config.yaml') : '',
    runtimeChoices: snapshot?.choices ?? [],
    plugins: publicPlugins(config, plugins),
    detecting: runtimeAdmin?.isDetecting() ?? false,
    identity: identity?.snapshot() ?? emptyIdentityStatus(),
    // 项目清单：自动化面板要选目标项目，不必再让前端解析配置草稿。
    projects: projectsForRuntime(config).map(project => ({
      name: project.name,
      repo: project.repo,
      defaultBranch: project.defaultBranch,
    })),
    // 哪些配置路径保存后立即生效：面板按它给配置项标「立即生效 / 重启生效」。
    hotPaths: [...HOT_CONFIG_PREFIXES],
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
function readRuntimeId(body: Record<string, unknown>, fallback: string, config: AppConfig): string | null {
  if (typeof body.runtimeId !== 'string' || !body.runtimeId.trim()) return fallback
  const id = normalizeRuntimeId(body.runtimeId)
  return isKnownRuntimeId(config, id) ? id : null
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

/** 兼容旧版 deliverable：内容 + 链接拼成纯回复。 */
function legacyReply(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return ''
  const value = raw as Record<string, unknown>
  return [String(value.content ?? '').trim(), String(value.url ?? '').trim()].filter(Boolean).join('\n\n')
}

