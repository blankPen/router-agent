import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'
import type { Store } from '../store/db.js'
import type { Engine } from '../core/engine.js'
import { HOT_CONFIG_PREFIXES, isKnownRuntimeId, publicConfig, publicDefaults, publicPlugins, type AppConfig, type PolicyResolution } from '../config.js'
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
    failures?: Array<{ kind: 'runtime' | 'channel'; id: string; specifier: string; message: string }>
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
