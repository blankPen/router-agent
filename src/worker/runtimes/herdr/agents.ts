/**
 * Herdr 支持的 Agent kind 与「无人值守」启动参数。
 *
 * 这里只放纯常量与纯函数，不能依赖任何 Node 内置模块 —— Web 面板会把它一起打进前端包。
 */

export interface HerdrAgentKind {
  /** Herdr 的 --kind 取值。 */
  value: string
  label: string
  /** 无人值守所需的启动参数：Worker 开工时没有人点确认。 */
  args: string[]
  /** 模型参数怎么传；不同 CLI 不一样。 */
  modelFlag?: string
}

/**
 * ra 支持的 Herdr Agent kind。
 *
 * 只列 ra 自己有会话读取器、或已验证过无人值守参数的 Agent；
 * Herdr 自己支持更多 kind（见 `herdr agent start --help`），但 ra 读不回它们的会话。
 */
export const HERDR_AGENT_KINDS: readonly HerdrAgentKind[] = [
  {
    value: 'claude',
    label: 'claude · Claude Code',
    // Claude Code 在新目录首次启动会弹「是否信任此文件夹」；跳过权限确认会一并跳过它，
    // 否则 Herdr 把这个弹窗识别成 blocked，`agent start` 直接以 agent_not_ready 失败。
    args: ['--dangerously-skip-permissions'],
    modelFlag: '--model',
  },
  {
    value: 'codex',
    label: 'codex · Codex',
    args: ['--dangerously-bypass-approvals-and-sandbox'],
    modelFlag: '--model',
  },
  {
    value: 'opencode',
    label: 'opencode · OpenCode',
    args: ['--auto'],
    modelFlag: '--model',
  },
]

export function herdrAgentKindOf(kind: string): HerdrAgentKind | undefined {
  const value = String(kind ?? '').trim()
  return HERDR_AGENT_KINDS.find(item => item.value === value)
}
