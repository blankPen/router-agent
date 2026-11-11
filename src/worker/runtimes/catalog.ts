/**
 * Worker 运行时清单：配置校验、Web 面板下拉、CLI 提示共用这一份。
 *
 * 这里只放纯常量，不能依赖任何 Node 内置模块 —— Web 面板会把它一起打进前端包。
 */
import { ACP_AGENTS } from './acp/agents.js'

export const ORCA_RUNTIME_ID = 'orca'
export const CLAUDE_CODE_RUNTIME_ID = 'claude-code'
export const ACP_RUNTIME_ID = 'acp'
export const CODEX_APP_RUNTIME_ID = 'codex-app'

export interface WorkerRuntimeMeta {
  id: string
  /** 产品名（自然大小写）；Web 面板按首字母大写展示，CLI 与文档保持原样。 */
  name: string
  label: string
  hint: string
  /** 不能由 ra 自动安装时的界面引导文案。 */
  installHint?: string
  /** CLI 的官方安装/下载页；Web 卡片直接跳转，不再展示易变的安装命令。 */
  installUrl?: string
}

export const WORKER_RUNTIMES: readonly WorkerRuntimeMeta[] = [
  {
    id: ORCA_RUNTIME_ID,
    name: 'Orca',
    label: 'orca · Orca worktree + 终端',
    hint: '通过 Orca 创建 worktree 并启动 Agent 终端（默认跟随 Orca 配置），交互与状态读取走 Orca',
    installHint: '从 Orca 官方发布页下载安装，并确保 orca CLI 在 PATH 中',
    installUrl: 'https://github.com/stablyai/orca/releases',
  },
  {
    id: CLAUDE_CODE_RUNTIME_ID,
    name: 'Claude Code',
    label: 'claude-code · git worktree + claude --bg',
    hint: '直接调用 Claude Code CLI 的后台会话；项目 repo 需要填本地仓库绝对路径',
    installHint: '参考 Claude Code 官方安装说明',
    installUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
  },
  {
    id: CODEX_APP_RUNTIME_ID,
    name: 'Codex App',
    label: 'codex-app · Codex App Server',
    hint: '直连 Codex App Server；优先使用 Codex App 内置 CLI，桌面端可见同一 thread',
    installHint: '安装 Codex App（macOS/Windows）或 Codex CLI；ra 会优先使用 Codex App 内置的版本',
    installUrl: 'https://chatgpt.com/codex',
  },
  {
    id: ACP_RUNTIME_ID,
    name: 'ACP',
    label: 'acp · 任意 ACP Agent',
    hint: '通过 ACP 协议接入其它 Agent；启用前需要在 runtime.options.acp 配置 command',
    installHint: '在 config.yaml 的 runtime.options.acp 下配置 command 与 args，然后重启服务',
  },
]

export const WORKER_RUNTIME_IDS: readonly string[] = WORKER_RUNTIMES.map(runtime => runtime.id)

/** 兼容旧配置与旧工单：claude-cli 已改名为 claude-code。 */
export const LEGACY_CLAUDE_CODE_RUNTIME_ID = 'claude-cli'

export const LEGACY_RUNTIME_IDS: Readonly<Record<string, string>> = {
  [LEGACY_CLAUDE_CODE_RUNTIME_ID]: CLAUDE_CODE_RUNTIME_ID,
}

/** 把历史 runtime id 归一成当前 id；未知 id 原样返回，交给注册表报错。 */
export function normalizeRuntimeId(id: string): string {
  const value = id.trim()
  return LEGACY_RUNTIME_IDS[value] ?? value
}

/**
 * 是否是已知的 worker runtime id。
 *
 * 包含内置运行时（orca / claude-code / codex-app / acp）和 ACP 目录里的动态运行时
 * （acp-claude / acp-codex / ...）。未知值让配置校验直接拒绝，避免拼错后
 * 启动期才炸。
 */
export function isWorkerRuntimeId(id: string): boolean {
  const value = normalizeRuntimeId(id)
  return WORKER_RUNTIME_IDS.includes(value) || ACP_AGENTS.some(agent => agent.runtimeId === value)
}
