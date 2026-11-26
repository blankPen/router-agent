/**
 * 事件订阅：从自动化任务推导出来的「订阅什么、命中后怎么办」。
 *
 * 订阅是**任务的属性**，不是事件源的属性 —— 同一个仓库可以被多个任务订阅，
 * 每个任务有自己的过滤条件、处理方式与归属项目。
 *
 * 事件源插件只声明「有什么可订阅」（见 `src/events/catalog.ts`）；
 * 订阅关系全部落在这里。
 */
import type { Automation, AutomationTrigger, EventHandlingMode } from '#core/automation.js'
import type { AppConfig } from '../config.js'

/** 一条订阅：宿主内部用来拉事件、匹配事件、派工。 */
export interface ResolvedSubscription {
  /** 订阅 id：等于自动化任务 id；事件按它归属。 */
  id: string
  /** 任务名（面板与收件箱显示）。 */
  taskName: string
  /** 来源目录 id。 */
  source: string
  /** 订阅的事件类型（带来源前缀）。 */
  types: string[]
  /** 每个订阅自己的参数（仓库、群、白板 id …）。 */
  params: Record<string, string>
  /** 确定性过滤条件。 */
  filter: { keywords: string[]; semantic: string }
  /** 处理方式：自动执行 / 待人审 / 仅提醒。 */
  mode: EventHandlingMode
  /** 归属项目（任务属性，由会话解析时从对话内容分析得出）。 */
  project: string
  /** 处理方式（skill 闭集内的 id）。 */
  skill: string
  /** Worker 的执行流程（任务的 prompt）。 */
  prompt: string
  /** 通知人；空表示不发通知。 */
  notifyTo: string
  /** 任务是否启用。 */
  enabled: boolean
}

/**
 * 从自动化任务清单推导全部事件订阅。
 *
 * 定时任务不产生订阅；事件任务产生一条。
 * 停用的任务不产生订阅 —— 面板停用任务后，订阅随之消失。
 */
export function deriveSubscriptions(tasks: readonly Automation[]): ResolvedSubscription[] {
  const out: ResolvedSubscription[] = []
  for (const task of tasks) {
    const trigger = task.trigger
    if (!trigger || trigger.kind !== 'event') continue
    // 停用的任务不订阅：面板停用任务后，订阅随之消失（§12.6 V27）。
    if (!task.enabled) continue
    out.push({
      id: task.id,
      taskName: task.name,
      source: trigger.source,
      types: [...trigger.types],
      params: { ...(trigger.params ?? {}) },
      filter: {
        keywords: [...(trigger.filter?.keywords ?? [])],
        semantic: trigger.filter?.semantic ?? '',
      },
      mode: trigger.mode,
      project: task.project,
      skill: task.skill ?? '',
      prompt: task.prompt,
      notifyTo: task.notifyTo ?? '',
      enabled: task.enabled,
    })
  }
  return out
}

/** 从配置推导订阅（宿主装配用）。 */
export function subscriptionsOf(config: AppConfig): ResolvedSubscription[] {
  return deriveSubscriptions(config.automation.tasks)
}

/**
 * 事件类型是否被订阅命中。
 *
 * 精确匹配；`types` 里没有通配语义 —— 订阅了哪些就是哪些。
 */
export function subscriptionMatchesType(subscription: ResolvedSubscription, eventType: string): boolean {
  if (!eventType) return false
  return subscription.types.includes(eventType)
}

/**
 * 确定性关键词过滤。
 *
 * 只回答「字面上有没有命中」：命中任一关键词即通过。
 * 语义判断交给判定模型 —— 这里不做语义猜测。
 *
 * 没有配关键词时一律通过：过滤条件的缺失不该让事件凭空消失。
 */
export function matchesKeywords(subscription: ResolvedSubscription, text: string): boolean {
  const keywords = subscription.filter.keywords
  if (keywords.length === 0) return true
  const haystack = text.toLowerCase()
  return keywords.some(keyword => haystack.includes(keyword.toLowerCase()))
}

/** 订阅的来源分组：同一个来源的订阅放在一起，watcher 按来源装配。 */
export function groupBySource(subscriptions: readonly ResolvedSubscription[]): Map<string, ResolvedSubscription[]> {
  const out = new Map<string, ResolvedSubscription[]>()
  for (const subscription of subscriptions) {
    const list = out.get(subscription.source)
    if (list) list.push(subscription)
    else out.set(subscription.source, [subscription])
  }
  return out
}

/** 触发器是不是事件触发。 */
export function isEventTrigger(trigger: AutomationTrigger | undefined): trigger is Extract<AutomationTrigger, { kind: 'event' }> {
  return trigger?.kind === 'event'
}
