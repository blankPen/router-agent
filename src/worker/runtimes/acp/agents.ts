/**
 * ACP Agent 静态目录。
 *
 * 这里只放纯常量与纯函数，不能依赖任何 Node 内置模块 —— Web 面板会把它
 * 一起打进前端包。探测、安装、spawn 等 Node-only 逻辑放在 detect.ts / install.ts。
 */

export interface AcpAgentRequirement {
  /** 外部依赖命令，例如 codex。 */
  command: string
  label: string
  /** 最低版本；仅作提示，真正兼容性以能力探测 / 完整握手为准。 */
  minVersion?: string
  /** 能力探测参数，例如 ['app-server', '--help']；退出 0 视为具备该能力。 */
  capabilityArgs?: readonly string[]
  hint: string
}

export interface AcpAgentMeta {
  /** Agent 短 id，用于安装目录名（不能含冒号，Windows 文件名要合法）。 */
  id: string
  /** 运行时 id，写入 runtime.default / runtime.projects / runtime.options。 */
  runtimeId: string
  label: string
  hint: string
  /** PATH 上的命令名；managed 安装时也是 node_modules/.bin 下的文件名。 */
  command: string
  args: readonly string[]
  /** 可由 ra 按需安装的 npm 包；缺省表示只能由用户自行安装。 */
  package?: { name: string; version: string }
  /** npm 包（ACP 扩展）的官方页面；Web 卡片用它跳转。 */
  packageUrl?: string
  /** 底层 CLI；用于 Web 区分「安装 CLI」与「安装 ACP 扩展」。 */
  cli?: {
    command: string
    label: string
    installUrl: string
  }
  /** 工具本身支持 ACP 时的官方安装页（没有独立 ACP 扩展）。 */
  installUrl?: string
  /** 版本探测参数；默认 ['--version']。 */
  probeArgs?: readonly string[]
  /** 外部依赖检查。 */
  requires?: readonly AcpAgentRequirement[]
  /** 传给 Agent 的默认环境变量。 */
  env?: Readonly<Record<string, string>>
  /** 登录命令（交互式）；Web 只展示提示，不代跑。 */
  login?: {
    command: string
    args: readonly string[]
    hint: string
    /** 非交互登录状态检查；退出 0 视为已登录。 */
    check?: { command: string; args: readonly string[] }
  }
  /** 无法在线安装时的提示。 */
  installHint?: string
  /** 已测 / 文档声明的 session/load 能力。 */
  loadSession?: boolean
  /** L0 版本探测不足以确认 ACP 模式，需要 `ra runtime check` 完整握手。 */
  verifyRequired?: boolean
}

