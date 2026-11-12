/**
 * 插件包安装任务：把 `runtime.plugins.<id>` / `channels.<id>` 里声明的 npm 包
 * 装到 `<RA_HOME>/node_modules`。
 *
 * 加载器以配置文件为锚点解析包名，所以「声明包名」与「把包装上」是两件事；
 * 这里负责后者，并给面板 / CLI 提供可轮询的安装任务（含 npm 输出）。
 */
import { randomUUID } from 'node:crypto'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import { pluginSpecifier, type PluginEntry, type PluginKind } from '#infra/plugin-loader.js'
import { installPluginPackage, npmPackageNameOf, type NpmRunner } from '#infra/plugin-install.js'
import { preview } from '#core/events.js'
import { DEFAULT_RUNTIME_PLUGINS } from '#runtime/plugins/loader.js'
import type { AppConfig } from '../config.js'

export interface PluginInstallJob {
  id: string
  kind: PluginKind
  pluginId: string
  packageName: string
  version: string
  status: 'running' | 'ok' | 'failed'
  phase: 'queued' | 'installing' | 'succeeded' | 'failed'
  startedAt: string
  finishedAt?: string
  installedVersion?: string
  lines: string[]
  error?: string
}

export class PluginInstallStartError extends Error {
  constructor(
    readonly code: 'unknown-plugin' | 'not-a-package' | 'busy',
    message: string,
  ) {
    super(message)
    this.name = 'PluginInstallStartError'
  }
}

export interface PluginPackageAdminOptions {
  home: string
  config: AppConfig
  env: NodeJS.ProcessEnv
  logger?: Logger
  /** 测试注入：执行 npm，返回退出码。 */
  runNpm?: NpmRunner
  clock?: { now(): string }
}

const MAX_JOBS = 50
const MAX_LINES = 200

/** 插件入口在配置里的路径；错误提示直接告诉用户写哪里。 */
function entryPath(kind: PluginKind, id: string): string {
  return kind === 'runtime' ? `runtime.plugins.${id}` : `channels.${id}`
}

/** 安装任务的单进程管理器；API 与 CLI 共用。 */
export class PluginPackageAdmin {
  private readonly jobs = new Map<string, PluginInstallJob>()
  private readonly activeByPlugin = new Map<string, string>()
  private readonly logger: Logger
  private readonly clock: { now(): string }

  constructor(private readonly opts: PluginPackageAdminOptions) {
    this.logger = opts.logger ?? noopLogger
    this.clock = opts.clock ?? { now: () => new Date().toISOString() }
  }

  /** 读配置里声明的插件入口；`undefined` 表示没有这个插件。 */
  entryOf(kind: PluginKind, id: string): PluginEntry | undefined {
    return kind === 'runtime' ? this.opts.config.runtime.plugins?.[id] : this.opts.config.channels?.[id]
  }

  installJob(jobId: string): PluginInstallJob | undefined {
    return this.jobs.get(jobId)
  }

  /**
   * 启动一次安装任务。
   *
   * 面板「添加运行时」会在配置还没保存时带着包名来安装，所以允许用
   * `opts.packageName` 直接指定 npm 包；否则按配置里声明的入口解析。
   * 本地路径插件重启即可生效，不存在「下载」这一步，直接报错让调用方引导用户。
   */
  startInstall(kind: PluginKind, id: string, opts: { version?: string; packageName?: string } = {}): PluginInstallJob {
    const pluginId = id.trim()
    if (!pluginId) throw new PluginInstallStartError('unknown-plugin', '缺少插件 id')
    const requested = opts.packageName?.trim()
    let packageName: string | undefined
    if (requested) {
      packageName = npmPackageNameOf(requested)
      if (!packageName) {
        throw new PluginInstallStartError(
          'not-a-package',
          `${pluginId} 提供的不是 npm 包名：${preview(requested, 120)}；本地路径不需要下载，重启服务后按路径加载`,
        )
      }
    } else {
      const entry = this.entryOf(kind, pluginId)
      if (entry === undefined) {
        const builtin = kind === 'runtime' && DEFAULT_RUNTIME_PLUGINS[pluginId]
        throw new PluginInstallStartError(
          'unknown-plugin',
          builtin
            ? `${pluginId} 使用 ra 自带的内置包；如需换成其它 npm 包，先添加 ${entryPath(kind, pluginId)} 入口`
            : `配置里没有 ${kind} 插件 ${pluginId} 的入口；先添加 ${entryPath(kind, pluginId)} 再安装`,
        )
      }
      const specifier = pluginSpecifier(entry)
      if (!specifier) {
        throw new PluginInstallStartError('unknown-plugin', `${pluginId} 在配置里被禁用（enabled: false）`)
      }
      packageName = npmPackageNameOf(specifier)
      if (!packageName) {
        throw new PluginInstallStartError(
          'not-a-package',
          `${pluginId} 配置的是本地路径 ${preview(specifier, 120)}，不需要下载；重启服务后按路径加载`,
        )
      }
    }

    const key = `${kind}:${pluginId}`
    const activeJob = this.activeByPlugin.get(key)
    if (activeJob) throw new PluginInstallStartError('busy', `${pluginId} 正在安装（任务 ${activeJob}）`)

    const version = opts.version?.trim() || 'latest'
    const job: PluginInstallJob = {
      id: randomUUID(),
      kind,
      pluginId,
      packageName,
      version,
      status: 'running',
      phase: 'queued',
      startedAt: this.clock.now(),
      lines: [],
    }
    this.jobs.set(job.id, job)
    this.trimJobs()
    this.activeByPlugin.set(key, job.id)

    void (async () => {
      job.phase = 'installing'
      try {
        const result = await installPluginPackage({
          home: this.opts.home,
          packageName,
          version,
          env: this.opts.env,
          logger: this.logger,
          ...(this.opts.runNpm ? { runNpm: this.opts.runNpm } : {}),
          onLine: line => {
            job.lines.push(line)
            if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES)
          },
        })
        job.status = result.ok ? 'ok' : 'failed'
        job.phase = result.ok ? 'succeeded' : 'failed'
        if (result.version) job.installedVersion = result.version
        if (result.error) job.error = result.error
      } catch (error) {
        // 安装器自己会兜住异常；这里再兜一层，保证任务不会永远停在 running。
        const detail = errorMessage(error)
        job.status = 'failed'
        job.phase = 'failed'
        job.error = detail
        this.logger.error('plugin:install-failed', { kind, id: pluginId, package: packageName, detail })
      } finally {
        job.finishedAt = this.clock.now()
        this.activeByPlugin.delete(key)
      }
    })()

    return job
  }

  /** 只保留最近的任务，避免长时间运行的服务堆积 npm 输出。 */
  private trimJobs(): void {
    while (this.jobs.size > MAX_JOBS) {
      const oldest = this.jobs.keys().next().value
      if (oldest === undefined) return
      this.jobs.delete(oldest)
    }
  }
}
