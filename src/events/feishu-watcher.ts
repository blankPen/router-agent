/**
 * 飞书事件 watcher（realtime 形态）：用长连接消费飞书事件。
 *
 * **为什么是长连接而不是轮询**：飞书官方支持服务端推送（长连接），
 * 事件到达即推；轮询既慢又会被限流。
 * （GitHub 没有这个能力，保留轮询 —— 见 `src/events/sources/github.ts`。）
 *
 * **进程模型**：一个 EventKey 一个 `lark-cli event consume` 子进程。
 * 多个任务订阅同一个 EventKey 时共享同一个进程，事件扇出给它们。
 *
 * **退出必须优雅**：`kill -9` 会跳过服务端退订、泄漏订阅（重启时报
 * "subscription already exists"、事件重复投递）。停止时关 stdin 或发 SIGTERM。
 *
 * **不 import `packages/channel-feishu`**：事件链路与 Channel 完全独立（决策 A8）。
 * 长连接逻辑在这里自己实现一份。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import type { EventEnvelope } from '#event/port.js'
import { FEISHU_EVENT_TYPES, findFeishuEventType } from './catalogs/feishu.js'
import { normalizeFeishuEvent } from './feishu-projections.js'
import type { ResolvedSubscription } from './subscriptions.js'
import type { EventSink, EventWatcher } from './watcher.js'

/** 重连退避：5s 起，翻倍到 60s 封顶。 */
const RESTART_BASE_MS = 5_000
const RESTART_MAX_MS = 60_000

/** 一个 EventKey 的长连接。 */
interface Connection {
  eventKey: string
  /** 订阅了这个 EventKey 的所有订阅。 */
  subscriptions: Map<string, ResolvedSubscription>
  proc: ChildProcess | null
  stopping: boolean
  restarts: number
  restartTimer: NodeJS.Timeout | null
}

export interface FeishuEventWatcherDeps {
  logger?: Logger
  /** 当前时间；宿主注入后时间戳可复现。 */
  clock?: () => string
  /** lark-cli 可执行文件。 */
  bin?: string
  /** 事件侧独立的 lark-cli 配置目录（HOME 隔离，与 Channel 侧分开）。 */
  home?: string
  /** 预检：判断某 EventKey 能不能订阅。 */
  precheck?: (eventKey: string) => Promise<{ ready: boolean; reason: string }>
  /** 测试注入点：替换 spawn。 */
  spawnImpl?: (bin: string, args: string[], opts: { stdio: ['pipe', 'pipe', 'pipe']; env?: NodeJS.ProcessEnv }) => ChildProcess
}

/** 飞书事件 watcher：管所有 EventKey 的长连接。 */
export class FeishuEventWatcher implements EventWatcher {
  readonly catalogId = 'feishu'
  readonly mode = 'realtime' as const
  private logger: Logger
  private clock: () => string
  private bin: string
  private home: string
  private precheck?: FeishuEventWatcherDeps['precheck']
  private spawnImpl: NonNullable<FeishuEventWatcherDeps['spawnImpl']>
  /** EventKey → 长连接。 */
  private connections = new Map<string, Connection>()
  /** 事件落点；订阅变化时更新。 */
  private sink?: EventSink
  private stopping = false

  constructor(deps: FeishuEventWatcherDeps = {}) {
    this.logger = deps.logger ?? noopLogger
    this.clock = deps.clock ?? (() => new Date().toISOString())
    this.bin = deps.bin ?? 'lark-cli'
    this.home = deps.home ?? ''
    this.precheck = deps.precheck
    this.spawnImpl = deps.spawnImpl ?? spawn
  }

  /**
   * 订阅一条订阅。
   *
   * 同一个 EventKey 的多条订阅共享一个进程；EventKey 变了才起新进程。
   */
  async subscribe(subscription: ResolvedSubscription, sink: EventSink): Promise<void> {
    this.sink = sink
    for (const typeId of subscription.types) {
      const type = findFeishuEventType(typeId)
      if (!type) {
        this.logger.warn('event:feishu-unknown-type', { taskId: subscription.id, eventType: typeId })
        continue
      }
      const existing = this.connections.get(type.eventKey)
      if (existing) {
        existing.subscriptions.set(subscription.id, subscription)
        continue
      }
      const connection: Connection = {
        eventKey: type.eventKey,
        subscriptions: new Map([[subscription.id, subscription]]),
        proc: null,
        stopping: false,
        restarts: 0,
        restartTimer: null,
      }
      this.connections.set(type.eventKey, connection)
      const blocked = await this.checkBlocked(type.eventKey)
      if (blocked) continue
      this.startConnection(connection)
    }
  }

