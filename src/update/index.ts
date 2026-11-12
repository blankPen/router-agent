/**
 * 版本更新：检查 npm 上的最新版、执行全局安装，并给 CLI / Web 面板提供统一状态。
 *
 * 只有「装了新版要重启服务」这一件事需要调用方负责：CLI 自己 stop + start，
 * 面板走 `/api/update` 后在响应结束时复用现有的重启流程。
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { sep } from 'node:path'
import { realRunner, type CommandRunner } from '#infra/process.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import { preview } from '#core/events.js'
import { isNewer } from './version.js'

export { compareVersions, isNewer, parseVersion } from './version.js'
export type { ParsedVersion } from './version.js'

// 版本号唯一来源是 package.json：src/update 与 dist/update 到包根的相对路径一致。
const pkg = createRequire(import.meta.url)('../../package.json') as { name: string; version: string }

export const PACKAGE_NAME: string = pkg.name
export const PACKAGE_VERSION: string = pkg.version
export const PACKAGE_ROOT: string = fileURLToPath(new URL('../..', import.meta.url))
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

export type UpdatePhase = 'idle' | 'checking' | 'upgrading' | 'updated' | 'failed'

export interface UpdateSnapshot {
  /** 当前进程实际运行的版本。 */
  current: string
  /** npm 上查到的最新版本；尚未检查或检查失败时为 null。 */
  latest: string | null
  /** 本次进程内刚安装好的版本，重启后 current 才会变成它。 */
  installedVersion: string | null
  hasUpdate: boolean
  checkedAt: string | null
  phase: UpdatePhase
  /** 机器可读的失败原因：check-failed / not-global-install / install-failed。 */
  error: string | null
  /** 给面板 / CLI 直接展示的一句话。 */
  message: string | null
}

export interface LatestVersionResult {
  version: string
  checkedAt: string
}

export interface UpgradeResult {
  ok: boolean
  command: string
  code: number
  stdout: string
  stderr: string
  /** 被信号终止时的信号名；超时被打死时是 SIGKILL。 */
  signal?: string | null
  /** 是否是超时被 kill，而不是 npm 自身报错退出。 */
  timedOut?: boolean
  /** 本次安装的超时上限；超时日志里要写清楚。 */
  timeoutMs?: number
}

export interface FetchLatestOptions {
  registry?: string
  packageName?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * 已装 npm 全局包时，包根一定在某个 `node_modules` 下；
 * 源码目录 / pnpm link 的 realpath 不会包含它。
 */
export function isGlobalNpmInstall(root: string = PACKAGE_ROOT): boolean {
  return root.split(sep).includes('node_modules')
}

/** 统一 registry：去掉尾部斜杠、补一个 `/`，允许 `--registry` 传任意镜像。 */
export function normalizeRegistry(registry?: string): string {
  const value = registry?.trim() || process.env.RA_NPM_REGISTRY || process.env.npm_config_registry || DEFAULT_REGISTRY
  return value.endsWith('/') ? value : `${value}/`
}

/** scoped 包名在 registry 路径里要把 `/` 编码成 `%2F`。 */
function registryPath(packageName: string): string {
  return encodeURIComponent(packageName).replace(/%40/g, '@')
}

/** 查 `<registry>/<package>/latest`；npm registry 的 latest dist-tag 就是该接口。 */
export async function fetchLatestVersion(options: FetchLatestOptions = {}): Promise<LatestVersionResult> {
  const registry = normalizeRegistry(options.registry)
  const name = options.packageName ?? PACKAGE_NAME
  const fetchImpl = options.fetchImpl ?? fetch
  const url = `${registry}${registryPath(name)}/latest`
  const res = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
  })
  if (!res.ok) throw new Error(`registry 返回 HTTP ${res.status}`)
  const data = (await res.json()) as { version?: unknown }
  if (typeof data.version !== 'string' || !data.version.trim()) throw new Error('registry 响应缺少 version 字段')
  return { version: data.version.trim(), checkedAt: new Date().toISOString() }
}

