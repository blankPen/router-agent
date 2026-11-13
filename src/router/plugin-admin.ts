/**
 * 插件包安装任务：把 `runtime.plugins.<id>` / `channels.<id>` 里声明的 npm 包
 * 装到 `<RA_HOME>/node_modules`。
 *
 * 加载器以配置文件为锚点解析包名，所以「声明包名」与「把包装上」是两件事；
 * 这里负责后者，并给面板 / CLI 提供可轮询的安装任务（含 npm 输出）。
 */
import { randomUUID } from 'node:crypto'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import { pluginSpecifier, readPluginDeclaration, type PluginEntry, type PluginKind } from '#infra/plugin-loader.js'
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
  /** 插件包自己声明的 id；装完并加载校验通过后才有值。 */
  declaredId?: string
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
   * 面板「添加运行时」会在配置还没保存时带着入口来安装，所以允许用
   * `opts.entry` 直接指定入口（npm 包名或本地路径）；否则按配置里声明的入口解析。
   * id 不由入口推导：装完并成功加载后，从插件包声明的 `meta.id` 读出来。
   */
  startInstall(kind: PluginKind, id: string, opts: { version?: string; packageName?: string; entry?: string } = {}): PluginInstallJob {
    const pluginId = id.trim()
    const entry = opts.entry?.trim()
    let packageName: string | undefined
    let specifier = entry ?? ''
    if (entry) {
      packageName = npmPackageNameOf(entry)
    } else if (opts.packageName?.trim()) {
      // packageName 语义严格：必须是 npm 包名，本地路径走 entry。
      packageName = npmPackageNameOf(opts.packageName)
      if (!packageName) {
        throw new PluginInstallStartError(
          'not-a-package',
          `提供的不是 npm 包名：${preview(opts.packageName, 120)}；本地路径请用 entry 参数`,
        )
      }
      specifier = packageName
    } else {
      if (!pluginId) throw new PluginInstallStartError('unknown-plugin', '缺少插件 id')
      const configured = this.entryOf(kind, pluginId)
      if (configured === undefined) {
        const builtin = kind === 'runtime' && DEFAULT_RUNTIME_PLUGINS[pluginId]
        throw new PluginInstallStartError(
          'unknown-plugin',
          builtin
            ? `${pluginId} 使用 ra 自带的内置包；如需换成其它 npm 包，先添加 ${entryPath(kind, pluginId)} 入口`
            : `配置里没有 ${kind} 插件 ${pluginId} 的入口；先添加 ${entryPath(kind, pluginId)} 再安装`,
        )
      }
      const configuredSpecifier = pluginSpecifier(configured)
      if (!configuredSpecifier) {
        throw new PluginInstallStartError('unknown-plugin', `${pluginId} 在配置里被禁用（enabled: false）`)
      }
      packageName = npmPackageNameOf(configuredSpecifier)
      if (!packageName) {
        throw new PluginInstallStartError(
          'not-a-package',
          `${pluginId} 配置的是本地路径 ${preview(configuredSpecifier, 120)}，不需要下载；重启服务后按路径加载`,
        )
      }
      specifier = configuredSpecifier
    }

    const key = `${kind}:${pluginId || specifier}`
    const activeJob = this.activeByPlugin.get(key)
    if (activeJob) throw new PluginInstallStartError('busy', `${pluginId} 正在安装（任务 ${activeJob}）`)

    const version = opts.version?.trim() || 'latest'
    const job: PluginInstallJob = {
      id: randomUUID(),
      kind,
      pluginId: pluginId || specifier,
      packageName: packageName ?? '',
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
        if (packageName) {
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
          if (!result.ok) {
            job.status = 'failed'
            job.phase = 'failed'
            job.error = result.error
            return
          }
          if (result.version) job.installedVersion = result.version
        }
        // 装好只是第一步：能真正导入并读出 meta.id，才知道它是什么运行时。
        const declaration = await readPluginDeclaration({ kind, home: this.opts.home, specifier })
        job.declaredId = declaration.id
        this.logger.info('plugin:id-detected', {
          kind,
          id: declaration.id,
          package: packageName ?? specifier,
        })
        job.status = 'ok'
        job.phase = 'succeeded'
      } catch (error) {
        const detail = errorMessage(error)
        job.status = 'failed'
        job.phase = 'failed'
        job.error = detail
        this.logger.error('plugin:install-failed', { kind, id: pluginId || specifier, package: packageName ?? specifier, detail })
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