export const ACP_AGENTS: readonly AcpAgentMeta[] = [
  {
    id: 'claude',
    runtimeId: 'acp-claude',
    label: 'Claude Code (ACP)',
    hint: '通过 claude-agent-acp 接入，支持断线后 session/load 恢复',
    command: 'claude-agent-acp',
    args: [],
    package: { name: '@agentclientprotocol/claude-agent-acp', version: '0.101.0' },
    packageUrl: 'https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp',
    cli: {
      command: 'claude',
      label: 'Claude Code CLI',
      installUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
    },
    probeArgs: ['--version'],
    env: { CLAUDE_AGENT_ACP_PROTOCOL: 'v1' },
    login: { command: 'claude', args: [], hint: '先完成 Claude Code 登录（claude 能正常对话）' },
    loadSession: true,
  },
  {
    id: 'codex',
    runtimeId: 'acp-codex',
    label: 'Codex (ACP)',
    hint: 'baldaworks codex-acp；依赖本机 codex CLI，不支持断线恢复',
    command: 'codex-acp',
    args: ['--message-streaming'],
    package: { name: 'codex-acp', version: '1.11.0' },
    packageUrl: 'https://www.npmjs.com/package/codex-acp',
    cli: {
      command: 'codex',
      label: 'OpenAI Codex CLI',
      installUrl: 'https://github.com/openai/codex',
    },
    probeArgs: ['version'],
    requires: [
      {
        command: 'codex',
        label: 'Codex CLI',
        capabilityArgs: ['app-server', '--help'],
        hint: '需要本机安装 codex CLI，且版本包含 app-server 子命令',
      },
    ],
    login: {
      command: 'codex-acp',
      args: ['login'],
      hint: '先运行 codex-acp login',
      check: { command: 'codex', args: ['login', 'status'] },
    },
    loadSession: false,
  },
  {
    id: 'opencode',
    runtimeId: 'acp-opencode',
    label: 'OpenCode',
    hint: 'opencode acp 原生 ACP 模式',
    command: 'opencode',
    args: ['acp'],
    probeArgs: ['--version'],
    installHint: 'brew install opencode（或参考 opencode 官方安装说明）',
    installUrl: 'https://opencode.ai/docs/',
    cli: { command: 'opencode', label: 'OpenCode CLI', installUrl: 'https://opencode.ai/docs/' },
    verifyRequired: true,
    loadSession: true,
  },
  {
    id: 'gemini',
    runtimeId: 'acp-gemini',
    label: 'Gemini CLI',
    hint: 'gemini --acp 实验性 ACP 模式',
    command: 'gemini',
    args: ['--acp'],
    probeArgs: ['--version'],
    installHint: 'npm i -g @google/gemini-cli',
    installUrl: 'https://github.com/google-gemini/gemini-cli',
    cli: { command: 'gemini', label: 'Gemini CLI', installUrl: 'https://github.com/google-gemini/gemini-cli' },
    verifyRequired: true,
  },
  {
    id: 'copilot',
    runtimeId: 'acp-copilot',
    label: 'GitHub Copilot CLI',
    hint: 'copilot --acp --stdio',
    command: 'copilot',
    args: ['--acp', '--stdio'],
    probeArgs: ['--version'],
    installHint: '参考 GitHub Copilot CLI 官方安装说明',
    installUrl: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli',
    cli: {
      command: 'copilot',
      label: 'GitHub Copilot CLI',
      installUrl: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli',
    },
    verifyRequired: true,
  },
  {
    id: 'cursor',
    runtimeId: 'acp-cursor',
    label: 'Cursor CLI',
    hint: 'cursor-agent acp；旧版本可能没有 acp 子命令',
    command: 'cursor-agent',
    args: ['acp'],
    probeArgs: ['--version'],
    installHint: '升级 cursor-agent 到支持 acp 子命令的版本',
    installUrl: 'https://cursor.com/cli',
    cli: { command: 'cursor-agent', label: 'Cursor CLI', installUrl: 'https://cursor.com/cli' },
    verifyRequired: true,
  },
  {
    id: 'goose',
    runtimeId: 'acp-goose',
    label: 'Goose',
    hint: 'goose acp 原生 ACP 模式',
    command: 'goose',
    args: ['acp'],
    probeArgs: ['--version'],
    installHint: 'brew install block-goose-cli（或参考 Goose 官方安装说明）',
    installUrl: 'https://block.github.io/goose/docs/getting-started/installation',
    cli: {
      command: 'goose',
      label: 'Goose CLI',
      installUrl: 'https://block.github.io/goose/docs/getting-started/installation',
    },
    verifyRequired: true,
  },
]

/** 按 agent id 或 runtime id 查目录项。 */
export function acpAgentOf(idOrRuntimeId: string): AcpAgentMeta | undefined {
  const value = idOrRuntimeId.trim()
  return ACP_AGENTS.find(agent => agent.id === value || agent.runtimeId === value)
}

/** 是否是目录内的动态 ACP 运行时 id（不含旧的通用 `acp`）。 */
export function isAcpRuntimeId(id: string): boolean {
  const value = id.trim()
  return ACP_AGENTS.some(agent => agent.runtimeId === value)
}

/** agent id → runtime id；未知 id 返回 null。 */
export function acpRuntimeIdOf(idOrRuntimeId: string): string | null {
  return acpAgentOf(idOrRuntimeId)?.runtimeId ?? null
}