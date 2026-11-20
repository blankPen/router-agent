

import { extractJsonObject } from '../model-config.js'
import { toolSpecs } from '../diagnosis-tools.js'
import { SYMPTOMS } from './symptoms.js'

import { preview } from '#core/events.js'
import { errorMessage } from '#infra/logger.js'
import { createChatClient, type ChatClient, type ChatMessage } from '#infra/chat.js'
import type { LogEntry } from '../log-tail.js'
import type { DiagnosisTool } from '../diagnosis-tools.js'
import type { LogCause, LogDiagnosis, LogEvidence, LogNextStep } from './types.js'
import { redactFields, tokenize } from './evidence.js'

// ---------------------------------------------------------------------------
// 模型总结
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  '你是 router-agent（飞书消息 → 研判 → 派工到 worker 的双层 Agent 系统）的运维排查助手。',
  '回答的对象是普通用户，不是运维工程师：他们只知道「机器人没反应」，不知道 open_id、worktree、事件名。',
  '用户会给出相关的服务日志（每行一条 JSON 事件，事件名形如 域:动作）。',
  '请只依据给出的日志判断，不要编造日志里没有的事实；信息不足时明确说「日志里看不到」。',
  '可以调用工具查看本机的 router-agent 配置与安装目录下的代码来核实判断；工具是只读的，只能读不能改。',
  '写给用户看的话要像客服说明，不要像日志分析报告：不要出现事件名、字段名、代码标识符。',
  '输出严格的 JSON，不要加解释性文字或代码块围栏：',
  '{"summary":"一句话结论","causes":[{"title":"可能原因","detail":"为什么","events":["支撑的事件名"],"category":"config|defect"}],"actions":["建议的下一步操作"]}',
  'causes 最多 3 条，actions 最多 5 条；没有证据支撑的原因不要写。',
  'category 填 config 表示这是配置问题、用户自己能改，填 defect 表示这是缺陷或体验问题、应该上报。',
  'summary 用一句普通话说清「现在是什么情况、要不要紧」，例如「机器人收不到消息是因为允许名单里少了两个人」。',
  'causes[].title 是人话原因；causes[].detail 与 events 是补充细节，可以出现事件名。',
  'actions 每条都是用户能直接照做的动作，写清「改哪一项、去哪改」；不要写「查看日志」这种没有落点的动作。',
].join('\n')

/** 模型最多能连着调几轮工具。 */
const MAX_TOOL_ROUNDS = 6

/**
 * 让模型基于证据总结结论；解析失败会抛错，由调用方降级到规则式判断。
 *
 * 模型可以要求调用只读工具（读配置 / 读本地代码），工具结果回灌给它继续判断，
 * 最多 MAX_TOOL_ROUNDS 轮，避免无限循环。
 */
export async function askModel(
  client: ChatClient,
  question: string,
  evidence: LogEvidence[],
  tools: DiagnosisTool[] = [],
): Promise<LogDiagnosis> {
  const lines = evidence.map(item => {
    const fields = item.data ? redactFields(item.data) : (item.detail ?? '')
    return `${item.at || '-'} ${item.level.toUpperCase()} ${item.message}${fields ? ` ${fields}` : ''}`
  })
  const user = [
    `问题：${question || '（用户没有描述具体问题，请总结最近日志里最值得关注的事）'}`,
    '',
    `相关日志（共 ${lines.length} 条）：`,
    ...(lines.length > 0 ? lines : ['（没有匹配到日志条目）']),
    '',
    '已知问题模式（事件名 → 症状）：',
    ...SYMPTOMS.map(symptom => `- ${symptom.id}：${symptom.title}（相关事件：${symptom.events.slice(0, 6).join('、')}）`),
  ].join('\n')

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]
  const specs = toolSpecs(tools)
  const toolsUsed = new Set<string>()

  let raw = ''
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const turn = await client.complete(messages, specs.length > 0 ? { tools: specs } : {})
    raw = turn.content
    if (turn.toolCalls.length === 0 || tools.length === 0) break

    messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls })
    for (const call of turn.toolCalls) {
      const tool = tools.find(item => item.spec.name === call.name)
      const output = tool
        ? safeRunTool(tool, call.arguments)
        : `没有这个工具：${call.name}。可用工具：${tools.map(item => item.spec.name).join('、')}。`
      toolsUsed.add(call.name)
      messages.push({ role: 'tool', content: output, toolCallId: call.id })
    }
    if (round === MAX_TOOL_ROUNDS) break
  }

  const parsed = extractJsonObject(raw)
  if (!parsed) throw new Error('assistant:model-invalid-json')

  const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
    ? parsed.summary.trim()
    : '模型没有给出结论摘要。'
  const causes = Array.isArray(parsed.causes)
    ? parsed.causes.slice(0, 3).map(item => {
      const record = (item ?? {}) as Record<string, unknown>
      const category: 'config' | 'defect' | undefined =
        record.category === 'config' || record.category === 'defect' ? record.category : undefined
      return {
        title: String(record.title ?? '可能原因'),
        detail: String(record.detail ?? ''),
        events: Array.isArray(record.events) ? (record.events as unknown[]).map(event => String(event)) : [],
        ...(category ? { category } : {}),
      }
    })
    : []
  const actions = Array.isArray(parsed.actions)
    ? parsed.actions.slice(0, 5).map(item => String(item))
    : []

  const next = nextStepsFromCauses(causes)

  return {
    summary,
    causes,
    actions,
    evidence,
    source: 'llm',
    ...(toolsUsed.size > 0 ? { toolsUsed: [...toolsUsed] } : {}),
    ...(next.length > 0 ? { next } : {}),
  }
}

/**
 * 由模型给出的处置分类推导按钮。
 *
 * 模型给 causes 标了 config / defect 时，页面才有「去改配置」或「上报 issue」的入口；
 * 没标就不硬塞按钮，避免给错方向。
 *
 * 分类不一致时两个入口都给：只看第一条的话，排在后面的缺陷会被吞掉，
 * 用户想反馈问题时页面上找不到上报入口。
 */
export function nextStepsFromCauses(causes: LogCause[]): LogNextStep[] {
  // 与规则式排查一致：只按最可能的那条原因给动作。
  const primary = causes.find(cause => cause.category)
  if (!primary?.category) return []
  const steps: LogNextStep[] = []
  if (primary.category === 'config') {
    steps.push({ kind: 'config', label: '去「配置」页按建议修改' })
    // 还有缺陷类原因就一并给上报入口，别让缺陷被配置引导挡住。
    if (causes.some(cause => cause.category === 'defect')) {
      steps.push({ kind: 'issue', label: '上报 GitHub issue' })
    }
    return steps
  }
  steps.push({ kind: 'issue', label: '上报 GitHub issue' })
  return steps
}

/** 工具执行出错不该拖垮整次排查：把错误当工具结果回给模型。 */
function safeRunTool(tool: DiagnosisTool, args: Record<string, unknown>): string {
  try {
    return tool.run(args)
  } catch (error) {
    return `工具执行失败：${error instanceof Error ? error.message : String(error)}`
  }
}
