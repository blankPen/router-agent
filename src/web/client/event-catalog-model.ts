/**
 * 事件目录的纯逻辑：把目录视图整理成面板要展示的形状。
 *
 * 目录是**只读**的：它回答「有什么可订阅」，不回答「谁订阅了」——
 * 订阅关系在自动化任务里，这里只把「被 N 个任务订阅」这个计数显示出来。
 */

/** 一个事件类型的可用性。 */
export interface TypeAvailability {
  ready: boolean
  requiresConsoleSubscription?: boolean
  requiresUserIdentity?: boolean
  requiresScopes?: string[]
  requiresParams?: string[]
  note?: string
}

/** 目录里的一个事件类型。 */
export interface CatalogType {
  id: string
  label: string
  group: string
  availability?: TypeAvailability
}

/** 目录里的一个连接参数。 */
export interface CatalogParam {
  key: string
  label: string
  kind?: string
  hint?: string
  required?: boolean
}

/** 一个来源的目录视图。 */
export interface CatalogView {
  id: string
  kind: string
  name: string
  types: CatalogType[]
  params: CatalogParam[]
  builtin: boolean
  package?: string
}

/** 目录里的一行：一个事件类型 + 它被多少个任务订阅。 */
export interface CatalogRow {
  type: CatalogType
  /** 被几个任务订阅这个类型。 */
  subscribers: number
  /** 订阅的任务名；面板上展示一行让人认得出是谁在订。 */
  subscriberNames: string[]
}

/** 按分组整理后的一个来源。 */
export interface CatalogGroup {
  /** 分组名；空串表示「未分组」。 */
  name: string
  rows: CatalogRow[]
}

/**
 * 可用性的标签。
 *
 * 三档：开箱可用 / 需后台订阅 / 需用户身份 —— 都是**能力提示**，
 * 不是拦截；用户点了「确认创建」任务照样建，只是事件可能不来。
 */
export function availabilityTag(type: CatalogType): { text: string; tone: 'ok' | 'warn' } | null {
  const availability = type.availability
  if (!availability || availability.ready) return { text: '开箱可用', tone: 'ok' }
  if (availability.requiresUserIdentity) return { text: '需用户身份', tone: 'warn' }
  return { text: '需后台订阅', tone: 'warn' }
}

/**
 * 把目录视图整理成分组的行。
 *
 * 分组顺序按目录给的 `group` 首次出现顺序 —— 目录作者排好的顺序就是面板顺序。
 */
export function catalogRows(
  catalog: CatalogView,
  subscribers: Map<string, string[]>,
): CatalogGroup[] {
  const groups = new Map<string, CatalogRow[]>()
  for (const type of catalog.types) {
    const name = type.group || ''
    const list = groups.get(name) ?? []
    const names = subscribers.get(type.id) ?? []
    list.push({ type, subscribers: names.length, subscriberNames: names })
    groups.set(name, list)
  }
  return [...groups.entries()].map(([name, rows]) => ({ name, rows }))
}

/**
 * 统计每个事件类型被哪些任务订阅。
 *
 * 输入是自动化任务列表；订阅里没有这个类型就不算。
 */
export function subscribersByType(tasks: Array<{ name: string; trigger: { kind: string; types?: string[] } }>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const task of tasks) {
    if (task.trigger.kind !== 'event') continue
    for (const type of task.trigger.types ?? []) {
      const list = out.get(type) ?? []
      list.push(task.name)
      out.set(type, list)
    }
  }
  return out
}

/** 目录头部的一组统计：类型总数、开箱可用数、需后台订阅数。 */
export function catalogStats(catalog: CatalogView): { total: number; ready: number; needsConsole: number } {
  let ready = 0
  let needsConsole = 0
  for (const type of catalog.types) {
    if (!type.availability || type.availability.ready) ready += 1
    else needsConsole += 1
  }
  return { total: catalog.types.length, ready, needsConsole }
}
