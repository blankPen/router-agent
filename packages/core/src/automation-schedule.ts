/**
 * 触发计划注册表：hourly / daily / weekly / cron 四种计划的可扩展实现。
 *
 * 新增一种计划只要往 SCHEDULES 注册一份，不必改调度器。
 */
import type { AutomationSchedule, AutomationScheduleKind, AutomationScheduleSpec } from './automation.js'

/** 计划种类注册表。 */
const SCHEDULES = new Map<AutomationScheduleKind, AutomationScheduleSpec>()

/** 注册一个计划实现；同名注册会覆盖前者。 */
export function registerSchedule(spec: AutomationScheduleSpec): void {
  SCHEDULES.set(spec.kind, spec)
}

/** 取计划实现；没注册过返回 undefined。 */
export function scheduleSpec(kind: string): AutomationScheduleSpec | undefined {
  return SCHEDULES.get(kind as AutomationScheduleKind)
}

/** 已注册的计划种类。 */
export function scheduleKinds(): AutomationScheduleKind[] {
  return [...SCHEDULES.keys()]
}

/** HH:mm 校验；非法返回 null。 */
export function parseClockTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute }
}

/**
 * 标准五段 cron 校验。
 *
 * 只接受 5 段（分 时 日 月 周），每段支持 `*`、数字、列表、范围与步长。
 * 不接受 6 段（含秒）——面板里的 cron 输入框按五段写，别让人写错。
 */
export function validateCron(expression: string): string | null {
  const text = expression.trim()
  if (!text) return 'Cron 表达式不能为空'
  const parts = text.split(/\s+/)
  if (parts.length !== 5) return `Cron 必须是 5 段（分 时 日 月 周），当前 ${parts.length} 段`
  const bounds: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
  for (const [index, part] of parts.entries()) {
    const message = validateCronField(part, bounds[index]!)
    if (message) return `第 ${index + 1} 段「${part}」${message}`
  }
  return null
}

/** 校验单段 cron 字段。 */
function validateCronField(field: string, [min, max]: [number, number]): string | null {
  if (!field) return '不能为空'
  for (const segment of field.split(',')) {
    const [rangePart, stepPart] = segment.split('/')
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) return '的步长必须是非负整数'
      if (Number(stepPart) < 1) return '的步长必须大于 0'
    }
    const range = rangePart ?? '*'
    if (range === '*') continue
    const bounds = range.split('-')
    if (bounds.length > 2) return '的范围格式不对'
    for (const bound of bounds) {
      if (!/^\d+$/.test(bound)) return '只能是数字、*、列表、范围或步长'
      const value = Number(bound)
      if (value < min || value > max) return `超出范围 ${min}-${max}`
    }
    if (bounds.length === 2 && Number(bounds[0]) > Number(bounds[1])) return '的范围起始大于结束'
  }
  return null
}

/** cron 单段是否命中某个取值。 */
function cronFieldMatches(field: string, value: number, min: number, max: number): boolean {
  for (const segment of field.split(',')) {
    const [rangePart, stepPart] = segment.split('/')
    const step = stepPart === undefined ? 1 : Number(stepPart)
    let start = min
    let end = max
    const range = rangePart ?? '*'
    if (range !== '*') {
      const bounds = range.split('-').map(Number)
      start = bounds[0]!
      end = bounds.length > 1 ? bounds[1]! : start
    }
    // 星期字段里 7 与 0 都表示周日：把 7 归一到 0 再比。
    const isWeekday = max === 7
    const normalize = (candidate: number): number => (isWeekday && candidate === 7 ? 0 : candidate)
    const normalizedTarget = normalize(value)
    for (let item = start; item <= end; item += step) {
      if (normalize(item) === normalizedTarget) return true
    }
  }
  return false
}

