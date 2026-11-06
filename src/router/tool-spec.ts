import { Type, type TSchema } from 'typebox'

/**
 * 研判工具的单一事实来源。
 *
 * 只有三个工具：读上下文、查工单、给决定。
 * 不给 shell / 文件 / MCP / 通用 coding skills —— 研判层的价值是判断，不是执行。
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
    name: 'router_ticket',
    description: '查询工单：给 ticket_id 取详情，或按 stage 列表。',
    parameters: Type.Object({
      ticket_id: Type.Optional(Type.String()),
      stage: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
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
]

export const DECISION_TOOL_NAMES = ['router_read', 'router_ticket', 'router_decide'] as const

export function toolSpec(name: string): RouterToolSpec {
  const spec = ROUTER_TOOL_SPECS.find(item => item.name === name)
  if (!spec) throw new Error(`tool:not-found:${name}`)
  return spec
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