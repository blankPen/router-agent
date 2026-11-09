/**
 * 配置面板的字段描述表。
 *
 * 服务端负责最终校验（src/config.ts 的 applyConfigPatch），这里只描述「怎么展示、
 * 默认值怎么取、明显不合法的值提前提示」，避免用户点保存后才被后端打回。
 */
import { WORKER_RUNTIMES } from '../../worker/runtimes/catalog.js'

export type FieldKind = 'text' | 'number' | 'switch' | 'select' | 'list'

export interface FieldOption {
  value: string
  label: string
  hint?: string
}

export interface FieldDef {
  /** 与 config.yaml 一致的点路径，也是提交补丁时的 key。 */
  path: string
  label: string
  hint?: string
  kind: FieldKind
  options?: FieldOption[]
  min?: number
  max?: number
  /** 数字单位，用于输入框后缀。 */
  unit?: string
  /** 毫秒字段：额外展示「≈ 1 分钟」这类可读换算。 */
  ms?: boolean
  placeholder?: string
}

export interface SectionDef {
  id: string
  title: string
  description: string
  /** 保存后是否立即生效；否则提示需要重启服务。 */
  hot?: boolean
  fields: FieldDef[]
}

const ACCEPT_MODE_OPTIONS: FieldOption[] = [
  { value: 'off', label: 'off · 不自动接单', hint: '只记录消息，不开工单' },
  { value: 'observe', label: 'observe · 只研判记录', hint: '研判结论写库，但不派工' },
  { value: 'auto', label: 'auto · 研判通过直接开单', hint: '默认模式' },
]

const ADMISSION_LISTED_OPTIONS: FieldOption[] = [
  { value: 'inferred', label: 'inferred · 允许模型推断接单' },
  { value: 'ignore', label: 'ignore · 必须显式 @ 才算' },
]

const ADMISSION_ADDRESSED_OPTIONS: FieldOption[] = [
  { value: 'explicit', label: 'explicit · 只接明确指派' },
  { value: 'inferred', label: 'inferred · 允许模型推断' },
  { value: 'ignore', label: 'ignore · 一律忽略' },
]

const KEY_SCOPE_OPTIONS: FieldOption[] = [
  { value: 'user', label: 'user · 群 + 人' },
  { value: 'thread', label: 'thread · 群 + 话题 + 人' },
]

const PERSONA_STYLE_OPTIONS: FieldOption[] = [
  { value: 'friendly', label: 'friendly · 亲和' },
  { value: 'concise', label: 'concise · 简洁' },
  { value: 'professional', label: 'professional · 专业' },
]

const WORKER_MODE_OPTIONS: FieldOption[] = [
  { value: 'prompt', label: 'prompt · 每次拼完整 prompt' },
  { value: 'agent', label: 'agent · Agent 模式，上下文更深' },
]

