/**
 * 规则面板的纯函数：摘要、初始化、增删与基础校验。
 *
 * 真正落盘前的闭集校验仍在服务端；这里只做能让用户提前发现问题的轻校验。
 */
import { GITHUB_EVENT_PREFIX, GITHUB_EVENT_TYPES, githubEventTypesByKind } from '#core/github-events.js'
import { compileRuleTemplate, validateEventRule, type EventRule } from '../../events/rules.js'
import type { ConfigDoc } from './api.js'

export interface EventTypeOption {
  value: string
  label: string
  group: string
}

/** 新建规则用内置四问模板；id 由调用方补。 */
export function blankRule(id: string, eventType: string): EventRule {
  return compileRuleTemplate({ id, eventType, intent: '', workflowPrompt: '' })
}

/** 列表卡片的一句话摘要。 */
export function ruleSummary(rule: EventRule): string {
  const questionCount = ['is_valid', 'autorun', 'priority', 'project'].filter(id => Boolean(rule.questions[id as keyof typeof rule.questions])).length
  const autorun = rule.questions.autorun.criteria
  const auto = autorun && !Array.isArray(autorun) && autorun.auto ? '可自动执行' : '自动执行待配置'
  const priorityCount = Array.isArray(rule.questions.priority.criteria) ? rule.questions.priority.criteria.length : 4
  return `${questionCount} 个判定 · ${auto} · 优先级 ${priorityCount} 档`
}

export function upsertRule(rules: readonly EventRule[], next: EventRule): EventRule[] {
  return [...rules.filter(rule => rule.id !== next.id), next]
}

export function removeRule(rules: readonly EventRule[], id: string): EventRule[] {
  return rules.filter(rule => rule.id !== id)
}

/** 用户改完草稿后编译：骨架固定，只有 instructions / criteria / 阈值可改。 */
export function saveRuleDraft(rule: EventRule): { error: string | null; value: EventRule } {
  return validateEventRule(rule)
}

/**
 * 事件类型候选：GitHub 目录 + 当前配置里已订阅的其它来源类型。
 * 未订阅的类型也保留，方便先配规则、后开订阅。
 */
export function eventTypeOptions(draft: ConfigDoc | null): Array<{ group: string; options: EventTypeOption[] }> {
  const github = githubEventTypesByKind().map(item => ({
    group: `GitHub · ${item.label}`,
    options: item.types.map(type => ({
      value: `${GITHUB_EVENT_PREFIX}.${type.id}`,
      label: `${type.label}（${GITHUB_EVENT_PREFIX}.${type.id}）`,
      group: `GitHub · ${item.label}`,
    })),
  }))
  const custom: EventTypeOption[] = []
  const sources = getPath(draft, 'events.sources')
  if (sources && typeof sources === 'object' && !Array.isArray(sources)) {
    for (const [sourceId, raw] of Object.entries(sources as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue
      const source = raw as Record<string, unknown>
      const kind = typeof source.kind === 'string' ? source.kind : ''
      if (!kind || kind === 'github') continue
      const events = Array.isArray(source.events) ? source.events.map(String) : []
      if (events.length === 0) {
        custom.push({ value: `${kind}.event`, label: `${sourceId} · 默认事件`, group: kind })
        continue
      }
      for (const eventType of events) {
        custom.push({ value: `${kind}.${eventType}`, label: `${sourceId} · ${eventType}`, group: kind })
      }
    }
  }
  const groups = [...github]
  if (custom.length > 0) groups.push({ group: '其它来源', options: custom })
  return groups
}

/** 已配置规则的 eventType；供下拉去重。 */
export function configuredEventTypes(rules: readonly EventRule[]): Set<string> {
  return new Set(rules.map(rule => rule.eventType))
}

/** 新增时生成一个稳定、可读的 id。 */
export function nextRuleId(eventType: string): string {
  const suffix = eventType.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `rule-${suffix || 'event'}`
}

export const GITHUB_EVENT_TYPE_OPTIONS = GITHUB_EVENT_TYPES

function getPath(doc: ConfigDoc | null, path: string): unknown {
  let current: unknown = doc
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
