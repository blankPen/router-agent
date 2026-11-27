/**
 * 决策模型的两种接入方式：Jev（结构化问题）与 LLM（JSON 结论式）。
 *
 * 判定依据是命中的订阅：订阅里的语义过滤条件是模型要回答的问题，
 * state 在判定时把事件现场与订阅上下文拼出来。
 * 模型只能从宿主给出的项目 / skill 闭集里选，不能凭空造。
 */
import type { EventPriority } from '#core/event.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import type { ChatClient } from '#infra/chat.js'
import { JevClient, type JevQuestion, type JevAnswers } from '#infra/decision/jev-client.js'
import { extractJsonObject } from '../router/model-config.js'
import type { EventDecisionInput, EventDecisionOutput, EventDecisionPort } from './decision.js'
import { EVENT_SKILLS, skillCatalogText } from './skills.js'

/** Jev / LLM 的问题骨架：类型与规则无关，只看订阅的语义条件。 */
interface DecisionQuestion {
  type: 'noul' | 'score' | 'choice'
  instructions: string
  criteria?: string[] | Record<string, string>
}

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
        logger.warn('event:jev-failed', { eventId: input.event.id, subscriptionId: input.subscription?.id, message: errorMessage(error) })
        throw error
      }
      const isValid = numberAnswer(answers, 'is_valid')
      const threshold = input.decision.confidenceThreshold
      const valid = isValid >= threshold
      const autorun = stringAnswer(answers, 'autorun')
      const priority = priorityFromScore(numberAnswer(answers, 'priority'), priorityCriteriaOf(input))
      const project = stringAnswer(answers, 'project')
      const skill = stringAnswer(answers, 'skill')
      const projectName = project && project !== 'unknown' ? project : ''
      const skillId = skill && skill !== 'unknown' ? skill : ''
      const confidence = valid ? Math.min(isValid, projectName ? 1 : 0.4) : isValid
      return {
        actionable: valid,
        priority,
        eventType: input.event.eventType || '',
        ...(projectName ? { project: projectName } : {}),
        ...(skillId ? { skill: skillId } : {}),
        needsReview: valid && autorun !== 'auto',
        reason: 'Jev 判定',
        confidence,
      }
    },
  }
}

/** LLM 的系统提示词：规则问题 + 输出格式 + 候选闭集。 */
export function systemPromptOf(input: EventDecisionInput): string {
  const subscription = input.subscription
  const projects = input.projects.length
    ? input.projects.map(project => `- ${project.name}（仓库 ${project.repo}）`).join('\n')
    : '（没有候选项目；判定不出归属时把 project 设为 unknown，并标 autorun=review）'
  const skills = EVENT_SKILLS
  return [
    '你是事件总线里的决策模型。一次判定要同时回答：事件是否有效、能否自动执行、优先级、归属项目，以及可选的处理方式。',
    '',
    '# 订阅意图（用户用自然语言写的过滤条件）',
    subscription?.filter.semantic || '（没有语义过滤条件；按事件内容判断是否值得处理）',
    subscription?.filter.keywords.length
      ? `\n已命中的关键词：${subscription.filter.keywords.join('、')}`
      : '',
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
    subscription?.project ? `订阅已经指定归属项目「${subscription.project}」，不要改写它。` : '',
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

/** Jev 的 state：背景、事件参数与订阅上下文；保存时不生成，判定时拼接。 */
export function stateOf(input: EventDecisionInput): {
  background: string
  payload: Record<string, string>
  subscription: { id: string; taskName: string; types: string[]; semantic: string; workflowPrompt: string }
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
    subscription: {
      id: input.subscription?.id ?? '',
      taskName: input.subscription?.taskName ?? '',
      types: input.subscription?.types ?? [],
      semantic: input.subscription?.filter.semantic ?? '',
      workflowPrompt: input.subscription?.prompt ?? '',
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

function coreQuestionsOf(input: EventDecisionInput): Record<string, DecisionQuestion> {
  const semantic = input.subscription?.filter.semantic ?? ''
  const projectCriteria = {
    ...Object.fromEntries(input.projects.map(project => [project.name, `项目 ${project.name}（仓库 ${project.repo}）`])),
    unknown: '无法根据事件内容可靠识别项目归属。',
  }
  const skillCriteria = {
    ...Object.fromEntries(EVENT_SKILLS.map(skill => [skill.id, `${skill.name}：${skill.hint}`])),
    unknown: '无法确定处理方式。',
  }
  return {
    is_valid: {
      type: 'noul',
      instructions: semantic
        ? `该事件是否符合订阅的过滤条件「${semantic}」？不符合回答 0。`
        : '该事件是否需要处理？无关的噪声回答 0。',
    },
    autorun: {
      type: 'choice',
      instructions: '该事件是否可以自动执行？',
      criteria: { auto: '可以自动执行。', review: '需要人工 review。' },
    },
    priority: {
      type: 'score',
      instructions: '该事件有多急？',
      criteria: ['低优先级', '中优先级', '高优先级', '紧急'],
    },
    project: {
      type: 'choice',
      instructions: '该事件归属于哪个项目？',
      criteria: projectCriteria,
    },
    skill: {
      type: 'choice',
      instructions: '该事件应该用哪种处理方式？',
      criteria: skillCriteria,
    },
  }
}

function priorityCriteriaOf(input: EventDecisionInput): readonly string[] {
  return ['低', '中', '高', '紧急']
}

function priorityFromScore(score: number, criteria: readonly string[]): EventPriority {
  // 分数从低到高对应 P4 → P1；与全局优先级的语义一致。
  const levels: EventPriority[] = ['P4', 'P3', 'P2', 'P1']
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
