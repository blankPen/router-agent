/**
 * 按 npm 包名安装运行时 / 通道插件。
 *
 * 插件加载器以 `<RA_HOME>/config.yaml` 为锚点解析包名，所以插件必须装在
 * `<RA_HOME>/node_modules` 下；本模块负责把配置里声明的 npm 包下载到这里，
 * 并校验装完以后加载器确实能解析到它。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { errorMessage, noopLogger, type Logger } from './logger.js'
import { defaultPluginLoader } from './plugin-loader.js'

/** npm 执行器；测试里可以注入假的实现。 */
export type NpmRunner = (args: string[], opts: {
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  onLine: (line: string) => void
}) => Promise<number>

export interface PluginInstallOptions {
  home: string
  /** 纯 npm 包名，不能是本地路径。 */
  packageName: string
  /** 精确版本或 'latest'；缺省 latest。 */
  version?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  onLine?: (line: string) => void
  logger?: Logger
  /** 测试注入：执行 npm，返回退出码。 */
  runNpm?: NpmRunner
}

export interface PluginInstallResult {
  ok: boolean
  version?: string
  log: string[]
  error?: string
}

const PACKAGE_NAME_PATTERN = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i
const LOCK_STALE_MS = 10 * 60_000
const MAX_LOG_LINES = 200
const NPM_TIMEOUT_MS = 180_000

/**
 * 从插件入口里取出 npm 包名。
 *
 * 本地路径（`./x` / `/x` / `file:`）、URL 和带空格的写法都返回 undefined；
 * 调用方据此区分「需要安装」与「重启即可生效」。
 */
export function npmPackageNameOf(value: string): string | undefined {
  const text = value.trim()
  if (!text || text.startsWith('.') || text.startsWith('/') || text.startsWith('file:')) return undefined
  if (text.includes('\\') || /\s/.test(text)) return undefined
  return PACKAGE_NAME_PATTERN.test(text) ? text : undefined
}

/** 配置里的版本号：只做最基本的注入防护，具体合法版本交给 npm 校验。 */
function validVersion(version: string | undefined): string {
  const text = version?.trim() || 'latest'
  if (text.startsWith('-') || /\s/.test(text)) return 'latest'
  return text
}

/** npm 全局安装的同一套命令名：Windows 上是 npm.cmd。 */
export function npmBin(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function appendLog(log: string[], line: string, onLine?: (line: string) => void): void {
  const text = line.trimEnd()
  if (!text) return
  log.push(text)
  if (log.length > MAX_LOG_LINES) log.splice(0, log.length - MAX_LOG_LINES)
  onLine?.(text)
}

function defaultRunNpm(args: string[], opts: {
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  onLine: (line: string) => void
}): Promise<number> {
  return new Promise(resolvePromise => {
    let settled = false
    let timedOut = false
    const child = spawn(npmBin(), args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(code)
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (process.platform === 'win32') {
          child.kill('SIGKILL')
        } else if (child.pid) {
          process.kill(-child.pid, 'SIGKILL')
        }
      } catch {
        // 进程可能已经退出，忽略即可。
      }
      finish(124)
    }, opts.timeoutMs)
    const pipe = (stream: NodeJS.ReadableStream): void => {
      let buffer = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        buffer += chunk
        let index
        while ((index = buffer.indexOf('\n')) >= 0) {
          opts.onLine(buffer.slice(0, index))
          buffer = buffer.slice(index + 1)
        }
      })
      stream.on('end', () => {
        if (buffer) opts.onLine(buffer)
      })
    }
    pipe(child.stdout)
    pipe(child.stderr)
    child.on('error', error => {
      opts.onLine(`${error.message}${timedOut ? '（安装超时）' : ''}`)
      finish(127)
    })
    child.on('close', code => finish(code ?? (timedOut ? 124 : 1)))
  })
}

/** 安装锁目录按包名区分；同名包不允许并发写入同一个 node_modules。 */
function lockDirOf(home: string, packageName: string): string {
  return join(home, '.plugin-install', `${packageName.replace(/[^a-z0-9-_.]/gi, '_')}.lock`)
}

function lockIsStale(path: string): boolean {
  try {
    const info = JSON.parse(readFileSync(join(path, 'lock.json'), 'utf8')) as { startedAt?: string }
    const startedAt = info.startedAt ? Date.parse(info.startedAt) : statSync(path).mtimeMs
    return !Number.isFinite(startedAt) || Date.now() - startedAt > LOCK_STALE_MS
  } catch {
    // 锁目录存在但没有 lock.json：按目录的 mtime 判断是否陈旧。
    try {
      return Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS
    } catch {
      return true
    }
  }
}

