/**
 * 事件决策规则集：一个 eventType 对应一条规则。
 *
 * 规则只描述「怎么判」，不保存判定结论；state 在判定时按事件现场拼接。
 * 没有匹配规则的事件保持未判定，不进入模型调用。
 */
import type { EventPriority } from '#core/event.js'
import { findEventSkill, EVENT_SKILLS } from './skills.js'

export type EventRuleQuestionType = 'noul' | 'score' | 'choice'

export interface EventRuleQuestion {
  type: EventRuleQuestionType
  instructions: string
  /** score 为档位数组；choice 为「选项 id → 说明」。 */
  criteria?: string[] | Record<string, string>
}

/** 固定骨架：有效性、自动执行、优先级、归属项目；skill 是可选辅助问题。 */
export interface EventRuleQuestions {
  is_valid: EventRuleQuestion
  autorun: EventRuleQuestion
  priority: EventRuleQuestion
  project: EventRuleQuestion
  skill?: EventRuleQuestion
}

export interface EventRuleGuardrails {
  /** 命中即强制人审并提升到 P0，不能被模型覆盖。 */
  riskLabels: string[]
  /** 可选的处理方式闭集；空表示沿用全局 EVENT_SKILLS。 */
  skills?: string[]
}

export interface EventRuleThresholds {
  isValid: number
  projectPick: number
}

/** 一条事件决策规则。 */
export interface EventRule {
  id: string
  /** 带来源前缀的事件类型；具体规则优先于兜底规则。 */
  eventType: string
  /** 用户写的原话，保留可回看。 */
  intent: string
  questions: EventRuleQuestions
  /** 拼进 Worker scope 的执行流程。 */
  workflowPrompt: string
  guardrails: EventRuleGuardrails
  thresholds: EventRuleThresholds
  version: number
}

/** 内置风险标签：安全、生产、事故、付费、对外发布。 */
export const DEFAULT_RULE_RISK_LABELS = ['security', 'prod', 'production', 'incident', 'payment', 'release']

export const DEFAULT_RULE_THRESHOLDS: EventRuleThresholds = {
  isValid: 0.5,
  projectPick: 0.4,
}

/** 优先级四象限模板：低 / 中 / 高 / 紧急。 */
const DEFAULT_PRIORITY_CRITERIA = [
  '低优先级：影响范围小，不影响核心流程，可以延后处理。',
  '中优先级：影响部分功能或部分用户，需要在近期处理。',
  '高优先级：影响核心功能、较多用户或持续性较强，需要优先处理。',
  '紧急：核心业务大范围中断、存在数据风险，或需要立即处理。',
]

const AUTO_CRITERIA: Record<string, string> = {
  auto: '可以自动执行，不需要人工确认。',
  review: '不能安全地完全自动执行，需要人工 review。',
}

/** 用内置四问骨架生成一条完整规则；局部覆盖时递归合并。 */
export function compileRuleTemplate(input: {
  id: string
  eventType: string
  intent?: string
  workflowPrompt?: string
  questions?: Partial<EventRuleQuestions>
  guardrails?: Partial<EventRuleGuardrails>
  thresholds?: Partial<EventRuleThresholds>
  version?: number
}): EventRule {
  const intent = input.intent?.trim() ?? ''
  const base = defaultQuestions(input.eventType, intent)
  const questions: EventRuleQuestions = {
    is_valid: mergeQuestion(base.is_valid, input.questions?.is_valid),
    autorun: mergeQuestion(base.autorun, input.questions?.autorun),
    priority: mergeQuestion(base.priority, input.questions?.priority),
    project: mergeQuestion(base.project, input.questions?.project),
    ...(input.questions?.skill
      ? { skill: mergeQuestion(base.skill!, input.questions.skill) }
      : base.skill ? { skill: base.skill } : {}),
  }
  return {
    id: input.id.trim(),
    eventType: input.eventType.trim(),
    intent,
    questions,
    workflowPrompt: input.workflowPrompt?.trim() || intent,
    guardrails: {
      riskLabels: input.guardrails?.riskLabels ?? [...DEFAULT_RULE_RISK_LABELS],
      ...(input.guardrails?.skills ? { skills: input.guardrails.skills } : {}),
    },
    thresholds: { ...DEFAULT_RULE_THRESHOLDS, ...input.thresholds },
    version: input.version && input.version > 0 ? Math.floor(input.version) : 1,
  }
}

