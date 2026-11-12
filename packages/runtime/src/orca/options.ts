/**
 * Orca 运行时的可配置项声明。
 *
 * 只放纯常量（面板会把它打进前端包）。这里声明的是「ra 允许覆盖什么」，
 * 具体的命令行参数由 Orca adapter 自己映射，声明本身不含任何 Orca 逻辑。
 */
import { ORCA_RUNTIME_ID } from '../runtimes/catalog.js'
import type { RuntimeOptionSpec } from '../runtimes/options.js'

/**
 * Orca 支持的 TUI Agent（与 `orca agent-context` 里的 `--agent` 取值一致）。
 *
 * Orca 的 `worktree create --prompt` 必须同时给 `--agent`，没有「不传」这种形态，
 * 所以这里给一个显式默认值；用户可以覆盖成其它 Agent。
 */
export const ORCA_OPTION_SPEC: RuntimeOptionSpec = {
  runtimeId: ORCA_RUNTIME_ID,
  fields: [
    {
      key: 'agent',
      label: '执行 Agent',
      kind: 'select',
      default: 'claude',
      options: [
        { value: 'claude', label: 'claude · Claude Code' },
        { value: 'codex', label: 'codex · Codex' },
        { value: 'opencode', label: 'opencode · OpenCode' },
        { value: 'devin', label: 'devin · Devin' },
        { value: 'antigravity', label: 'antigravity · Antigravity' },
      ],
      hint: 'Orca 在工单 worktree 里启动哪个 Agent；默认 Claude Code',
    },
  ],
}
