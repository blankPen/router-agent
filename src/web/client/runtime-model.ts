/**
 * 运行时卡片的纯逻辑：合并静态目录与服务端探测快照、状态文案、可选规则。
 *
 * 这里不能依赖任何 Node 内置模块 —— Web 面板会把它打进前端包；
 * 同时保持纯函数，方便用 vitest 的 node 环境直接测试。
 */
import { ACP_AGENTS } from '../../worker/runtimes/acp/agents.js'
import { WORKER_RUNTIMES } from '../../worker/runtimes/catalog.js'

export interface RuntimeRequirementView {
  label: string
  ok: boolean
  version?: string
  reason?: string
}

export interface RuntimeCliView {
  command: string
  label: string
  installed: boolean
  version?: string
  installUrl?: string
}

export interface RuntimeExtensionView {
  packageName: string
  installed: boolean
  installable: boolean
  installUrl?: string
}

/** 服务端 /api/config 与 /api/runtimes 下发的运行时探测结果。 */
export interface RuntimeChoiceView {
  id: string
  label: string
  hint: string
  status: 'ready' | 'not-installed' | 'incompatible' | 'needs-auth' | 'unverified' | 'pending' | string
  version?: string
  source?: string
  reason?: string
  installable?: boolean
  packageName?: string
  installHint?: string
  loginHint?: string
  loadSession?: boolean
  verifyRequired?: boolean
  command?: string
  requires?: RuntimeRequirementView[]
  cli?: RuntimeCliView
  extension?: RuntimeExtensionView
}

export const RUNTIME_STATUS_LABEL: Record<string, string> = {
  ready: '可用',
  'not-installed': '未安装',
  incompatible: '不兼容',
  'needs-auth': '未登录',
  unverified: '待验证',
  pending: '待检测',
}

export function runtimeStatusLabel(status?: string): string {
  return RUNTIME_STATUS_LABEL[status ?? ''] ?? status ?? '未知'
}

export function runtimeSourceLabel(source?: string): string {
  if (source === 'managed') return 'ra 安装'
  if (source === 'config') return '配置指定'
  if (source === 'path') return 'PATH'
  return ''
}

/** 卡片标题只用 label 的第一段，例如 `orca · Orca worktree...` → `orca`。 */
export function runtimeDisplayName(choice: RuntimeChoiceView): string {
  return choice.label.split(' · ')[0]?.trim() || choice.id
}

export function isAcpAgentRuntime(id: string): boolean {
  return id.startsWith('acp-')
}

export function isBuiltinRuntime(id: string): boolean {
  return WORKER_RUNTIMES.some(runtime => runtime.id === id)
}

/** 只有能真正派工的运行时才允许选中；pending 表示还没探测，先允许。 */
export function isRuntimeSelectable(choice?: RuntimeChoiceView): boolean {
  if (!choice) return false
  return choice.status === 'ready' || choice.status === 'unverified' || choice.status === 'pending'
}

/**
 * 合并静态目录与服务端快照：服务端结果覆盖静态占位，缺项补 pending。
 * 顺序保持稳定（内置运行时 → ACP Agent 目录），避免卡片每次刷新乱跳。
 */
export function mergeRuntimeChoices(choices?: RuntimeChoiceView[]): RuntimeChoiceView[] {
  const merged = new Map<string, RuntimeChoiceView>()
  for (const runtime of WORKER_RUNTIMES) {
    merged.set(runtime.id, {
      id: runtime.id,
      label: runtime.label,
      hint: runtime.hint,
      status: 'pending',
      installable: false,
      ...(runtime.installHint ? { installHint: runtime.installHint } : {}),
    })
  }
  for (const agent of ACP_AGENTS) {
    merged.set(agent.runtimeId, {
      id: agent.runtimeId,
      label: agent.label,
      hint: agent.hint,
      status: 'pending',
      installable: Boolean(agent.package),
      ...(agent.package ? { packageName: agent.package.name } : {}),
      ...(agent.installHint ? { installHint: agent.installHint } : {}),
      ...(agent.login ? { loginHint: agent.login.hint } : {}),
      ...(agent.loadSession !== undefined ? { loadSession: agent.loadSession } : {}),
      ...(agent.verifyRequired ? { verifyRequired: true } : {}),
    })
  }
  for (const choice of choices ?? []) merged.set(choice.id, choice)

  const result: RuntimeChoiceView[] = []
  const order = [
    ...WORKER_RUNTIMES.map(runtime => runtime.id),
    ...ACP_AGENTS.map(agent => agent.runtimeId),
  ]
  for (const id of order) {
    const choice = merged.get(id)
    if (!choice) continue
    result.push(choice)
    merged.delete(id)
  }
  // 目录外的历史 id 追加到末尾，不让服务端快照里的信息丢失。
  result.push(...merged.values())
  return result
}
