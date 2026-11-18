/**
 * 决策模型的两种接入方式：Jev（结构化问题）与 LLM（JSON 结论式）。
 *
 * questions 由规则自带；state 在判定时把事件现场与规则上下文拼出来。
 * 模型只能从宿主给出的项目 / skill 闭集里选，不能凭空造。
 */
import type { EventPriority } from '#core/event.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import type { ChatClient } from '#infra/chat.js'
import { JevClient, type JevQuestion, type JevAnswers } from '#infra/decision/jev-client.js'
import { extractJsonObject } from '../router/model-config.js'
import type { EventDecisionInput, EventDecisionOutput, EventDecisionPort } from './decision.js'
import { priorityLevels, ruleSkills, type EventRuleQuestion } from './rules.js'
import { skillCatalogText } from './skills.js'

/** LLM 判定端口：一次调用要一个 JSON 结论。 */
export function createLlmDecisionPort(client: ChatClient, deps: { logger?: Logger } = {}): EventDecisionPort {
  const logger = deps.logger ?? noopLogger
  return {
    name: 'llm',
    async decide(input: EventDecisionInput): Promise<EventDecisionOutput | null> {
      const turn = await client.complete([
        { role: 'system', content: systemPromptOf(input) },
        { role: 'user', content: userPromptOf(input) },
      ])
      const parsed = extractJsonObject(turn.content)
      if (!parsed) {
        logger.warn('event:decision-unparsable', { eventId: input.event.id })
        return null
      }
      const valid = parsed.is_valid === undefined ? parsed.actionable !== false : parsed.is_valid !== false
      const autorun = typeof parsed.autorun === 'string' ? parsed.autorun.trim().toLowerCase() : ''
      return {
        actionable: valid,
        ...(parsed.priority ? { priority: String(parsed.priority).toUpperCase() as EventPriority } : {}),
        ...(parsed.type ? { eventType: String(parsed.type) } : {}),
        ...(parsed.project ? { project: String(parsed.project) } : {}),
        ...(parsed.skill ? { skill: String(parsed.skill) } : {}),
        ...(autorun
          ? { needsReview: autorun !== 'auto' }
          : typeof parsed.needsReview === 'boolean' ? { needsReview: parsed.needsReview } : {}),
        ...(parsed.reason ? { reason: String(parsed.reason) } : {}),
        ...(typeof parsed.confidence === 'number' ? { confidence: parsed.confidence } : {}),
      }
    },
  }
}

/** Jev 判定端口：问题骨架固定，具体标准来自命中的规则。 */
export function createJevDecisionPort(client: JevClient, deps: { logger?: Logger } = {}): EventDecisionPort {
  const logger = deps.logger ?? noopLogger
  return {
    name: 'jev',
    async decide(input: EventDecisionInput): Promise<EventDecisionOutput | null> {
      let answers: JevAnswers
      try {
        answers = await client.ask(stateOf(input), jevQuestionsOf(input))
      } catch (error) {
        logger.warn('event:jev-failed', { eventId: input.event.id, ruleId: input.rule?.id, message: errorMessage(error) })
        throw error
      }
      const isValid = numberAnswer(answers, 'is_valid')
      const threshold = input.rule && input.rule.id !== 'legacy-prompt'
        ? input.rule.thresholds.isValid
        : input.decision.confidenceThreshold
      const valid = isValid >= threshold
      const autorun = stringAnswer(answers, 'autorun')
      const priority = priorityFromScore(numberAnswer(answers, 'priority'), priorityCriteriaOf(input))
      const project = stringAnswer(answers, 'project')
      const skill = stringAnswer(answers, 'skill')
      const projectName = project && project !== 'unknown' ? project : ''
      const skillId = skill && skill !== 'unknown' ? skill : ''
      const confidence = valid ? Math.min(isValid, projectName ? 1 : input.rule?.thresholds.projectPick ?? 0.4) : isValid
      return {
        actionable: valid,
        priority,
        eventType: input.event.eventType || '',
        ...(projectName ? { project: projectName } : {}),
        ...(skillId ? { skill: skillId } : {}),
        needsReview: valid && autorun !== 'auto',
        reason: 'Jev 规则判定',
        confidence,
      }
    },
  }
}

/** LLM 的系统提示词：规则问题 + 输出格式 + 候选闭集。 */
export function systemPromptOf(input: EventDecisionInput): string {
  const rule = input.rule
  const projects = input.projects.length
    ? input.projects.map(project => `- ${project.name}（仓库 ${project.repo}）`).join('\n')
    : '（没有候选项目；判定不出归属时把 project 设为 unknown，并标 autorun=review）'
  const skills = ruleSkills(rule)
  return [
    '你是事件总线里的决策模型。一次判定要同时回答：事件是否有效、能否自动执行、优先级、归属项目，以及可选的处理方式。',
    '',
    '# 规则意图（人工可配置）',
    rule?.intent || input.prompt,
    '',
    '# 判定问题（按顺序回答，语义不可改变）',
    questionCatalogText(rule),
    '',
    '# 候选项目（只能从中选，或 unknown）',
    projects,
    '',
    '# 候选处理方式（只能从中选，或 unknown）',
    skillCatalogText(skills),
    '',
    '# 输出格式',
    '只输出一个 JSON 对象，不要解释：',
    '{"is_valid":true,"autorun":"auto","priority":"P1","project":"项目名","skill":"skill-id","reason":"一句话理由","confidence":0.9}',
    'autorun 只能是 auto / review；拿不准时 project=unknown、autorun=review，并调低 confidence。不要编造闭集以外的项目或 skill。',
  ].join('\n')
}

