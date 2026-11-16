/**
 * 决策模型的两种接入方式：Jev（打分式）与 LLM（JSON 结论式）。
 *
 * 两者的判定依据都是面板上可配置的决策 prompt，输出都要落回闭集：
 * 候选项目与候选 skill 由宿主给出，模型只能从中选。
 */
import type { EventPriority } from '#core/event.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import type { ChatClient } from '#infra/chat.js'
import { JevClient, type JevQuestion } from '#infra/decision/jev-client.js'
import { extractJsonObject } from '../router/model-config.js'
import type { EventDecisionInput, EventDecisionOutput, EventDecisionPort } from './decision.js'
import { skillCatalogText } from './skills.js'

/** 优先级档位：Jev 用 score 打分，顺序从低到高。 */
const PRIORITY_CRITERIA = ['P4', 'P3', 'P2', 'P1', 'P0']

/** Jev 里选中某个项目 / skill 所需的最低分；低于它当作没选出来。 */
const JEV_PICK_THRESHOLD = 0.4

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
      return {
        actionable: parsed.actionable !== false,
        ...(parsed.priority ? { priority: String(parsed.priority).toUpperCase() as EventPriority } : {}),
        ...(parsed.type ? { eventType: String(parsed.type) } : {}),
        ...(parsed.project ? { project: String(parsed.project) } : {}),
        ...(parsed.skill ? { skill: String(parsed.skill) } : {}),
        ...(typeof parsed.needsReview === 'boolean' ? { needsReview: parsed.needsReview } : {}),
        ...(parsed.reason ? { reason: String(parsed.reason) } : {}),
        ...(typeof parsed.confidence === 'number' ? { confidence: parsed.confidence } : {}),
      }
    },
  }
}

/** Jev 判定端口：用打分问题分别问「要不要做 / 多急 / 归哪个项目 / 用哪个 skill」。 */
export function createJevDecisionPort(client: JevClient, deps: { logger?: Logger } = {}): EventDecisionPort {
  const logger = deps.logger ?? noopLogger
  return {
    name: 'jev',
    async decide(input: EventDecisionInput): Promise<EventDecisionOutput | null> {
      const questions: Record<string, JevQuestion> = {
        actionable: { type: 'noul', instructions: '这个事件是否需要处理？与项目无关的噪声回答 0。' },
        priority: { type: 'score', instructions: '这个事件有多急？', criteria: PRIORITY_CRITERIA },
        needsReview: { type: 'noul', instructions: '这个事件是否需要人工先看一眼再动手？高风险、信息不足或归属不明时回答 1。' },
      }
      for (const project of input.projects) {
        questions[`project:${project.name}`] = {
          type: 'noul',
          instructions: `这个事件是否属于项目「${project.name}」？`,
        }
      }
      for (const skill of input.skills) {
        questions[`skill:${skill.id}`] = {
          type: 'noul',
          instructions: `这个事件是否应该用处理方式「${skill.id}」？`,
        }
      }
      const answers = await client.ask(stateOf(input), questions)
      const priority = priorityFromScore(answers.priority)
      const project = pickBest(answers, input.projects.map(item => `project:${item.name}`))
      const skill = pickBest(answers, input.skills.map(item => `skill:${item.id}`))
      const confidence = Math.max(project.score, skill.score, 0)
      return {
        actionable: (answers.actionable ?? 0) >= 0.5,
        priority,
        eventType: input.source.defaultType ?? '',
        ...(project.key ? { project: project.key.replace(/^project:/, '') } : {}),
        ...(skill.key ? { skill: skill.key.replace(/^skill:/, '') } : {}),
        needsReview: (answers.needsReview ?? 0) >= 0.5,
        reason: 'Jev 打分判定',
        confidence,
      }
    },
  }
}

/** LLM 的系统提示词：判定规则 + 输出格式 + 候选闭集。 */
export function systemPromptOf(input: EventDecisionInput): string {
  const projects = input.projects.length
    ? input.projects.map(project => `- ${project.name}（仓库 ${project.repo}）`).join('\n')
    : '（没有候选项目；判定不出归属时直接标 needsReview）'
  return [
    '你是事件总线里的决策模型。一次判定要同时给出：要不要处理、优先级、事件类型、归属项目、执行方式（skill）、要不要人工审核。',
    '',
    '# 判定规则（人工可配置）',
    input.prompt,
    '',
    '# 候选项目（只能从中选）',
    projects,
    '',
    '# 候选处理方式（只能从中选）',
    skillCatalogText(input.skills),
    '',
    '# 输出格式',
    '只输出一个 JSON 对象，不要解释：',
    '{"actionable":true,"priority":"P1","type":"bug","project":"项目名","skill":"skill-id","needsReview":false,"reason":"一句话理由","confidence":0.9}',
    '拿不准时把 confidence 调低并把 needsReview 设为 true；不要编造候选清单以外的项目或 skill。',
  ].join('\n')
}

/** LLM 的用户提示词：事件本身与来源信息。 */
export function userPromptOf(input: EventDecisionInput): string {
  const event = input.event
  const context = input.source.repo ? `订阅的仓库：${input.source.repo}` : ''
  return [
    `# 事件标题\n${event.title}`,
    `# 事件正文\n${event.body || '(空)'}`,
    `# 来源\n${event.sourceId}（${event.sourceKind}）`,
    context ? `# 来源信息\n${context}` : '',
    '# 判定规则（人工可配置）',
    input.prompt,
  ].filter(Boolean).join('\n\n')
}

/** Jev 的 state：事件内容 + 判定规则 + 候选清单。 */
function stateOf(input: EventDecisionInput): unknown {
  return {
    title: input.event.title,
    body: input.event.body,
    source: input.event.sourceKind,
    rules: input.prompt,
    projects: input.projects.map(project => project.name),
    skills: input.skills.map(skill => skill.id),
  }
}

/** 把 Jev 的分数还原成优先级档位。 */
function priorityFromScore(score: number | undefined): EventPriority {
  if (typeof score !== 'number') return 'P3'
  const index = Math.round(Math.min(1, Math.max(0, score)) * (PRIORITY_CRITERIA.length - 1))
  return PRIORITY_CRITERIA[index] as EventPriority
}

/** 在候选键里挑分数最高的一个；低于阈值当作没选出来。 */
function pickBest(answers: Record<string, number>, keys: string[]): { key: string; score: number } {
  let best = { key: '', score: 0 }
  for (const key of keys) {
    const score = answers[key] ?? 0
    if (score > best.score) best = { key, score }
  }
  return best.score >= JEV_PICK_THRESHOLD ? best : { key: '', score: best.score }
}

/** 判定失败时给一条可读原因，供面板展示。 */
export function decisionErrorText(error: unknown): string {
  return `判定失败：${errorMessage(error)}`
}