function defaultQuestions(eventType: string, intent: string): EventRuleQuestions {
  const eventLabel = eventType
  const intentLine = intent ? `\n用户意图：${intent}` : ''
  return {
    is_valid: {
      type: 'noul',
      instructions: `该事件是否属于「${eventLabel}」且需要处理？只有明确属于这一类事件时才判定为有效；普通通知、合并记录、无关噪声不算。${intentLine}`,
    },
    autorun: {
      type: 'choice',
      instructions: '该事件是否可以自动执行，还是需要人工先看一眼？',
      criteria: AUTO_CRITERIA,
    },
    priority: {
      type: 'score',
      instructions: '评估该事件的处理优先级和重要程度。',
      criteria: [...DEFAULT_PRIORITY_CRITERIA],
    },
    project: {
      type: 'choice',
      instructions: '根据事件内容判断它归属于哪个项目。',
      criteria: { unknown: '无法根据事件内容可靠识别项目归属。' },
    },
    skill: {
      type: 'choice',
      instructions: '该事件应该用哪种处理方式？信息不足时选 unknown。',
      criteria: {
        ...Object.fromEntries(EVENT_SKILLS.map(skill => [skill.id, `${skill.name}：${skill.hint}`])),
        unknown: '无法确定处理方式。',
      },
    },
  }
}

function mergeQuestion(base: EventRuleQuestion, override?: EventRuleQuestion): EventRuleQuestion {
  if (!override) return base
  return {
    type: override.type,
    instructions: override.instructions.trim() || base.instructions,
    ...(override.criteria !== undefined ? { criteria: override.criteria } : base.criteria ? { criteria: base.criteria } : {}),
  }
}

/** 精确匹配事件类型；兜底规则使用 `*`。 */
export function findRule(rules: readonly EventRule[], eventType: string): EventRule | undefined {
  return rules.find(rule => rule.eventType === eventType)
}

/** 为事件解析规则：按事件类型精确匹配，匹配不上就不判定。 */
export function ruleForEvent(rules: readonly EventRule[], eventType: string): EventRule | undefined {
  return findRule(rules, eventType)
}

/** 规则变更后需要重新激活的事件类型。 */
export function ruleEventTypes(rules: readonly EventRule[]): string[] {
  return [...new Set(rules.map(rule => rule.eventType).filter(Boolean))]
}

/** 规则里可用的 skill 候选；缺省沿用全局闭集。 */
export function ruleSkills(rule: EventRule | undefined) {
  const ids = rule?.guardrails.skills
  if (!ids || ids.length === 0) return [...EVENT_SKILLS]
  return ids.map(id => findEventSkill(id)).filter((skill): skill is NonNullable<typeof skill> => Boolean(skill))
}

/** 配置层校验：返回可直接落盘的规则集。 */
export function validateEventRules(value: unknown): { error: string | null; value: EventRule[] } {
  if (!Array.isArray(value)) return { error: '需要规则数组', value: [] }
  const rules: EventRule[] = []
  const ids = new Set<string>()
  const types = new Set<string>()
  for (const [index, raw] of value.entries()) {
    const result = validateEventRule(raw, index + 1)
    if (result.error) return { error: result.error, value: [] }
    const rule = result.value
    if (ids.has(rule.id)) return { error: `规则 id 重复：${rule.id}`, value: [] }
    if (types.has(rule.eventType)) return { error: `事件类型重复：${rule.eventType}`, value: [] }
    ids.add(rule.id)
    types.add(rule.eventType)
    rules.push(rule)
  }
  return { error: null, value: rules }
}

