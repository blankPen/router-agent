import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acpAgentOf, type AcpAgentMeta } from './agents.js'
import { acpRuntimesRoot, managedAgentDir } from './detect.js'

export interface InstallOptions {
  home: string
  /** agent id 或 runtime id；只有静态目录里的值才允许安装。 */
  agentId: string
  /** 精确版本；缺省用目录里 pinned 的版本。'latest' 表示最新版。 */
  version?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  onLine?: (line: string) => void
  /** 测试注入：执行 npm，返回退出码。 */
  runNpm?: (args: string[], opts: {
    cwd: string
    env: NodeJS.ProcessEnv
    timeoutMs: number
    onLine: (line: string) => void
  }) => Promise<number>
}

export interface InstallResult {
  ok: boolean
  version?: string
  log: string[]
  error?: string
}

const LOCK_STALE_MS = 10 * 60_000
const MAX_LOG_LINES = 200

/** 安装状态目录：~/.router-agent/runtimes/.locks / .staging / .backup */
function stateDir(home: string, name: '.locks' | '.staging' | '.backup'): string {
  return join(acpRuntimesRoot(home), name)
}

function packageVersion(agent: AcpAgentMeta, requested?: string): string | undefined {
  if (!agent.package) return undefined
  if (!requested || requested === agent.package.version) return agent.package.version
  if (requested === 'latest') return 'latest'
  return undefined
}

function appendLog(log: string[], line: string, onLine?: (line: string) => void): void {
  const text = line.trimEnd()
  if (!text) return
  log.push(text)
  if (log.length > MAX_LOG_LINES) log.splice(0, log.length - MAX_LOG_LINES)
  onLine?.(text)
}

function readLock(path: string): { pid?: number; startedAt?: string } | null {
  try {
    return JSON.parse(readFileSync(join(path, 'lock.json'), 'utf8')) as { pid?: number; startedAt?: string }
  } catch {
    return null
  }
}

function lockIsStale(path: string): boolean {
  try {
    const info = readLock(path)
    const startedAt = info?.startedAt ? Date.parse(info.startedAt) : statSync(path).mtimeMs
    return !Number.isFinite(startedAt) || Date.now() - startedAt > LOCK_STALE_MS
  } catch {
    return true
  }
}

