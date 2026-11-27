/**
 * 事件 watcher：宿主侧「怎么把订阅变成事件」的实现。
 *
 * 两种形态：
 * - poll：宿主按固定间隔调用 `poll()`，来源自己管游标（GitHub）；
 * - realtime：来源自己维持长连接，把事件推给宿主注册的回调（飞书）。
 *
 * watcher 不在 `packages/event` 里 —— 拉取是宿主的职责，
 * 插件只提供目录（见 `packages/event/src/port.ts`）。
 */
import type { EventEnvelope } from '#event/port.js'
import type { ResolvedSubscription } from './subscriptions.js'

/** realtime 形态的事件落点：watcher 把事件推给宿主。 */
export type EventSink = (subscription: ResolvedSubscription, envelope: EventEnvelope) => void | Promise<void>

/** 一个来源的 watcher。 */
export interface EventWatcher {
  /** 覆盖的来源目录 id。 */
  readonly catalogId: string
  /** 拉取形态。 */
  readonly mode: 'poll' | 'realtime'
  /** poll 形态：拉一批新事件；没有新事件返回空数组。 */
  poll?(subscription: ResolvedSubscription): Promise<EventEnvelope[]>
  /** realtime 形态：订阅变化时启停长连接。 */
  subscribe?(subscription: ResolvedSubscription, sink: EventSink): Promise<void>
  /** 停止所有长连接与定时器。 */
  stop?(): void
  /** 把结论回写到来源；没有回写能力的事件只落库。 */
  publish?(subscription: ResolvedSubscription, target: { externalId: string; url?: string }, text: string): Promise<void>
}

/**
 * poll 形态 watcher 的注册表：按来源 id 找 watcher。
 */
export class WatcherRegistry {
  private watchers = new Map<string, EventWatcher>()

  register(watcher: EventWatcher): void {
    this.watchers.set(watcher.catalogId, watcher)
  }

  get(catalogId: string): EventWatcher | undefined {
    return this.watchers.get(catalogId)
  }

  list(): EventWatcher[] {
    return [...this.watchers.values()]
  }

  /** 停掉全部 watcher；单个失败不影响其它。 */
  async stopAll(): Promise<void> {
    for (const watcher of this.watchers.values()) {
      try {
        await watcher.stop?.()
      } catch {
        // 停止失败没有补救动作：记录由调用方做，这里不吞掉整批。
      }
    }
  }
}