export const SECTIONS: SectionDef[] = [
  {
    id: 'policy',
    title: '准入策略',
    description: '决定什么消息能开工单、最多同时跑几张。保存后立即生效，不需要重启。',
    hot: true,
    fields: [
      { path: 'policy.acceptMode', label: '接单模式', kind: 'select', options: ACCEPT_MODE_OPTIONS },
      { path: 'policy.maxWorkers', label: '并发上限', kind: 'number', min: 1, max: 64, unit: '张' },
      {
        path: 'policy.admission.listedNotAddressed',
        label: '白名单成员 · 未 @ 机器人',
        kind: 'select',
        options: ADMISSION_LISTED_OPTIONS,
        hint: '已在允许名单里的人发消息但没 @ 机器人时怎么处理',
      },
      {
        path: 'policy.admission.unlistedAddressed',
        label: '名单外成员 · @ 了机器人',
        kind: 'select',
        options: ADMISSION_ADDRESSED_OPTIONS,
        hint: '陌生人 @ 机器人时，是只认明确指名，还是允许模型推断',
      },
      {
        path: 'policy.admission.unlistedNotAddressed',
        label: '名单外成员 · 未 @ 机器人',
        kind: 'select',
        options: ADMISSION_LISTED_OPTIONS,
      },
    ],
  },
  {
    id: 'router',
    title: '研判与人格',
    description: 'Router 调用模型做研判时的超时、预算与表达风格。',
    fields: [
      { path: 'router.timeoutMs', label: '单次研判超时', kind: 'number', min: 1_000, max: 600_000, unit: '毫秒', ms: true },
      { path: 'router.tokenBudget', label: '单次 token 预算', kind: 'number', min: 0, max: 10_000_000, unit: 'token', hint: '0 表示不限制' },
      { path: 'router.agentDir', label: 'Pi 配置目录', kind: 'text', placeholder: '留空 = ~/.router-agent/pi' },
      { path: 'router.persona.name', label: '机器人自称', kind: 'text' },
      { path: 'router.persona.style', label: '说话风格', kind: 'select', options: PERSONA_STYLE_OPTIONS },
      { path: 'router.persona.language', label: '回复语言', kind: 'text', placeholder: 'zh-CN' },
      { path: 'router.persona.soulFile', label: '自定义人格文件', kind: 'text', placeholder: '留空 = 内置 soul.md' },
    ],
  },
  {
    id: 'session',
    title: '会话复用',
    description: '按人保留落盘的 Pi session，减少每次研判的重复上下文。',
    fields: [
      { path: 'router.session.enabled', label: '启用会话复用', kind: 'switch' },
      { path: 'router.session.keyScope', label: '会话隔离维度', kind: 'select', options: KEY_SCOPE_OPTIONS },
      { path: 'router.session.dir', label: 'session 目录', kind: 'text', placeholder: '留空 = ~/.router-agent/sessions' },
      { path: 'router.session.maxActive', label: '内存中 session 上限', kind: 'number', min: 1, max: 1_000, unit: '个' },
      { path: 'router.session.idleTtlMs', label: '空闲回收', kind: 'number', min: 0, max: 86_400_000, unit: '毫秒', ms: true, hint: '文件保留，只回收内存；0 = 立即回收' },
      { path: 'router.session.turnTimeoutMs', label: '单轮硬超时', kind: 'number', min: 1_000, max: 3_600_000, unit: '毫秒', ms: true },
      { path: 'router.session.retentionDays', label: '/new 后旧 session 保留', kind: 'number', min: 0, max: 3_650, unit: '天', hint: '0 = 不清理' },
      { path: 'router.session.cleanupIntervalHours', label: '清理任务间隔', kind: 'number', min: 1, max: 720, unit: '小时' },
      { path: 'router.session.tokenBudget', label: '会话 token 预算', kind: 'number', min: 0, max: 10_000_000, unit: 'token', hint: '0 = 不限制，交给压缩' },
      { path: 'router.session.compaction.enabled', label: '启用自动压缩', kind: 'switch' },
      { path: 'router.session.compaction.reserveTokens', label: '压缩预留 token', kind: 'number', min: 1_024, max: 1_000_000 },
      { path: 'router.session.compaction.keepRecentTokens', label: '保留最近 token', kind: 'number', min: 1_024, max: 1_000_000 },
    ],
  },
  {
    id: 'progress',
    title: '进展同步',
    description: 'Worker 上报和主动巡检的节奏。',
    fields: [
      { path: 'progress.syncMs', label: '进展合并同步间隔', kind: 'number', min: 0, max: 3_600_000, unit: '毫秒', ms: true, hint: '0 = 关闭定时同步' },
      { path: 'progress.probeMs', label: '主动巡检间隔', kind: 'number', min: 0, max: 3_600_000, unit: '毫秒', ms: true, hint: '0 = 关闭主动巡检' },
      { path: 'progress.silenceMs', label: '静默判定阈值', kind: 'number', min: 1_000, max: 3_600_000, unit: '毫秒', ms: true },
      { path: 'progress.repeatMs', label: '重复提醒最小间隔', kind: 'number', min: 1_000, max: 3_600_000, unit: '毫秒', ms: true },
    ],
  },
  {
    id: 'retention',
    title: '闲置治理',
    description: '长时间没有进展的工单，先提醒、再自动关单并回收 workspace。',
    fields: [
      { path: 'retention.enabled', label: '启用闲置治理', kind: 'switch' },
      { path: 'retention.idleHours', label: '多久没进展发提醒', kind: 'number', min: 1, max: 8_760, unit: '小时' },
      { path: 'retention.closeGraceHours', label: '提醒后多久自动关单', kind: 'number', min: 1, max: 8_760, unit: '小时' },
      { path: 'retention.zombieHours', label: '僵尸进程判定', kind: 'number', min: 1, max: 8_760, unit: '小时' },
      { path: 'retention.sweepMinutes', label: '扫描间隔', kind: 'number', min: 1, max: 1_440, unit: '分钟' },
    ],
  },
  {
    id: 'feishu',
    title: '飞书接入',
    description: '机器人身份、接收范围与图片转文本。修改群列表请用「来源」或 CLI。',
    fields: [
      { path: 'feishu.appId', label: '应用 App ID', kind: 'text', placeholder: '留空 = 复用当前 lark-cli profile' },
      { path: 'feishu.larkHome', label: 'lark-cli 配置目录', kind: 'text', placeholder: '留空 = 复用当前 profile' },
      { path: 'feishu.reaction', label: '回执表情', kind: 'text', placeholder: '例如 Typing，留空 = 关闭' },
      { path: 'feishu.directMessages', label: '接收私聊', kind: 'switch' },
      { path: 'feishu.images.enabled', label: '图片转文本', kind: 'switch', hint: '下载 image_key 后交给多模态模型识别' },
      { path: 'feishu.images.maxChars', label: '单张图片最多字符', kind: 'number', min: 100, max: 20_000, unit: '字' },
      { path: 'feishu.images.timeoutMs', label: '单张图片识别超时', kind: 'number', min: 1_000, max: 300_000, unit: '毫秒', ms: true },
      { path: 'feishu.allowed', label: '全局允许名单', kind: 'list', placeholder: 'ou_xxx, ou_yyy', hint: '逗号分隔的 open_id' },
      { path: 'feishu.bots', label: '可引用的机器人', kind: 'list', placeholder: 'ou_xxx' },
      { path: 'feishu.botOpenIds', label: '机器人自身 open_id', kind: 'list', placeholder: 'ou_xxx' },
      { path: 'feishu.botNames', label: '机器人显示名', kind: 'list', placeholder: '阿罗' },
    ],
  },
  {
    id: 'delivery',
    title: '派工与服务',
    description: 'Worker 执行方式、监听端口与模型接入。模型密钥不在此处展示，请用 CLI / 环境变量配置。',
    fields: [
      { path: 'workerSpec.mode', label: 'Worker 规格模式', kind: 'select', options: WORKER_MODE_OPTIONS },
      {
        path: 'runtime.default',
        label: 'Worker 运行时',
        kind: 'select',
        options: WORKER_RUNTIMES.map(runtime => ({ value: runtime.id, label: runtime.label, hint: runtime.hint })),
        hint: '只影响新工单；已派出的工单继续使用创建时的运行时',
      },
      { path: 'server.port', label: '面板端口', kind: 'number', min: 1, max: 65_535, unit: '端口' },
      { path: 'llm.baseUrl', label: '模型 Base URL', kind: 'text', placeholder: '留空 = 复用 ~/.trove/config.json' },
      { path: 'llm.model', label: '模型名', kind: 'text', placeholder: '例如 deepseek-v4-flash' },
    ],
  },
]