function acquireLock(home: string, packageName: string): { path: string; error?: string } {
  mkdirSync(join(home, '.plugin-install'), { recursive: true })
  const path = lockDirOf(home, packageName)
  try {
    mkdirSync(path)
    return { path }
  } catch {
    if (lockIsStale(path)) {
      try {
        rmSync(path, { recursive: true, force: true })
        mkdirSync(path)
        return { path }
      } catch {
        // 抢锁失败，继续走「已有安装任务」分支。
      }
    }
    return { path, error: `已有 ${packageName} 安装任务在进行` }
  }
}

function releaseLock(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

/** 读已安装包的版本；没装或 package.json 损坏时返回 null。 */
export function installedPluginVersion(home: string, packageName: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(home, 'node_modules', packageName, 'package.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    // 目录不存在 / 只装了一半 / JSON 损坏都按未安装处理。
    return null
  }
}

/** 最近几行 npm 输出用于日志 detail：不写完整 stderr，避免日志过大。 */
function failureDetail(log: string[], code: number): string {
  const tail = log.filter(line => line.trim()).slice(-3).join(' | ')
  const text = code === 124 ? 'npm install 超时' : `npm install 退出码 ${code}`
  return tail ? `${text}：${tail.slice(0, 300)}` : text
}

/**
 * 把 npm 包安装到 `<RA_HOME>/node_modules`。
 *
 * 安装完成后会用插件加载器同一套解析逻辑确认包能被找到；解析不到的包
 * 即使用 npm 装上了，服务重启时也加载不了，所以这里按失败返回。
 */
export async function installPluginPackage(opts: PluginInstallOptions): Promise<PluginInstallResult> {
  const log: string[] = []
  const logger = opts.logger ?? noopLogger
  const packageName = npmPackageNameOf(opts.packageName)
  if (!packageName) {
    return { ok: false, log, error: `不是合法的 npm 包名：${opts.packageName}` }
  }
  const version = validVersion(opts.version)
  const lock = acquireLock(opts.home, packageName)
  if (lock.error) return { ok: false, log, error: lock.error }

  logger.info('plugin:install-started', { home: opts.home, package: packageName, version })
  try {
    mkdirSync(opts.home, { recursive: true })
    appendLog(log, `安装 ${packageName}@${version} → ${join(opts.home, 'node_modules')}`, opts.onLine)
    const run = opts.runNpm ?? defaultRunNpm
    const args = [
      'install',
      '--prefix', opts.home,
      '--no-save',
      '--no-package-lock',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      `${packageName}@${version}`,
    ]
    const code = await run(args, {
      cwd: opts.home,
      env: opts.env ?? {},
      timeoutMs: opts.timeoutMs ?? NPM_TIMEOUT_MS,
      onLine: line => appendLog(log, line, opts.onLine),
    })
    if (code !== 0) {
      const error = failureDetail(log, code)
      logger.error('plugin:install-failed', { home: opts.home, package: packageName, version, detail: error })
      return { ok: false, log, error }
    }

    const installedVersion = installedPluginVersion(opts.home, packageName)
    if (!installedVersion) {
      const error = `安装完成但 ${join(opts.home, 'node_modules', packageName)} 不存在`
      logger.error('plugin:install-failed', { home: opts.home, package: packageName, version, detail: error })
      return { ok: false, log, error }
    }

    // 与插件加载器完全相同的解析路径：解析不到就等于重启后加载失败。
    try {
      defaultPluginLoader().resolve(packageName, resolve(opts.home, 'config.yaml'))
    } catch (error) {
      const detail = `安装完成但加载器解析不到 ${packageName}：${errorMessage(error)}`.slice(0, 300)
      logger.error('plugin:install-failed', { home: opts.home, package: packageName, version, detail })
      return { ok: false, log: [...log, detail], error: detail }
    }

    appendLog(log, `安装完成：${packageName}@${installedVersion}`, opts.onLine)
    logger.info('plugin:install-succeeded', { home: opts.home, package: packageName, version: installedVersion })
    return { ok: true, version: installedVersion, log }
  } catch (error) {
    const detail = errorMessage(error)
    logger.error('plugin:install-failed', { home: opts.home, package: packageName, version, detail })
    return { ok: false, log, error: detail }
  } finally {
    releaseLock(lock.path)
  }
}