/** LLM 的用户提示词：state 原始结构，避免模型漏看事件类型与上下文。 */
export function userPromptOf(input: EventDecisionInput): string {
  const event = input.event
  return [
    `# 事件标题\n${event.title}`,
    `# 事件正文\n${event.body || '(空)'}`,
    `# 判定输入\n${JSON.stringify(stateOf(input), null, 2)}`,
  ].join('\n\n')
}

/** Jev 的 state：背景、事件参数与规则上下文；保存时不生成，判定时拼接。 */
export function stateOf(input: EventDecisionInput): {
  background: string
  payload: Record<string, string>
  rule: { id: string; eventType: string; intent: string; workflowPrompt: string }
} {
  const event = input.event
  const context = event.context ?? {}
  return {
    background: `${event.title}\n${event.body}`.trim(),
    payload: {
      ...context,
      type: event.eventType,
      source: event.sourceKind,
      repo: context.repo ?? event.repo ?? input.source.repo ?? '',
      branch: context.branch ?? event.branch ?? '',
      url: event.url ?? '',
    },
    rule: {
      id: input.rule?.id ?? 'legacy-prompt',
      eventType: input.rule?.eventType ?? event.eventType,
      intent: input.rule?.intent ?? input.prompt,
      workflowPrompt: input.rule?.workflowPrompt ?? '',
    },
  }
}

function jevQuestionsOf(input: EventDecisionInput): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {}
  for (const [id, question] of Object.entries(coreQuestionsOf(input))) {
    questions[id] = {
      type: question.type,
      instructions: question.instructions,
      ...(question.criteria !== undefined ? { criteria: question.criteria } : {}),
    }
  }
  return questions
}

function coreQuestionsOf(input: EventDecisionInput): Record<string, EventRuleQuestion> {
  const base = input.rule?.questions
  const projectCriteria = {
    ...(base?.project.criteria && !Array.isArray(base.project.criteria) ? base.project.criteria : {}),
    ...Object.fromEntries(input.projects.map(project => [project.name, `项目 ${project.name}（仓库 ${project.repo}）`])),
    unknown: '无法根据事件内容可靠识别项目归属。',
  }
  const skillCriteria = {
    ...(base?.skill?.criteria && !Array.isArray(base.skill.criteria) ? base.skill.criteria : {}),
    ...Object.fromEntries(ruleSkills(input.rule).map(skill => [skill.id, `${skill.name}：${skill.hint}`])),
    unknown: '无法确定处理方式。',
  }
  return {
    is_valid: base?.is_valid ?? {
      type: 'noul',
      instructions: '该事件是否需要处理？与规则无关的噪声回答 0。',
    },
    autorun: base?.autorun ?? {
      type: 'choice',
      instructions: '该事件是否可以自动执行？',
      criteria: { auto: '可以自动执行。', review: '需要人工 review。' },
    },
    priority: base?.priority ?? {
      type: 'score',
      instructions: '该事件有多急？',
      criteria: ['低优先级', '中优先级', '高优先级', '紧急'],
    },
    project: {
      type: 'choice',
      instructions: base?.project.instructions ?? '该事件归属于哪个项目？',
      criteria: projectCriteria,
    },
    skill: {
      type: 'choice',
      instructions: base?.skill?.instructions ?? '该事件应该用哪种处理方式？',
      criteria: skillCriteria,
    },
  }
}

function questionCatalogText(rule: EventDecisionInput['rule']): string {
  if (!rule) return '（没有规则；按事件内容判定是否处理）'
  return Object.entries(rule.questions)
    .map(([id, question]) => {
      const criteria = question.criteria && !Array.isArray(question.criteria)
        ? Object.entries(question.criteria).map(([key, value]) => `  - ${key}: ${value}`).join('\n')
        : Array.isArray(question.criteria)
          ? question.criteria.map((value: unknown, index: number) => `  - ${index}: ${value}`).join('\n')
          : ''
      return `- ${id}（${question.type}）：${question.instructions}${criteria ? `\n${criteria}` : ''}`
    })
    .join('\n')
}

function priorityCriteriaOf(input: EventDecisionInput): readonly string[] {
  const criteria = input.rule?.questions.priority.criteria
  return Array.isArray(criteria) && criteria.length > 0 ? criteria : ['低', '中', '高', '紧急']
}

function priorityFromScore(score: number, criteria: readonly string[]): EventPriority {
  const levels = priorityLevels(criteria)
  const index = Math.round(Math.min(1, Math.max(0, score)) * (criteria.length - 1))
  return levels[index] ?? 'P3'
}

function numberAnswer(answers: JevAnswers, id: string): number {
  const value = answers[id]
  return typeof value === 'number' ? value : 0
}

function stringAnswer(answers: JevAnswers, id: string): string {
  const value = answers[id]
  return typeof value === 'string' ? value : ''
}

/** 判定失败时给一条可读原因，供面板展示。 */
export function decisionErrorText(error: unknown): string {
  return `判定失败：${errorMessage(error)}`
}
