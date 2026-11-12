/**
 * Herdr 服务端的可用性检查与拉起。
 *
 * Herdr 的所有命令都走本地 socket 服务端，服务端没起时每条命令都返回
 * `server_not_running`。这个模块负责在探测阶段把服务端拉起来，
 * 让「检测 → 可用」这条路自洽。
 */
import { spawn } from 'node:child_process'
import type { CommandRunner } from '@router-agent/infra/process.js'
import { serverStatus } from './commands.js'

export interface HerdrServerState {
  /** 服务端是否在跑。 */
  running: boolean
  /** 本次调用是否真的把它拉起来了。 */
  started: boolean
  /** 版本（探测到时）。 */
  version?: string
  /** 没起来时的原因。 */
  reason?: string
}

export interface EnsureHerdrServerOptions {
  /** 已绑定 herdr 的 runner。 */
  runner: CommandRunner
  /** 拉起后最多等多久（毫秒）。 */
  timeoutMs?: number
  /** 拉起服务端用的可执行文件名；默认 herdr。 */
  bin?: string
  /** 注入的拉起动作（测试用）。 */
  spawnFn?: HerdrServerSpawner
  /** 轮询间隔（毫秒）。 */
  pollMs?: number
}

/** 拉起服务端的动作：拿到 bin 与参数，把进程放到后台跑。 */
export type HerdrServerSpawner = (bin: string, args: string[]) => void

/**
 * 默认的拉起方式：detached + stdio 丢弃，让 `herdr server` 脱离当前 shell 一直活着。
 *
 * 用 nohup / & 之类的 shell 技巧不行 —— 父 shell 退出时它照样会被带走；
 * 必须自己 detach。
 */
const defaultSpawn: HerdrServerSpawner = (bin, args) => {
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

/** 探测服务端状态；不尝试拉起。 */
export async function probeHerdrServer(runner: CommandRunner): Promise<{ running: boolean; version?: string; reason?: string }> {
  const res = await runner.run(serverStatus())
  if (res.code !== 0) {
    return { running: false, reason: (res.stderr || res.stdout).trim().slice(0, 160) }
  }
  const running = /^status:\s*running\s*$/m.test(res.stdout)
  const version = res.stdout.match(/^version:\s*(.+)$/m)?.[1]?.trim()
  return {
    running,
    ...(version ? { version } : {}),
    ...(running ? {} : { reason: '未找到运行中的 Herdr 服务端' }),
  }
}

/**
 * 确保 Herdr 服务端在跑；没在跑就把它拉起来。
 *
 * `herdr server` 是前台进程，这里用 detached 方式启动（stdio 丢弃、脱离父进程），
 * 让它像 Herdr TUI 拉起的服务端那样一直活着。
 */
export async function ensureHerdrServer(opts: EnsureHerdrServerOptions): Promise<HerdrServerState> {
  const current = await probeHerdrServer(opts.runner)
  if (current.running) {
    return { running: true, started: false, ...(current.version ? { version: current.version } : {}) }
  }

  const spawnFn = opts.spawnFn ?? defaultSpawn
  try {
    spawnFn(opts.bin ?? 'herdr', ['server'])
  } catch (error) {
    return {
      running: false,
      started: false,
      reason: `启动 Herdr 服务端失败: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const timeoutMs = opts.timeoutMs ?? 10_000
  const pollMs = opts.pollMs ?? 400
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(pollMs)
    const next = await probeHerdrServer(opts.runner)
    if (next.running) {
      return { running: true, started: true, ...(next.version ? { version: next.version } : {}) }
    }
  }
  return {
    running: false,
    started: false,
    reason: `启动 Herdr 服务端超时（${timeoutMs}ms）；请手动运行 herdr server 看看报错`,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
