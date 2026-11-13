import type { EventEnvelope, EventSource } from '#core/event.js'

/** cron 字段：分 时 日 月 周。 */
const CRON_FIELDS = 5

/**
 * 匹配一个五段 cron 表达式。
 *
 * 支持通配、数字、逗号列表、a-b 区间与斜杠步长；周字段 0 与 7 都表示周日。
 */
export function cronMatches(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== CRON_FIELDS) return false
  const values = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(),
  ]
  return fields.every((field, index) => matchField(field, values[index]!, index === 4))
}

/** 单个字段是否命中。 */
function matchField(field: string, value: number, isWeekday: boolean): boolean {
  if (field === '*') return true
  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/')
    const step = stepText ? Number(stepText) : 1
    if (!Number.isFinite(step) || step <= 0) continue
    if (range === '*') {
      if (value % step === 0) return true
      continue
    }
    const [fromText, toText] = range!.split('-')
    const from = Number(fromText)
    const to = toText === undefined ? from : Number(toText)
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue
    // 周日既可以是 0 也可以是 7。
    const normalized = isWeekday && value === 0 ? 7 : value
    if (normalized >= from && normalized <= to && (normalized - from) % step === 0) return true
  }
  return false
}

/** 下一个触发时刻；从当前时间起逐分钟找，最多找一年。 */
export function nextCronTime(expression: string, from: Date): Date {
  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const limit = 366 * 24 * 60
  for (let step = 0; step < limit; step += 1) {
    if (cronMatches(expression, cursor)) return new Date(cursor.getTime())
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return new Date(from.getTime())
}

/** 定时来源的配置。 */
export interface CronSourceOptions {
  id: string
  /** 五段 cron 表达式。 */
  cron: string
  /** 任务说明：这次要查什么。 */
  task: string
  project?: string
  priorityHint: number
  costClass: EventEnvelope['costClass']
  lane?: string
}

/**
 * 定时任务来源。
 *
 * 幂等键用「计划触发时刻」：同一时刻只产生一条事件，进程重启也不会重复。
 */
export class CronSource implements EventSource {
  readonly id: string
  readonly family = 'timer' as const
  private options: CronSourceOptions
  private lastFiredAt = ''

  constructor(options: CronSourceOptions) {
    this.options = options
    this.id = options.id
  }

  /** 轮询一次：到点就产出一条事件，没到点返回空。 */
  async poll(ctx: { now: string }): Promise<EventEnvelope[]> {
    const now = new Date(ctx.now)
    if (Number.isNaN(now.getTime())) return []
    const planned = new Date(now.getTime())
    planned.setSeconds(0, 0)
    if (!cronMatches(this.options.cron, planned)) return []
    const key = planned.toISOString()
    if (this.lastFiredAt === key) return []
    this.lastFiredAt = key
    return [{
      id: '',
      source: this.options.id,
      type: 'timer.fired',
      externalId: key,
      subject: this.options.id,
      summary: this.options.task || '定时任务触发',
      actor: { id: 'system', name: '定时任务', type: 'system' },
      ...(this.options.project ? { project: this.options.project } : {}),
      lane: this.options.lane || `source:${this.options.id}`,
      priorityHint: this.options.priorityHint,
      costClass: this.options.costClass,
      receivedAt: ctx.now,
      hops: 0,
    }]
  }
}
