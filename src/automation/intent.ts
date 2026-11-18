/**
 * 对话式创建入口的意图识别。
 *
 * 分两层：
 * - 确定性预筛（这里）：消息里没有「周期 / 监听」这类词就直接放行，不烧模型；
 * - 模型判定（`AutomationService.draftFromText`）：把原话整理成任务草稿，
 *   识别不确定时返回 null，由调用方回问用户，不自动落库。
 */

/** 出现这些词才可能是自动化需求：周期动作或监听动作。 */
const SCHEDULE_HINTS = [
  '定时', '定期', '周期', '每隔', '每天', '每周', '每月', '每小时', '每晚',
  '自动', '自动化', '巡检', '监听', '监控', '订阅',
]

/** 出现这些词才可能是「要安排一件事」而不是单纯聊到这些概念。 */
const ACTION_HINTS = [
  '我想', '我要', '我需要', '帮我', '帮忙', '请', '能不能', '可不可以', '以后',
  '监听', '监控', '订阅', '巡检', '检查', '处理', '跟踪', '盯', '看',
]

/** 英文说法。 */
const EN_HINTS = ['automation', 'schedule', 'cron', 'every day', 'every week', 'periodically', 'monitor']

/**
 * 是不是「想建一个自动化」的候选。
 *
 * 这是预筛，不是判定：命中只说明值得问模型一次，
 * 最终是否创建由模型整理出的草稿决定。
 */
export function looksLikeAutomationIntent(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (!normalized) return false
  const hasSchedule = SCHEDULE_HINTS.some(hint => normalized.includes(hint))
    || EN_HINTS.some(hint => normalized.includes(hint))
  if (!hasSchedule) return false
  return ACTION_HINTS.some(hint => normalized.includes(hint))
    || EN_HINTS.some(hint => normalized.includes(hint))
}

/** 模型输出的草稿；`uncertain` 为 true 表示识别不确定。 */
export interface AutomationDraftPayload {
  uncertain?: boolean
  name?: string
  type?: string
  prompt?: string
  schedule?: {
    kind?: string
    at?: string
    weekday?: number
    time?: string
    cron?: string
  }
  /** 需要回问用户的问题（识别不确定时给出）。 */
  question?: string
}