  /** 停止所有长连接。 */
  stop(): void {
    this.stopping = true
    for (const connection of this.connections.values()) this.stopConnection(connection)
    this.connections.clear()
    this.logger.info('event:feishu-stopped', {})
  }

  /** 当前建立了多少条长连接（面板徽标）。 */
  connectionCount(): number {
    return [...this.connections.values()].filter(connection => connection.proc !== null).length
  }

  /** 预检：事件类型没在后台订阅 / 缺权限时不起进程，记 warn。 */
  private async checkBlocked(eventKey: string): Promise<boolean> {
    if (!this.precheck) return false
    let result: { ready: boolean; reason: string }
    try {
      result = await this.precheck(eventKey)
    } catch (error) {
      this.logger.warn('event:feishu-precheck-failed', { eventKey, message: errorMessage(error) })
      return false
    }
    if (result.ready) return false
    this.logger.warn('event:feishu-subscribe-blocked', { eventKey, reason: result.reason })
    return true
  }

  /** 起一个长连接子进程。 */
  private startConnection(connection: Connection): void {
    if (connection.proc) return
    connection.stopping = false
    const args = ['event', 'consume', connection.eventKey, '--as', 'bot']
    const env = this.home ? { ...process.env, HOME: this.home } : process.env
    let child: ChildProcess
    try {
      child = this.spawnImpl(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env })
    } catch (error) {
      this.logger.error('event:feishu-spawn-failed', { eventKey: connection.eventKey, message: errorMessage(error) })
      this.scheduleRestart(connection)
      return
    }
    connection.proc = child
    this.logger.info('event:feishu-starting', { eventKey: connection.eventKey, pid: child.pid })
    // 关键：lark-cli 把 stdin EOF 当退出信号，stdin 必须是保持打开的管道。
    child.stdin?.on('error', () => { /* 关闭时的 EPIPE 忽略 */ })
    const rl = createInterface({ input: child.stdout! })
    rl.on('line', line => {
      const trimmed = line.trim()
      if (!trimmed) return
      this.handleLine(connection, trimmed)
    })
    child.stderr?.on('data', chunk => {
      const text = String(chunk).trim()
      if (!text) return
      this.handleStderr(connection, text)
    })
    child.on('error', error => {
      if (connection.proc === child) connection.proc = null
      this.logger.error('event:feishu-spawn-failed', { eventKey: connection.eventKey, message: errorMessage(error) })
      this.scheduleRestart(connection)
    })
    child.on('exit', code => {
      if (connection.proc === child) connection.proc = null
      if (connection.stopping || this.stopping) return
      if (code !== 0) {
        this.logger.warn('event:feishu-exit', { eventKey: connection.eventKey, code })
      }
      this.scheduleRestart(connection)
    })
  }

  /** 处理 stdout 的一行 NDJSON。 */
  private handleLine(connection: Connection, line: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch (error) {
      this.logger.warn('event:feishu-parse-failed', {
        eventKey: connection.eventKey,
        sample: line.slice(0, 200),
        message: errorMessage(error),
      })
      return
    }
    let envelope: EventEnvelope
    try {
      envelope = normalizeFeishuEvent(connection.eventKey, raw)
    } catch (error) {
      this.logger.warn('event:feishu-parse-failed', {
        eventKey: connection.eventKey,
        sample: line.slice(0, 200),
        message: errorMessage(error),
      })
      return
    }
    this.logger.info('event:feishu-received', {
      eventKey: connection.eventKey,
      eventType: envelope.eventType,
      externalId: envelope.externalId,
    })
    // 扇出给订阅了这个 EventKey 的所有订阅。
    for (const subscription of connection.subscriptions.values()) {
      void this.sink?.(subscription, envelope)
    }
  }

  /** 处理 stderr：区分「就绪」与「真错误」。 */
  private handleStderr(connection: Connection, text: string): void {
    const level = larkStderrLevel(text)
    if (level === 'ready') {
      connection.restarts = 0
      this.logger.info('event:feishu-ready', {
        eventKey: connection.eventKey,
        pid: connection.proc?.pid ?? 0,
      })
      return
    }
    if (level === 'error') {
      this.logger.warn('event:feishu-consume-warn', {
        eventKey: connection.eventKey,
        detail: text.slice(0, 300),
      })
    }
  }

  /** 断开后按指数退避重连。 */
  private scheduleRestart(connection: Connection): void {
    if (connection.stopping || this.stopping || connection.restartTimer) return
    connection.restarts += 1
    const delay = Math.min(RESTART_BASE_MS * 2 ** (connection.restarts - 1), RESTART_MAX_MS)
    this.logger.warn('event:feishu-reconnect', {
      eventKey: connection.eventKey,
      attempt: connection.restarts,
      delayMs: delay,
    })
    connection.restartTimer = setTimeout(() => {
      connection.restartTimer = null
      if (!connection.stopping && !this.stopping) this.startConnection(connection)
    }, delay)
    connection.restartTimer.unref?.()
  }

  /** 优雅退出：先关 stdin（lark-cli 的退出信号），超时才升级成 SIGTERM。 */
  private stopConnection(connection: Connection): void {
    connection.stopping = true
    if (connection.restartTimer) {
      clearTimeout(connection.restartTimer)
      connection.restartTimer = null
    }
    const child = connection.proc
    if (!child) return
    try {
      child.stdin?.end()
    } catch (error) {
      this.logger.warn('event:feishu-stop-failed', { eventKey: connection.eventKey, message: errorMessage(error) })
    }
    // 关 stdin 后给 lark-cli 一小段时间自行退订；超时才升级成 SIGTERM。
    // 绝不用 kill -9：强杀会跳过服务端退订，泄漏订阅。
    const timer = setTimeout(() => {
      if (connection.proc === child) {
        try {
          child.kill('SIGTERM')
        } catch (error) {
          this.logger.warn('event:feishu-stop-failed', { eventKey: connection.eventKey, message: errorMessage(error) })
        }
      }
    }, 2_000)
    timer.unref?.()
  }
}

