/**
 * Herdr 运行时的可配置项声明。
 *
 * 只放纯常量（面板会把它打进前端包）。这里声明的是「ra 允许覆盖什么」，
 * 具体的命令行参数由 Herdr adapter 自己映射，声明本身不含任何 Herdr 逻辑。
 */
import { HERDR_RUNTIME_ID } from '../catalog.js'
import { HERDR_AGENT_KINDS } from './agents.js'
import type { RuntimeOptionSpec } from '../options.js'

export const HERDR_OPTION_SPEC: RuntimeOptionSpec = {
  runtimeId: HERDR_RUNTIME_ID,
  fields: [
    {
      key: 'agent',
      label: '执行 Agent',
      kind: 'select',
      default: 'claude',
      options: HERDR_AGENT_KINDS.map(kind => ({ value: kind.value, label: kind.label })),
      hint: 'Herdr 在工单 worktree 里启动哪个 Agent；默认 Claude Code',
    },
    {
      key: 'model',
      label: '模型',
      kind: 'text',
      placeholder: '留空则用 Agent 自己的默认模型',
      hint: '传给 Agent 的模型名；不同 Agent 的参数名由 adapter 自己映射',
    },
  ],
}
