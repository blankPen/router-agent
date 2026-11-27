/**
 * 决策规则 → 自动化任务的一次性迁移。
 *
 * 规则描述的是「怎么判」，任务描述的是「订阅什么 + 命中后怎么办」。
 * 迁移把每条规则翻译成一条事件触发的自动化任务；
 * 翻译不了的（来源前缀不认识、归属项目有多个、兜底通配）**不硬造**，
 * 进「待人工处理」清单交给人。
 *
 * 迁移是幂等的：任务 id 固定、标记 `createdBy: 'migration:events.rules'`，
 * 重复执行不会重复建。
 */
import type { Automation, EventFilter, EventTrigger, EventHandlingMode } from '#core/automation.js'
import { EVENT_SKILLS, findEventSkill } from './skills.js'
import type { ProjectConfig } from '../config.js'

/** 迁移标记：写进任务的 `createdBy`。 */
export const MIGRATION_CREATED_BY = 'migration:events.rules'

/** 规则结构（只取迁移用得到的字段，多余字段直接忽略）。 */
export interface LegacyEventRule {
  id: string
  eventType: string
  intent?: string
  workflowPrompt?: string
  questions?: {
    is_valid?: { instructions?: string }
    autorun?: { criteria?: string[] | Record<string, string> }
    priority?: { criteria?: string[] | Record<string, string> }
    project?: { criteria?: string[] | Record<string, string> }
    skill?: { criteria?: string[] | Record<string, string> }
  }
  thresholds?: { isValid?: number }
}

/** 一条待人工处理的规则。 */
export interface ManualRule {
  id: string
  eventType: string
  /** 为什么迁不了。 */
  reason: string
}

/** 迁移结果。 */
export interface RuleMigrationResult {
  /** 能自动迁移的任务。 */
  tasks: Automation[]
  /** 迁不了的规则。 */
  manual: ManualRule[]
  /** 已经迁过的规则 id（幂等：跳过）。 */
  skipped: string[]
}

/** 迁移上下文。 */
export interface RuleMigrationDeps {
  /** 规则清单（来自 config.yaml 的 `events.rules`）。 */
  rules: readonly LegacyEventRule[]
  /** 候选项目（闭集）。 */
  projects: readonly ProjectConfig[]
  /** 已配置的事件来源（按来源 id 取连接参数，如 GitHub 的仓库）。 */
  sources?: Readonly<Record<string, { repo?: string }>>
  /** 已存在的任务（幂等判定）。 */
  existingTasks?: readonly Automation[]
  /** 迁移时间（ISO）。 */
  now: string
}

/** 已知来源前缀；不在这里面的 eventType 一律进人工清单。 */
const KNOWN_SOURCES = new Set(['github', 'feishu'])

/**
 * 迁移一批规则。
 *
 * 纯函数：只算不写，写盘由调用方决定（`--dry-run` 与 `--apply` 共用同一份逻辑）。
 */
export function migrateRules(deps: RuleMigrationDeps): RuleMigrationResult {
  const tasks: Automation[] = []
  const manual: ManualRule[] = []
  const skipped: string[] = []
  const taken = new Set((deps.existingTasks ?? []).map(task => task.id))

  for (const rule of deps.rules) {
    const id = taskIdOf(rule.id)
    if (taken.has(id)) {
      skipped.push(rule.id)
      continue
    }
    const source = sourceOf(rule.eventType)
    if (!source) {
      manual.push({ id: rule.id, eventType: rule.eventType, reason: '事件类型没有可识别的来源前缀' })
      continue
    }
    if (rule.eventType === '*' || rule.eventType.endsWith('.*')) {
      manual.push({ id: rule.id, eventType: rule.eventType, reason: '兜底规则无法表达为精确订阅' })
      continue
    }
    const project = projectOf(rule, deps.projects)
    if (!project) {
      manual.push({ id: rule.id, eventType: rule.eventType, reason: '归属项目有多个候选或没有候选，需人工指定' })
      continue
    }
    const skill = skillOf(rule)
    const trigger: EventTrigger = {
      kind: 'event',
      source,
      types: [rule.eventType],
      params: paramsOf(rule, source, deps.sources),
      filter: filterOf(rule),
      mode: modeOf(rule),
    }
    tasks.push({
      id,
      name: nameOf(rule, project),
      description: (rule.intent ?? '').trim(),
      type: 'ai',
      prompt: (rule.workflowPrompt ?? rule.intent ?? '').trim(),
      trigger,
      runtimeId: '',
      project: project.name,
      repo: project.repo,
      branch: project.defaultBranch ?? '',
      skill,
      notifyTo: '',
      enabled: true,
      createdBy: MIGRATION_CREATED_BY,
      createdAt: deps.now,
      updatedAt: deps.now,
    })
    taken.add(id)
  }

  return { tasks, manual, skipped }
}

