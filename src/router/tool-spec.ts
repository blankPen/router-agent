import { Type, type TSchema } from 'typebox'
import type { LlmToolSchema } from './llm.js'

/**
 * 研判工具的单一事实来源。
 *
 * TypeBox schema 本身是标准 JSON Schema，可直接给 OpenAI 兼容接口，
 * 也可以交给 Pi 的 customTools；避免维护两份工具定义。
 */
export interface RouterToolSpec {
  name: string
  description: string
  parameters: TSchema
}

const stringEnum = (values: string[]): TSchema => Type.Unsafe({ type: 'string', enum: values })

export const ROUTER_TOOL_SPECS: RouterToolSpec[] = [
  {
    name: 'router_read',
    description: '读取一条 Trigger、它的 Thread 上下文，或某个工单的完整状态。做决定前可先调用。',
    parameters: Type.Object({
      trigger_id: Type.Optional(Type.String({ description: '要读取的 Trigger ID' })),
      ticket_id: Type.Optional(Type.String({ description: '要读取的工单 ID' })),
      thread_id: Type.Optional(Type.String({ description: '要读取的线程 ID' })),
    }),
  },
  {
    name: 'router_decide',
    description: '对一条 Trigger 给出决定。accept 会创建工单并派工；ignore 表示不需要开工；unavailable 表示研判没完成。',
    parameters: Type.Object({
      trigger_id: Type.String(),
      decision: stringEnum(['accept', 'stop', 'ignore', 'unavailable']),
      strength: Type.Optional(stringEnum(['explicit', 'inferred'])),
      reason: Type.String({ description: '一句话理由，写给人看' }),
      title: Type.Optional(Type.String({ description: 'accept 时工单标题' })),
      scope: Type.Optional(Type.String({ description: 'accept 时授权范围，说明允许改什么、不允许改什么' })),
      repo: Type.Optional(Type.String({ description: 'accept 时必填：项目名或仓库选择器。判断不了就留空，系统会替你追问用户' })),
      branch: Type.Optional(Type.String({ description: 'accept 时必填：worktree 的起始分支。判断不了就留空，系统会替你追问用户' })),
      rules: Type.Optional(Type.Array(Type.String(), { description: '命中的策略规则名' })),
    }),
  },
  {
    name: 'router_reply',
    description: '回到飞书会话里说一句话。只用于 ack 与最终通知，不要闲聊。',
    parameters: Type.Object({
      chat_id: Type.String(),
      thread_id: Type.Optional(Type.String({ description: '根消息 ID，用于话题回复' })),
      text: Type.String(),
    }),
  },
  {
    name: 'router_ticket',
    description: '查询工单：给 ticket_id 取详情，或按 stage 列表。',
    parameters: Type.Object({
      ticket_id: Type.Optional(Type.String()),
      stage: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
  },
  {
    name: 'router_subscribe',
    description: '订阅或退订一个 Thread。订阅后该线程的新消息直接作为上下文投给工单，不再经过研判。',
    parameters: Type.Object({
      thread_id: Type.String(),
      ticket_id: Type.String(),
      action: stringEnum(['subscribe', 'unsubscribe']),
      context_only: Type.Optional(Type.Boolean()),
    }),
  },
]

/** 研判层的工具白名单：只读上下文 + 给出决定，不给 shell / 文件 / MCP。 */
export const DECISION_TOOL_NAMES = ['router_read', 'router_ticket', 'router_decide'] as const

export function toolSpec(name: string): RouterToolSpec {
  const spec = ROUTER_TOOL_SPECS.find(item => item.name === name)
  if (!spec) throw new Error(`tool:not-found:${name}`)
  return spec
}

export function toOpenAiTool(spec: RouterToolSpec): LlmToolSchema {
  return {
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters as unknown as Record<string, unknown>,
    },
  }
}

/** 交给 Pi 的 customTools（ToolDefinition 的最小结构，不依赖 Pi 运行时类型）。 */
export interface PiToolDefinition {
  name: string
  label: string
  description: string
  parameters: TSchema
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<{ content: { type: 'text'; text: string }[]; details?: Record<string, unknown> }>
}
