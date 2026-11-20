/**
 * 把用户自然语言提炼成可编辑的规则草稿。
 *
 * LLM 只负责补 instructions / workflowPrompt；固定四问骨架与闭集由宿主定型。
 * 模型不可用时直接返回模板，用户仍可手工填写。
 */
import type { ChatClient } from '#infra/chat.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import { extractJsonObject } from '../router/model-config.js'
import { compileRuleTemplate, validateEventRule, type EventRule } from './rules.js'

export interface RuleCompileInput {
  id: string
  eventType: string
  intent: string
  workflowPrompt?: string
}

export interface RuleCompileDeps {
  client?: ChatClient | null
  logger?: Logger
}

/** 提炼规则草稿；任何解析失败都降级成内置模板。 */
export async function compileEventRule(input: RuleCompileInput, deps: RuleCompileDeps = {}): Promise<EventRule> {
  const logger = deps.logger ?? noopLogger
  const fallback = compileRuleTemplate({
    id: input.id,
    eventType: input.eventType,
    intent: input.intent,
    workflowPrompt: input.workflowPrompt,
  })
  if (!deps.client) return fallback
  try {
    const turn = await deps.client.complete([
      {
        role: 'system',
        content: [
          '你把用户的自然语言事件处理意图整理成可编辑的决策规则草稿。',
          '不要改变问题的固定语义：is_valid=是否属于该类事件且需要处理；autorun=能否自动执行；priority=优先级；project=归属项目。',
          '只输出一个 JSON 对象，不要解释：',
          '{"workflowPrompt":"给 Worker 的执行流程","is_valid":"有效性判定说明","autorun":"自动执行判定说明","auto":"可以自动执行的说明","review":"需要人工审核的说明","priority":"优先级判定说明"}',
          '保留用户原话里的业务约束；不要编造项目、仓库或敏感操作。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `事件类型：${input.eventType}\n用户意图：${input.intent}\n已有执行流程：${input.workflowPrompt ?? ''}`,
      },
    ])
    const parsed = extractJsonObject(turn.content)
    if (!parsed) throw new Error('rule-compile:unparsable')
    const workflowPrompt = textOf(parsed.workflowPrompt) || fallback.workflowPrompt
    const auto = textOf(parsed.auto) || String((fallback.questions.autorun.criteria as Record<string, string>).auto)
    const review = textOf(parsed.review) || String((fallback.questions.autorun.criteria as Record<string, string>).review)
    const validated = validateEventRule({
      ...fallback,
      workflowPrompt,
      questions: {
        ...fallback.questions,
        is_valid: {
          ...fallback.questions.is_valid,
          instructions: textOf(parsed.is_valid) || fallback.questions.is_valid.instructions,
        },
        autorun: {
          ...fallback.questions.autorun,
          instructions: textOf(parsed.autorun) || fallback.questions.autorun.instructions,
          criteria: { auto, review },
        },
        priority: {
          ...fallback.questions.priority,
          instructions: textOf(parsed.priority) || fallback.questions.priority.instructions,
        },
      },
    })
    if (validated.error) throw new Error(validated.error)
    logger.info('event:rule-compiled', { ruleId: input.id, eventType: input.eventType })
    return validated.value
  } catch (error) {
    logger.warn('event:rule-compile-failed', { ruleId: input.id, detail: errorMessage(error) })
    return fallback
  }
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
