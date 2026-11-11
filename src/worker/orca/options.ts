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
 * 留空表示不传 `--agent`，由 Orca 自己的配置决定用哪个 Agent。
 */
export const ORCA_OPTION_SPEC: RuntimeOptionSpec = {
  runtimeId: ORCA_RUNTIME_ID,
  fields: [
    {
      key: 'agent',
      label: '执行 Agent',
      kind: 'select',
      options: [
        { value: '', label: '跟随 Orca 默认', hint: '不传 --agent，用 Orca 自己配置的 Agent' },
        { value: 'claude', label: 'claude · Claude Code' },
        { value: 'codex', label: 'codex · Codex' },
        { value: 'opencode', label: 'opencode · OpenCode' },
        { value: 'devin', label: 'devin · Devin' },
        { value: 'antigravity', label: 'antigravity · Antigravity' },
      ],
      hint: 'Orca 在工单 worktree 里启动哪个 Agent；留空 = 用 Orca 自己配置的默认 Agent',
      emptyHint: '跟随 Orca 默认',
    },
  ],
}