/** 任务 id：`auto_<ruleId 去掉 rule- 前缀>`。 */
export function taskIdOf(ruleId: string): string {
  const trimmed = ruleId.trim()
  const withoutPrefix = trimmed.startsWith('rule-') ? trimmed.slice('rule-'.length) : trimmed
  return `auto_${withoutPrefix || 'migrated'}`
}

/** 从 eventType 切出来源前缀。 */
export function sourceOf(eventType: string): string | undefined {
  const trimmed = eventType.trim()
  const dot = trimmed.indexOf('.')
  if (dot <= 0) return undefined
  const source = trimmed.slice(0, dot)
  return KNOWN_SOURCES.has(source) ? source : undefined
}

/** 归属项目：criteria 里除 `unknown` 外的键名当项目名；多个 → 迁不了。 */
function projectOf(rule: LegacyEventRule, projects: readonly ProjectConfig[]): ProjectConfig | undefined {
  const criteria = rule.questions?.project?.criteria
  if (!criteria || Array.isArray(criteria)) return projects.length === 1 ? projects[0] : undefined
  const names = Object.keys(criteria).filter(key => key !== 'unknown')
  if (names.length === 0) return projects.length === 1 ? projects[0] : undefined
  const matched = names
    .map(name => projects.find(project => project.name.toLowerCase() === name.toLowerCase()))
    .filter((project): project is ProjectConfig => Boolean(project))
  if (matched.length === 1) return matched[0]
  if (matched.length > 1) return undefined
  return undefined
}

/** 处理方式：skill 闭集内的 id；认不出来退回默认。 */
function skillOf(rule: LegacyEventRule): string {
  const criteria = rule.questions?.skill?.criteria
  if (criteria && !Array.isArray(criteria)) {
    const hit = Object.keys(criteria).find(key => findEventSkill(key))
    if (hit) return hit
  }
  return EVENT_SKILLS[0]!.id
}

/** 处理方式：autorun 的 criteria 里出现 auto → auto；只有 review → review。 */
function modeOf(rule: LegacyEventRule): EventHandlingMode {
  const criteria = rule.questions?.autorun?.criteria
  const keys = criteria
    ? Array.isArray(criteria) ? criteria : Object.keys(criteria)
    : []
  if (keys.some(key => key.toLowerCase().includes('auto'))) return 'auto'
  if (keys.some(key => key.toLowerCase().includes('review'))) return 'review'
  return 'auto'
}

/** 过滤条件：有效性问题的说明去掉「用户意图：」尾巴后作为语义条件。 */
function filterOf(rule: LegacyEventRule): EventFilter {
  const raw = rule.questions?.is_valid?.instructions?.trim() ?? ''
  const semantic = raw.replace(/用户意图[：:].*$/s, '').trim()
  return semantic ? { semantic } : {}
}

/** 订阅参数：来源连接里配了什么就带什么（GitHub 的仓库）。 */
function paramsOf(
  rule: LegacyEventRule,
  source: string,
  sources: RuleMigrationDeps['sources'],
): Record<string, string> {
  const repo = sources?.[source]?.repo
  if (!repo) return {}
  return { repo }
}

/** 任务名：优先用规则 id 去掉前缀后的可读形式。 */
function nameOf(rule: LegacyEventRule, project: ProjectConfig): string {
  const intent = (rule.intent ?? '').trim()
  if (intent) return intent.slice(0, 40)
  const base = rule.id.replace(/^rule-/, '')
  return `${base}（${project.name}）`
}