/**
 * lark-cli 把例行信息写在 stderr 上，需要区分「就绪」与「真错误」。
 *
 * 与 Channel 侧同一套判定（各自实现，不共用模块 —— 决策 A8）。
 */
export function larkStderrLevel(line: string): 'ready' | 'error' | 'ignore' {
  if (/ready event_key|listening for events/i.test(line)) return 'ready'
  if (/\b(error|failed|denied|unauthorized|invalid|refused)\b/i.test(line)) return 'error'
  // lark-cli 的错误常以多行 JSON 输出，按结构化字段再判一次。
  if (/"ok"\s*:\s*false|failed_precondition|another event bus|already connected/i.test(line)) return 'error'
  return 'ignore'
}

/**
 * 解析 `lark-cli event consume <key> --dry-run` 的前置条件。
 *
 * 返回 ready=false 时，调用方不该起进程 —— 记 warn 并在面板上标「尚未开通」。
 */
export function parseEventPrecheck(stdout: string): { ready: boolean; reason: string; hint?: string } {
  try {
    const doc = JSON.parse(stdout) as Record<string, unknown>
    const data = (doc.data ?? {}) as Record<string, unknown>
    const decision = (data.decision ?? {}) as Record<string, unknown>
    const preconditions = Array.isArray(decision.preconditions)
      ? (decision.preconditions as Array<{ name?: string; status?: string; hint?: string }>)
      : []
    const failed = preconditions.filter(item => item.status && item.status !== 'ok')
    const ready = decision.status === 'ready' && failed.length === 0
    const hint = preconditions
      .map(item => item.hint)
      .find(value => typeof value === 'string' && value.trim())
    return {
      ready,
      reason: failed.length > 0
        ? `未通过：${failed.map(item => item.name ?? '?').join(', ')}`
        : `status=${String(decision.status ?? 'unknown')}`,
      ...(hint ? { hint } : {}),
    }
  } catch {
    return { ready: false, reason: '预检输出无法解析' }
  }
}

/** 目录里的全部 EventKey；预检与面板用。 */
export const FEISHU_EVENT_KEYS: readonly string[] = FEISHU_EVENT_TYPES.map(type => type.eventKey)