/** 计算 cron 的下一次触发时间；from 之后没有下次时返回 null。 */
export function nextCronTime(expression: string, from: Date): Date | null {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5 || validateCron(expression)) return null
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string]
  // 从下一分钟开始找，秒与毫秒清零。
  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  // 最多找 4 年：cron 最稀疏的合法组合（2 月 29 日）也在这个窗口内。
  const limit = new Date(from.getTime())
  limit.setFullYear(limit.getFullYear() + 4)
  while (cursor <= limit) {
    if (!cronFieldMatches(month, cursor.getMonth() + 1, 1, 12)) {
      cursor.setMonth(cursor.getMonth() + 1, 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }
    // 日与周都写 * 时才按周判定；两者都限定时按 OR 语义（标准 cron 行为）。
    const dayOk = cronFieldMatches(day, cursor.getDate(), 1, 31)
    const weekdayOk = cronFieldMatches(weekday, cursor.getDay(), 0, 7)
    const bothRestricted = day !== '*' && weekday !== '*'
    if (bothRestricted ? !(dayOk || weekdayOk) : !(dayOk && weekdayOk)) {
      cursor.setDate(cursor.getDate() + 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }
    if (!cronFieldMatches(hour, cursor.getHours(), 0, 23)) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!cronFieldMatches(minute, cursor.getMinutes(), 0, 59)) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0)
      continue
    }
    return cursor
  }
  return null
}

/** 每小时：下一个整点。 */
const HOURLY: AutomationScheduleSpec = {
  kind: 'hourly',
  label: '每小时',
  validate: () => null,
  next(_schedule, from) {
    const next = new Date(from.getTime())
    next.setMinutes(0, 0, 0)
    next.setHours(next.getHours() + 1)
    return next
  },
}

/** 每天：固定时刻（默认 09:00）。 */
const DAILY: AutomationScheduleSpec = {
  kind: 'daily',
  label: '每天',
  validate(schedule) {
    const time = schedule.at ?? '09:00'
    return parseClockTime(time) ? null : `执行时刻不合法：${time}（应为 HH:mm）`
  },
  next(schedule, from) {
    const clock = parseClockTime(schedule.at ?? '09:00')!
    const next = new Date(from.getTime())
    next.setHours(clock.hour, clock.minute, 0, 0)
    if (next <= from) next.setDate(next.getDate() + 1)
    return next
  },
}

/** 每周：星期几 + 时刻（默认周一 09:00）。 */
const WEEKLY: AutomationScheduleSpec = {
  kind: 'weekly',
  label: '每周',
  validate(schedule) {
    const weekday = schedule.weekday ?? 1
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return `星期不合法：${schedule.weekday}（应为 0-6）`
    }
    const time = schedule.time ?? '09:00'
    return parseClockTime(time) ? null : `执行时刻不合法：${time}（应为 HH:mm）`
  },
  next(schedule, from) {
    const weekday = schedule.weekday ?? 1
    const clock = parseClockTime(schedule.time ?? '09:00')!
    const next = new Date(from.getTime())
    next.setHours(clock.hour, clock.minute, 0, 0)
    const diff = (weekday - next.getDay() + 7) % 7
    next.setDate(next.getDate() + diff)
    if (next <= from) next.setDate(next.getDate() + 7)
    return next
  },
}

/** 自定义 cron。 */
const CRON: AutomationScheduleSpec = {
  kind: 'cron',
  label: '自定义 Cron',
  validate(schedule) {
    return validateCron(schedule.cron ?? '')
  },
  next(schedule, from) {
    return nextCronTime(schedule.cron ?? '', from)
  },
}

registerSchedule(HOURLY)
registerSchedule(DAILY)
registerSchedule(WEEKLY)
registerSchedule(CRON)

/**
 * 计划校验：先看种类有没有注册，再交给对应实现校验参数。
 */
export function validateSchedule(schedule: AutomationSchedule): string | null {
  const spec = scheduleSpec(schedule.kind)
  if (!spec) return `未知的触发计划：${schedule.kind}`
  return spec.validate(schedule)
}

/**
 * 下一次触发时间；计划非法时返回 null。
 *
 * 计划为空（事件触发的任务）时返回 null —— 它不按时间触发。
 */
export function nextRunAt(schedule: AutomationSchedule | undefined, from: Date): string | null {
  if (!schedule) return null
  const spec = scheduleSpec(schedule.kind)
  if (!spec || validateSchedule(schedule)) return null
  const next = spec.next(schedule, from)
  return next ? next.toISOString() : null
}

/** 计划的中文名；未注册的种类回退成原始值。 */
export function scheduleLabel(schedule: AutomationSchedule): string {
  return scheduleSpec(schedule.kind)?.label ?? schedule.kind
}
