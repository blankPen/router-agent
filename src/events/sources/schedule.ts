/**
 * 定时任务事件来源：按间隔产出一条固定事件。
 *
 * 用途是「每天巡检一次」「每小时拉一次报表」这类没有交互的例行任务；
 * 事件正文就是任务说明，判定与派工仍走同一条管线。
 */
import type { EventSourceConfig } from '../../config.js'
import type { EventEnvelope, EventSource } from '#event/port.js'

export interface ScheduleEventSourceDeps {
  /** 当前时间；测试注入。 */
  now?: () => Date
}

/** 定时任务事件来源。 */
export class ScheduleEventSource implements EventSource {
  readonly id: string
  readonly kind = 'schedule'
  private config: EventSourceConfig
  private now: () => Date

  constructor(id: string, config: EventSourceConfig, deps: ScheduleEventSourceDeps = {}) {
    this.id = id
    this.config = config
    this.now = deps.now ?? (() => new Date())
  }

  /** 每轮产出一条事件；externalId 带时间窗，同一窗口内不会重复入库。 */
  poll(): EventEnvelope[] {
    const at = this.now()
    const title = (this.config.title ?? '').trim() || '定时任务'
    const body = (this.config.body ?? '').trim() || title
    const bucket = Math.floor(at.getTime() / Math.max(60_000, this.config.intervalMs ?? 3_600_000))
    return [{
      externalId: `schedule:${this.id}:${bucket}`,
      title,
      body,
      receivedAt: at.toISOString(),
      raw: { bucket },
    }]
  }
}
