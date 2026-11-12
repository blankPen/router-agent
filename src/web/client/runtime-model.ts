/**
 * 运行时卡片的纯逻辑：合并静态目录与服务端探测快照、状态文案、可选规则。
 *
 * 这里不能依赖任何 Node 内置模块 —— Web 面板会把它打进前端包；
 * 同时保持纯函数，方便用 vitest 的 node 环境直接测试。
 */
import { ACP_AGENTS, isDeprecatedAcpRuntimeId } from '#runtime/runtimes/acp/agents.js'
import { WORKER_RUNTIMES } from '#runtime/runtimes/catalog.js'

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
  /** 产品名；缺省时从 label 推断。 */
  name?: string
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
  /** 已有原生运行时替代品：面板不再把它列为可选项。 */
  deprecated?: boolean
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
  if (source === 'app') return 'App 内置'
  if (source === 'env') return '环境变量'
  if (source === 'path') return 'PATH'
  return ''
}

/** 运行时产品名：优先用目录里的 name，其次取 label 的第一段。 */
function runtimeName(choice: RuntimeChoiceView): string {
  return choice.name?.trim() || choice.label.split(' · ')[0]?.trim() || choice.id
}

/**
 * 卡片标题：运行时名按「单词首字母大写」展示。
 *
 * 优先用目录里的 `name`（`Orca` / `Claude Code` / `Codex App`），
 * 取不到时把 id 形式的第一段（`claude-code`）转成 `Claude Code`。
 */
export function runtimeDisplayName(choice: RuntimeChoiceView): string {
  return titleCase(runtimeName(choice))
}

/** 把 `claude-code` / `codex app` 这类机器名转成 `Claude Code` 形式；已是正常大小写的不动。 */
function titleCase(value: string): string {
  return value
    .split(/([\s-]+)/)
    .map(part => (/^[\s-]+$/.test(part) ? ' ' : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 下拉选项文案：名称 + 内置运行时的说明段（`Orca · Orca worktree + 终端`）。 */
export function runtimeOptionLabel(choice: RuntimeChoiceView): string {
  const name = runtimeDisplayName(choice)
  const desc = choice.label.split(' · ').slice(1).join(' · ').trim()
  return desc ? `${name} · ${desc}` : name
}

/**
 * 是否是已有原生运行时替代品的运行时（Claude Code / Codex 的 ACP 版本）。
 *
 * 这类运行时只是不再作为可选项展示，配置与已装扩展照旧可用。
 */
export function isDeprecatedRuntime(choice: RuntimeChoiceView): boolean {
  return choice.deprecated === true || isDeprecatedAcpRuntimeId(choice.id)
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
      name: runtime.name,
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
      name: agent.name,
      label: agent.label,
      hint: agent.hint,
      status: 'pending',
      installable: Boolean(agent.package),
      ...(agent.package ? { packageName: agent.package.name } : {}),
      ...(agent.installHint ? { installHint: agent.installHint } : {}),
      ...(agent.login ? { loginHint: agent.login.hint } : {}),
      ...(agent.loadSession !== undefined ? { loadSession: agent.loadSession } : {}),
      ...(agent.verifyRequired ? { verifyRequired: true } : {}),
      ...(agent.deprecated ? { deprecated: true } : {}),
    })
  }
  // 服务端快照优先，静态目录补齐它没带上的字段（如 name / deprecated）。
  for (const choice of choices ?? []) {
    merged.set(choice.id, { ...merged.get(choice.id), ...choice })
  }

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
