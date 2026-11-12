import type { RuntimeOptionSpec } from './options.js'

export const ORCA_OPTION_SPEC: RuntimeOptionSpec = {
  runtimeId: 'orca',
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

export const HERDR_OPTION_SPEC: RuntimeOptionSpec = {
  runtimeId: 'herdr',
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
      ],
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
