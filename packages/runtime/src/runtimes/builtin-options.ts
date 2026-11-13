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

export const T3CODE_OPTION_SPEC: RuntimeOptionSpec = {
  runtimeId: 't3code',
  fields: [
    {
      key: 'command',
      label: 'T3 CLI',
      kind: 'text',
      default: 't3',
      placeholder: 't3',
      hint: 'T3 Code 命令行入口；默认 t3',
    },
    {
      key: 'provider',
      label: 'Provider',
      kind: 'text',
      placeholder: 'codex',
      hint: 'T3 的 provider 实例 id，例如 codex / claude；留空则用 T3 项目的默认模型',
    },
    {
      key: 'model',
      label: '模型',
      kind: 'text',
      placeholder: '留空则用 provider 的默认模型',
      hint: '传给 T3 的模型名；ra 建的项目没有默认模型，一般要连 provider 一起填',
    },
    {
      key: 'baseDir',
      label: '数据目录',
      kind: 'text',
      placeholder: '留空用 T3 默认目录（~/.t3）',
      hint: 'T3 Code 数据目录，等价 T3CODE_HOME',
    },
  ],
}