/** 校验单条规则；缺省 questions 用内置模板补齐。 */
export function validateEventRule(value: unknown, index = 1): { error: string | null; value: EventRule } {
  const empty = compileRuleTemplate({ id: `rule-${index}`, eventType: 'event.unknown' })
  if (!isRecord(value)) return { error: `第 ${index} 条规则不是对象`, value: empty }
  const id = stringOf(value.id) || `rule-${index}`
  const eventType = stringOf(value.eventType)
  if (!eventType) return { error: `第 ${index} 条规则缺少 eventType`, value: empty }
  const githubWithoutPrefix = /^(issues|pull_request|workflow_run)\./.test(eventType)
  if (eventType === '*' || !eventType.includes('.') || githubWithoutPrefix) {
    return { error: `第 ${index} 条规则的 eventType 必须带来源前缀（例如 github.issues.opened）`, value: empty }
  }
  const questions = parseQuestions(value.questions, index)
  if (questions.error) return { error: questions.error, value: empty }
  const guardrails = isRecord(value.guardrails) ? value.guardrails : {}
  const riskLabels = Array.isArray(guardrails.riskLabels)
    ? guardrails.riskLabels.map(item => String(item).trim().toLowerCase()).filter(Boolean)
    : [...DEFAULT_RULE_RISK_LABELS]
  const skills = Array.isArray(guardrails.skills)
    ? guardrails.skills.map(item => String(item).trim()).filter(Boolean)
    : undefined
  if (skills?.some(id => !findEventSkill(id))) {
    return { error: `第 ${index} 条规则引用了未知处理方式`, value: empty }
  }
  const thresholds = isRecord(value.thresholds) ? value.thresholds : {}
  const version = Number(value.version)
  return {
    error: null,
    value: compileRuleTemplate({
      id,
      eventType,
      intent: stringOf(value.intent),
      workflowPrompt: stringOf(value.workflowPrompt),
      questions: questions.value,
      guardrails: { riskLabels, ...(skills ? { skills } : {}) },
      thresholds: {
        isValid: thresholdOf(thresholds.isValid, DEFAULT_RULE_THRESHOLDS.isValid),
        projectPick: thresholdOf(thresholds.projectPick, DEFAULT_RULE_THRESHOLDS.projectPick),
      },
      version: Number.isInteger(version) && version > 0 ? version : 1,
    }),
  }
}

function parseQuestions(value: unknown, ruleIndex: number): { error: string | null; value: Partial<EventRuleQuestions> } {
  if (value === undefined || value === null) return { error: null, value: {} }
  if (!isRecord(value)) return { error: `第 ${ruleIndex} 条规则的 questions 必须是对象`, value: {} }
  const out: Partial<EventRuleQuestions> = {}
  for (const key of ['is_valid', 'autorun', 'priority', 'project', 'skill'] as const) {
    const raw = value[key]
    if (raw === undefined || raw === null) continue
    const question = parseQuestion(raw, key, ruleIndex)
    if (question.error) return { error: question.error, value: {} }
    out[key] = question.value
  }
  return { error: null, value: out }
}

function parseQuestion(value: unknown, key: string, ruleIndex: number): { error: string | null; value: EventRuleQuestion } {
  if (!isRecord(value)) return { error: `第 ${ruleIndex} 条规则的 ${key} 必须是对象`, value: { type: 'noul', instructions: '' } }
  const type = value.type === 'score' || value.type === 'choice' ? value.type : 'noul'
  const instructions = stringOf(value.instructions)
  if (!instructions) return { error: `第 ${ruleIndex} 条规则的 ${key} 缺少 instructions`, value: { type, instructions: '' } }
  let criteria: EventRuleQuestion['criteria']
  if (type === 'score') {
    if (value.criteria !== undefined && !Array.isArray(value.criteria)) {
      return { error: `第 ${ruleIndex} 条规则的 ${key}.criteria 必须是数组`, value: { type, instructions } }
    }
    criteria = Array.isArray(value.criteria) ? value.criteria.map(item => String(item).trim()).filter(Boolean) : undefined
  } else if (type === 'choice') {
    if (value.criteria !== undefined && !isRecord(value.criteria)) {
      return { error: `第 ${ruleIndex} 条规则的 ${key}.criteria 必须是对象`, value: { type, instructions } }
    }
    criteria = isRecord(value.criteria)
      ? Object.fromEntries(Object.entries(value.criteria).map(([id, desc]) => [id, String(desc)]))
      : undefined
  }
  return { error: null, value: { type, instructions, ...(criteria ? { criteria } : {}) } }
}

function thresholdOf(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 把本地优先级档位映射到 score 档位。 */
export function priorityLevels(criteria: readonly string[]): EventPriority[] {
  const four: EventPriority[] = ['P3', 'P2', 'P1', 'P0']
  if (criteria.length <= 4) return four.slice(0, Math.max(1, criteria.length))
  return ['P4', 'P3', 'P2', 'P1', 'P0']
}