/** 所有标量字段的点路径，用于计算「哪些配置被改过」。 */
export const FIELD_PATHS: string[] = SECTIONS.flatMap(section => section.fields.map(field => field.path))

export function getByPath(doc: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => {
    if (!node || typeof node !== 'object') return undefined
    return (node as Record<string, unknown>)[part]
  }, doc)
}

/** 不可变地写入点路径，供 React draft 使用。 */
export function setByPath<T>(doc: T, path: string, value: unknown): T {
  const parts = path.split('.')
  const root: Record<string, unknown> = Array.isArray(doc)
    ? ([...doc] as unknown as Record<string, unknown>)
    : { ...(doc as Record<string, unknown>) }
  let node = root
  for (const part of parts.slice(0, -1)) {
    const next = node[part]
    node[part] = next && typeof next === 'object' && !Array.isArray(next) ? { ...(next as Record<string, unknown>) } : {}
    node = node[part] as Record<string, unknown>
  }
  node[parts.at(-1)!] = value
  return root as T
}

export function toInputValue(value: unknown, kind: FieldKind): string {
  if (kind === 'list') return Array.isArray(value) ? value.join(', ') : ''
  if (value === undefined || value === null) return ''
  return String(value)
}

export function fromInputValue(raw: string, kind: FieldKind): unknown {
  if (kind === 'list') return raw.split(',').map(item => item.trim()).filter(Boolean)
  if (kind === 'number') return raw.trim() === '' ? 0 : Number(raw)
  return raw
}

/** 和后端一致的明显错误提示；返回 null 表示可以提交。 */
export function fieldError(field: FieldDef, value: unknown): string | null {
  if (field.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '请输入数字'
    if (field.min !== undefined && value < field.min) return `不能小于 ${field.min}`
    if (field.max !== undefined && value > field.max) return `不能大于 ${field.max}`
  }
  if (field.kind === 'select' && field.options && !field.options.some(option => option.value === value)) {
    return '请选择一个有效值'
  }
  return null
}

/** 毫秒转成人话，避免用户在 1800000 面前数零。 */
export function humanizeMs(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  if (ms < 1_000) return `${ms} 毫秒`
  const seconds = ms / 1_000
  if (seconds < 60) return `≈ ${trim(seconds)} 秒`
  const minutes = seconds / 60
  if (minutes < 60) return `≈ ${trim(minutes)} 分钟`
  const hours = minutes / 60
  if (hours < 24) return `≈ ${trim(hours)} 小时`
  return `≈ ${trim(hours / 24)} 天`
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

export function humanizeTime(iso: string | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const diff = Date.now() - date.getTime()
  if (diff >= 0 && diff < 60_000) return '刚刚'
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff >= 0 && diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}