function acquireLock(home: string, agentId: string): { path: string; error?: string } {
  const root = stateDir(home, '.locks')
  mkdirSync(root, { recursive: true })
  const path = join(root, agentId)
  try {
    mkdirSync(path)
    writeFileSync(join(path, 'lock.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8')
    return { path }
  } catch {
    if (lockIsStale(path)) {
      try {
        rmSync(path, { recursive: true, force: true })
        mkdirSync(path)
        writeFileSync(join(path, 'lock.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8')
        return { path }
      } catch {
        // 继续走失败分支。
      }
    }
    return { path, error: `已有 ${agentId} 安装任务在进行` }
  }
}

function releaseLock(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

function defaultRunNpm(args: string[], opts: {
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  onLine: (line: string) => void
}): Promise<number> {
  return new Promise(resolve => {
    let settled = false
    let timedOut = false
    const child = spawn('npm', args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(code)
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
        // 进程可能已经退出。
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

function readInstalledVersion(target: string, agent: AcpAgentMeta): string | undefined {
  if (!agent.package) return undefined
  try {
    const pkg = JSON.parse(readFileSync(join(target, 'node_modules', agent.package.name, 'package.json'), 'utf8')) as { version?: string }
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

function binPath(target: string, agent: AcpAgentMeta): string {
  const names = process.platform === 'win32'
    ? [`${agent.command}.cmd`, `${agent.command}.exe`, agent.command]
    : [agent.command]
  return names.map(name => join(target, 'node_modules', '.bin', name)).find(existsSync) ?? join(target, 'node_modules', '.bin', names[0]!)
}

/** 按需安装一个 ACP 适配器。只接受静态目录里的 agent / 版本。 */
export async function installAcpAgent(opts: InstallOptions): Promise<InstallResult> {
  const log: string[] = []
  const agent = acpAgentOf(opts.agentId)
  if (!agent) return { ok: false, log, error: `未知 ACP Agent: ${opts.agentId}` }
  if (!agent.package) {
    return { ok: false, log, error: `${agent.label} 不支持由 ra 在线安装${agent.installHint ? `：${agent.installHint}` : ''}` }
  }
  const version = packageVersion(agent, opts.version)
  if (!version) {
    return { ok: false, log, error: `不支持的版本 ${opts.version}；${agent.runtimeId} 只提供 ${agent.package.version}` }
  }

  const lock = acquireLock(opts.home, agent.id)
  if (lock.error) return { ok: false, log, error: lock.error }

  const stagingRoot = stateDir(opts.home, '.staging')
  const backupRoot = stateDir(opts.home, '.backup')
  const stamp = `${Date.now()}-${process.pid}`
  const staging = join(stagingRoot, `${agent.id}-${stamp}`)
  const target = managedAgentDir(opts.home, agent.id)
  const backup = join(backupRoot, `${agent.id}-${stamp}`)
  let installed = false

  try {
    mkdirSync(staging, { recursive: true })
    mkdirSync(backupRoot, { recursive: true })
    appendLog(log, `安装 ${agent.package.name}@${version} → ${target}`, opts.onLine)

    const run = opts.runNpm ?? defaultRunNpm
    const args = [
      'install',
      '--prefix', staging,
      '--no-save',
      '--no-package-lock',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      `${agent.package.name}@${version}`,
    ]
    const code = await run(args, {
      cwd: staging,
      env: opts.env ?? {},
      timeoutMs: opts.timeoutMs ?? 180_000,
      onLine: line => appendLog(log, line, opts.onLine),
    })
    if (code !== 0) {
      return { ok: false, log, error: code === 124 ? 'npm install 超时' : `npm install 退出码 ${code}` }
    }

    const bin = binPath(staging, agent)
    if (!existsSync(bin)) {
      return { ok: false, log, error: `安装完成但找不到可执行文件 ${bin}` }
    }

    // 两阶段换名：旧目录先挪到 backup，再把 staging 换到目标；失败则恢复。
    const hadTarget = existsSync(target)
    if (hadTarget) renameSync(target, backup)
    try {
      renameSync(staging, target)
    } catch (error) {
      if (hadTarget && existsSync(backup)) renameSync(backup, target)
      throw error
    }
    installed = true
    const installedVersion = readInstalledVersion(target, agent) ?? version
    writeFileSync(join(target, 'ra-runtime.json'), JSON.stringify({
      agentId: agent.id,
      runtimeId: agent.runtimeId,
      package: agent.package.name,
      version: installedVersion,
      installedAt: new Date().toISOString(),
    }, null, 2), 'utf8')
    rmSync(backup, { recursive: true, force: true })
    appendLog(log, `安装完成：${agent.package.name}@${installedVersion}`, opts.onLine)
    return { ok: true, version: installedVersion, log }
  } catch (error) {
    return { ok: false, log, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (!installed) rmSync(staging, { recursive: true, force: true })
    releaseLock(lock.path)
  }
}

/** 卸载 ra 托管的 Agent；只删 ~/.router-agent/runtimes/<agentId>。 */
export async function uninstallAcpAgent(opts: { home: string; agentId: string }): Promise<InstallResult> {
  const agent = acpAgentOf(opts.agentId)
  if (!agent) return { ok: false, log: [], error: `未知 ACP Agent: ${opts.agentId}` }
  const target = managedAgentDir(opts.home, agent.id)
  if (!existsSync(target)) return { ok: true, log: [`${agent.label} 没有 managed 安装`] }
  rmSync(target, { recursive: true, force: true })
  return { ok: true, log: [`已删除 ${target}`] }
}

/** 清理上次中断留下的 staging 目录；启动时调用。 */
export function cleanupInstallState(home: string): void {
  const staging = stateDir(home, '.staging')
  try {
    for (const name of readdirSync(staging)) {
      const path = join(staging, name)
      try {
        if (Date.now() - statSync(path).mtimeMs > 24 * 60 * 60_000) rmSync(path, { recursive: true, force: true })
      } catch {
        // 忽略单项失败。
      }
    }
  } catch {
    // 目录不存在。
  }
}