/** Windows 上 npm 是 `npm.cmd`，直接 spawn `npm` 会 ENOENT。 */
export function npmBin(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

export interface UpgradeOptions {
  /** 目标版本；缺省安装 `@latest`。 */
  version?: string | null
  runner?: CommandRunner
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  packageName?: string
}

/** npm 全局安装默认超时；装依赖多的包 180s 不够用。 */
export const DEFAULT_UPGRADE_TIMEOUT_MS = 300_000

/** 执行 `npm install -g <pkg>@latest`；失败也返回结果，由调用方决定如何提示。 */
export async function runNpmUpgrade(options: UpgradeOptions = {}): Promise<UpgradeResult> {
  const name = options.packageName ?? PACKAGE_NAME
  const target = options.version ? `${name}@${options.version}` : `${name}@latest`
  const argv = ['install', '-g', target, '--no-fund', '--no-audit', '--loglevel=error']
  const runner = options.runner ?? realRunner(npmBin())
  const result = await runner.run(argv, {
    env: options.env,
    timeoutMs: options.timeoutMs ?? DEFAULT_UPGRADE_TIMEOUT_MS,
  })
  return {
    ok: result.code === 0,
    command: `${npmBin()} ${argv.join(' ')}`,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    signal: result.signal ?? null,
    timedOut: result.timedOut === true,
    timeoutMs: options.timeoutMs ?? DEFAULT_UPGRADE_TIMEOUT_MS,
  }
}

export interface UpdateServiceOptions {
  current?: string
  registry?: string
  logger?: Logger
  /** 测试注入点：毫秒时间戳。 */
  now?: () => number
  /** 检查成功后的缓存时长（默认 6 小时）。 */
  cacheMs?: number
  /** 检查失败后的重试间隔（默认 30 分钟），避免网络异常时反复打 registry。 */
  failureRetryMs?: number
  fetchLatest?: (options: { registry?: string }) => Promise<LatestVersionResult>
  runUpgrade?: (options: { version: string }) => Promise<UpgradeResult>
  /** 是否从 npm 全局安装运行；缺省按包根路径判断。 */
  isGlobalInstall?: () => boolean
}

const SIX_HOURS = 6 * 60 * 60 * 1_000
const THIRTY_MINUTES = 30 * 60 * 1_000

/**
 * 版本检查与升级的进程内状态机。
 *
 * 面板 GET 只读缓存，不会每次打开都打 registry；服务启动时检查一次，
 * 之后每 6 小时刷新。升级过程中重复点击直接返回当前状态，不会并发装两遍。
 */
export class UpdateService {
  private state: UpdateSnapshot
  private readonly registry?: string
  private readonly logger: Logger
  private readonly now: () => number
  private readonly cacheMs: number
  private readonly failureRetryMs: number
  private readonly fetchLatest: (options: { registry?: string }) => Promise<LatestVersionResult>
  private readonly runUpgrade: (options: { version: string }) => Promise<UpgradeResult>
  private readonly isGlobalInstall: () => boolean
  private lastCheckedMs: number | null = null
  private checking: Promise<UpdateSnapshot> | null = null
  private upgrading = false

  constructor(options: UpdateServiceOptions = {}) {
    const current = options.current ?? PACKAGE_VERSION
    this.registry = options.registry
    this.logger = options.logger ?? noopLogger
    this.now = options.now ?? Date.now
    this.cacheMs = options.cacheMs ?? SIX_HOURS
    this.failureRetryMs = options.failureRetryMs ?? THIRTY_MINUTES
    this.fetchLatest = options.fetchLatest ?? (opts => fetchLatestVersion(opts))
    this.runUpgrade = options.runUpgrade ?? (opts => runNpmUpgrade({ version: opts.version }))
    this.isGlobalInstall = options.isGlobalInstall ?? (() => isGlobalNpmInstall())
    this.state = {
      current,
      latest: null,
      installedVersion: null,
      hasUpdate: false,
      checkedAt: null,
      phase: 'idle',
      error: null,
      message: null,
    }
  }

  /** 面板 / CLI 只读当前快照；返回副本，避免调用方改坏内部状态。 */
  snapshot(): UpdateSnapshot {
    return { ...this.state }
  }

  /** 检查最新版本；`force` 跳过缓存，供「立即检查」与启动首查使用。 */
  async check(force = false): Promise<UpdateSnapshot> {
    if (this.checking) return this.checking
    if (!force && this.lastCheckedMs !== null) {
      const ttl = this.state.error ? this.failureRetryMs : this.cacheMs
      if (this.now() - this.lastCheckedMs < ttl) return this.snapshot()
    }
    this.checking = this.doCheck()
    try {
      return await this.checking
    } finally {
      this.checking = null
    }
  }

  private async doCheck(): Promise<UpdateSnapshot> {
    this.state = { ...this.state, phase: 'checking', error: null }
    try {
      const result = await this.fetchLatest({ registry: this.registry })
      this.lastCheckedMs = this.now()
      const hasUpdate = isNewer(result.version, this.state.current)
      this.state = {
        ...this.state,
        latest: result.version,
        hasUpdate,
        checkedAt: result.checkedAt,
        phase: 'idle',
        error: null,
        message: hasUpdate ? `发现新版本 v${result.version}` : null,
      }
      this.logger.info('update:checked', {
        current: this.state.current,
        latest: result.version,
        hasUpdate,
      })
      return this.snapshot()
    } catch (error) {
      const message = errorMessage(error)
      this.lastCheckedMs = this.now()
      this.state = {
        ...this.state,
        phase: 'idle',
        error: 'check-failed',
        message: `检查更新失败：${preview(message, 200)}`,
      }
      this.logger.warn('update:check-failed', { message: preview(message, 240), registry: normalizeRegistry(this.registry) })
      return this.snapshot()
    }
  }

  /**
   * 安装最新版。成功时 `phase = updated`、`hasUpdate = false`，
   * 重启由调用方负责（CLI 直接重启，面板在响应结束后复用 /api/restart 的流程）。
   */
  async upgrade(options: { force?: boolean } = {}): Promise<UpdateSnapshot> {
    if (this.upgrading) return this.snapshot()
    if (!this.state.latest || !this.state.checkedAt) {
      await this.check(true)
      // 检查失败时 latest 仍为 null：保留 check-failed，不继续安装。
      if (!this.state.latest) return this.snapshot()
    }
    const target = this.state.latest!
    const from = this.state.current
    if (!isNewer(target, from)) {
      this.state = { ...this.state, phase: 'idle', error: null, message: `已是最新版本 v${from}` }
      return this.snapshot()
    }
    if (!options.force && !this.isGlobalInstall()) {
      const message = `当前从源码目录运行（${PACKAGE_ROOT}），npm 全局安装不会替换它；请更新源码后重新 pnpm build，确实要装全局版请加 --force。`
      this.state = { ...this.state, phase: 'failed', error: 'not-global-install', message }
      this.logger.warn('update:skipped', { reason: 'not-global-install', root: PACKAGE_ROOT })
      return this.snapshot()
    }

    this.upgrading = true
    this.state = { ...this.state, phase: 'upgrading', error: null, message: `正在安装 v${target}…` }
    this.logger.info('update:upgrade-started', { from, to: target, root: PACKAGE_ROOT })
    const startedAt = this.now()
    try {
      const result = await this.runUpgrade({ version: target })
      if (!result.ok) {
        // 超时被 kill 时 npm 什么都没输出，必须单独标出来，否则日志里只剩「退出码 1」。
        const timedOut = result.timedOut === true
        const seconds = result.timeoutMs ? Math.round(result.timeoutMs / 1000) : 0
        const detail = timedOut
          ? `安装超时：${seconds ? `${seconds}s ` : ''}被 ${result.signal ?? 'SIGKILL'} 中断（npm 未输出错误）`
          : preview(result.stderr || result.stdout || `npm 退出码 ${result.code}`, 240)
        this.state = {
          ...this.state,
          phase: 'failed',
          error: timedOut ? 'install-timeout' : 'install-failed',
          message: timedOut
            ? `${detail}。当前版本仍是 v${from}；若安装中途被覆盖，npm 全局目录可能处于半更新状态，请检查 ${PACKAGE_ROOT}。`
            : `安装失败：${detail}`,
        }
        this.logger.error('update:upgrade-failed', {
          from,
          to: target,
          code: result.code,
          timedOut,
          signal: result.signal ?? null,
          timeoutMs: result.timeoutMs ?? null,
          durationMs: this.now() - startedAt,
          root: PACKAGE_ROOT,
          message: preview(detail, 240),
        })
        return this.snapshot()
      }
      this.state = {
        ...this.state,
        phase: 'updated',
        installedVersion: target,
        hasUpdate: false,
        error: null,
        message: `已更新到 v${target}，重启后生效`,
      }
      this.logger.info('update:upgraded', { from, to: target, durationMs: this.now() - startedAt })
      return this.snapshot()
    } finally {
      this.upgrading = false
    }
  }
}
