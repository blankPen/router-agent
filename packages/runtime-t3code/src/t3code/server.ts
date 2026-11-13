/**
 * T3 Code 服务端的可用性检查与拉起。
 *
 * `t3 thread` 的每条命令都要先找到本机在跑的 server（CLI 从数据目录里的运行态文件读 origin），
 * 服务端没起时统一报 "No running T3 Code server"。这里负责在探测阶段把它拉起来，
 * 让「检测 → 可用」这条路自洽。
 */
import { spawn } from 'node:child_process'
import type { CommandRunner } from '@router-agent/infra/process.js'
import {
  failureText,
  isServerDown,
  PROBE_THREAD_ID,
  serve,
  threadShow,
  type T3Flags,
} from './commands.js'

export interface T3ServerState {
  /** 服务端是否在跑。 */
  running: boolean
  /** 本次调用是否真的把它拉起来了。 */
  started: boolean
  /** 没起来时的原因。 */
  reason?: string
}

/** 拉起服务端的动作：拿到 bin 与参数，把进程放到后台跑。 */
export type T3ServerSpawner = (bin: string, args: string[]) => void

export interface EnsureT3ServerOptions {
  /** 已绑定 t3 的 runner。 */
  runner: CommandRunner
  /** t3 可执行文件；默认 t3。 */
  bin?: string
  /** 拉起服务端用的端口；不传则用 T3 自己的默认端口。 */
  port?: number
  flags?: T3Flags
  /** 拉起后最多等多久（毫秒）。 */
  timeoutMs?: number
  /** 轮询间隔（毫秒）。 */
  pollMs?: number
  /** 注入的拉起动作（测试用）。 */
  spawnFn?: T3ServerSpawner
}

/**
 * 默认的拉起方式：detached + stdio 丢弃，让 `t3 serve` 脱离当前 shell 一直活着。
 *
 * 用 nohup / & 之类的 shell 技巧不行 —— 父 shell 退出时它照样会被带走；必须自己 detach。
 */
const defaultSpawn: T3ServerSpawner = (bin, args) => {
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

/**
 * 探测服务端是否在跑；不尝试拉起。
 *
 * 用一条不依赖项目的线程查询当探针：服务端答话就说明在跑（线程不存在也是它答的），
 * 只有「找不到服务端」才是没起。
 */
export async function probeT3Server(runner: CommandRunner, flags: T3Flags = {}): Promise<T3ServerState> {
  const res = await runner.run(threadShow({ thread: PROBE_THREAD_ID, ...flags }))
  if (res.code === 0) return { running: true, started: false }
  const text = failureText(res.stdout, res.stderr)
  if (res.code === 127) {
    return { running: false, started: false, reason: 't3 命令不可用，请确认 T3 Code 已安装' }
  }
  if (isServerDown(text)) {
    return { running: false, started: false, reason: text }
  }
  // 服务端答了「线程不存在」之类的业务错误，说明它活着。
  return { running: true, started: false }
}

/**
 * 确保 T3 Code 服务端在跑；没在跑就把它拉起来。
 *
 * `t3 serve` 是前台进程，这里用 detached 方式启动（stdio 丢弃、脱离父进程）。
 */
export async function ensureT3Server(opts: EnsureT3ServerOptions): Promise<T3ServerState> {
  const current = await probeT3Server(opts.runner, opts.flags)
  if (current.running) return current

  const spawnFn = opts.spawnFn ?? defaultSpawn
  const bin = opts.bin ?? 't3'
  try {
    spawnFn(bin, serve({ ...opts.flags, ...(opts.port ? { port: opts.port } : {}) }))
  } catch (error) {
    return {
      running: false,
      started: false,
      reason: `启动 T3 Code 服务端失败: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const timeoutMs = opts.timeoutMs ?? 20_000
  const pollMs = opts.pollMs ?? 500
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(pollMs)
    const next = await probeT3Server(opts.runner, opts.flags)
    if (next.running) return { running: true, started: true }
  }
  return {
    running: false,
    started: false,
    reason: `启动 T3 Code 服务端超时（${timeoutMs}ms）；请手动运行 t3 serve 看看报错`,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
