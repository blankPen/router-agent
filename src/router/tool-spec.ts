import { Type, type TSchema } from 'typebox'
import { STAGE_VALUES } from '../core/stage.js'

/**
 * 研判工具的单一事实来源。
 *
 * 工具分三类：读上下文（router_read / router_ticket）、查工单（list / progress）、
 * 清理工单（close / workspace_remove），以及最终的决定（router_decide）。
 * 仍然不给 shell / 文件 / MCP / 通用 coding skills —— 研判层的价值是判断与运维，
 * 不是执行；写操作只允许关单和回收 workspace，且必须经过 Engine 与 Effects 队列。
 */
export interface RouterToolSpec {
  name: string
  description: string
  parameters: TSchema
}

const stringEnum = (values: string[]): TSchema => Type.Unsafe({ type: 'string', enum: values })

const STAGES = [...STAGE_VALUES]

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
    description: '查询工单：给 ticket_id 取详情，或按 stage 列表。列表查询建议用 router_ticket_list。',
    parameters: Type.Object({
      ticket_id: Type.Optional(Type.String()),
      stage: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
  },
  {
    name: 'router_ticket_list',
    description: '查询工单列表：可按阶段、会话（chat_id）、关键词（标题或工单 ID）过滤，按创建时间倒序。',
    parameters: Type.Object({
      stage: Type.Optional(stringEnum(STAGES)),
      chat_id: Type.Optional(Type.String({ description: '只查某个飞书会话里的工单' })),
      keyword: Type.Optional(Type.String({ description: '标题或工单 ID 的关键词，不区分大小写' })),
      limit: Type.Optional(Type.Number({ description: '最多返回多少条，默认 20，上限 50' })),
    }),
  },
  {
    name: 'router_ticket_progress',
    description: '查询一张工单的进展：当前阶段、最近上报、待答问题、PR、workspace 与未处理输入。',
    parameters: Type.Object({
      ticket_id: Type.String({ description: '工单 ID，例如 tk-8' }),
    }),
  },
  {
    name: 'router_ticket_close',
    description: '关闭一张工单，默认同时回收它的 workspace（停终端、删 worktree）。PR 仍开着时会被拒绝，除非 force=true。',
    parameters: Type.Object({
      ticket_id: Type.String({ description: '要关闭的工单 ID' }),
      reason: Type.String({ description: '关单原因，写给人看' }),
      force: Type.Optional(Type.Boolean({ description: 'PR 还开着时也强制关闭；只有用户明确确认才传' })),
      remove_workspace: Type.Optional(Type.Boolean({ description: '是否同时回收 workspace，默认 true' })),
    }),
  },
  {
    name: 'router_workspace_remove',
    description: '只回收一张已关闭工单的 workspace（停终端、删 worktree），不改变工单状态。',
    parameters: Type.Object({
      ticket_id: Type.String({ description: '已关闭的工单 ID' }),
      reason: Type.Optional(Type.String({ description: '回收原因' })),
    }),
  },
  {
    name: 'router_update',
    description:
      '检查 router-agent 的 npm 最新版本；不传 check 时会安装最新版，并在本轮回复后自动重启整个服务。'
      + '只有用户明确要求「更新版本 / 升级 ra / 检查有没有新版」时才调用，不要主动升级。',
    parameters: Type.Object({
      check: Type.Optional(Type.Boolean({ description: '只检查是否有新版本，不安装也不重启，默认 false' })),
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

export const DECISION_TOOL_NAMES = [
  'router_read',
  'router_ticket',
  'router_ticket_list',
  'router_ticket_progress',
  'router_ticket_close',
  'router_workspace_remove',
  'router_update',
  'router_decide',
] as const

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
