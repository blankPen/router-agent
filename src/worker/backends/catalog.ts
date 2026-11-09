/**
 * Worker 后端清单：配置校验、Web 面板下拉、CLI 提示共用这一份。
 *
 * 这里只放纯常量，不能依赖任何 Node 内置模块 —— Web 面板会把它一起打进前端包。
 */
export const ORCA_BACKEND_ID = 'orca'
export const CLAUDE_CODE_BACKEND_ID = 'claude-code'

export interface WorkerBackendMeta {
  id: string
  label: string
  hint: string
}

export const WORKER_BACKENDS: readonly WorkerBackendMeta[] = [
  {
    id: ORCA_BACKEND_ID,
    label: 'orca · Orca worktree + 终端',
    hint: '通过 Orca 创建 worktree 并启动 Claude Code 终端，交互与状态读取走 Orca',
  },
  {
    id: CLAUDE_CODE_BACKEND_ID,
    label: 'claude-code · git worktree + claude --bg',
    hint: '直接调用 Claude Code CLI 的后台会话；项目 repo 需要填本地仓库绝对路径',
  },
]

export const WORKER_BACKEND_IDS: readonly string[] = WORKER_BACKENDS.map(backend => backend.id)

/** 兼容旧配置与旧工单：claude-cli 已改名为 claude-code。 */
export const LEGACY_CLAUDE_CODE_BACKEND_ID = 'claude-cli'

export const LEGACY_BACKEND_IDS: Readonly<Record<string, string>> = {
  [LEGACY_CLAUDE_CODE_BACKEND_ID]: CLAUDE_CODE_BACKEND_ID,
}

/** 把历史 backend id 归一成当前 id；未知 id 原样返回，交给注册表报错。 */
export function normalizeBackendId(id: string): string {
  const value = id.trim()
  return LEGACY_BACKEND_IDS[value] ?? value
}
