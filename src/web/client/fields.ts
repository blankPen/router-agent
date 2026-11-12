/**
 * 配置面板的字段描述表。
 *
 * 服务端负责最终校验（src/config.ts 的 applyConfigPatch），这里只描述「怎么展示、
 * 默认值怎么取、明显不合法的值提前提示」，避免用户点保存后才被后端打回。
 *
 * 层次约定（配置页从上到下）：
 *   一级分组 ConfigGroup —— LLM Provider / 运行时配置 / 渠道配置 / 项目配置 / 消息准入 / 其他设置；
 *   二级块   ConfigBlock —— 分组内的一小节，可折叠；
 *   字段     FieldDef    —— 一个可编辑项。
 * 分组与块的顺序即优先级：接入与可用性在前，低频与高级项下沉折叠。
 */
import { WORKER_RUNTIMES } from '#runtime/runtimes/catalog.js'
import { ACP_AGENTS } from '#runtime/runtimes/acp-agents.js'
import {
  RUNTIME_OPTION_SPECS,
  optionSpecOf,
  parseRuntimeOptionPath,
  runtimeOptionDefault,
  runtimeOptionPath,
  type RuntimeOptionSpec,
} from '#runtime/runtimes/options.js'
import { isDeprecatedRuntime, runtimeOptionLabel, runtimeStatusLabel, type RuntimeChoiceView } from './runtime-model.js'

export type { RuntimeChoiceView } from './runtime-model.js'

export type FieldKind = 'text' | 'password' | 'number' | 'switch' | 'select' | 'list'

export interface FieldOption {
  value: string
  label: string
  hint?: string
  disabled?: boolean
  /** disabled 的原因，渲染成 option title。 */
  reason?: string
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
  /** 字段自带默认值（运行时选项用它，页面「默认值快照」里没有这些动态路径）。 */
  defaultValue?: unknown
}

/**
 * 配置块：卡片内的一小节。
 *
 * `render` 指定专属渲染器；缺省按 `fields` 逐行渲染。
 * `folded` 的块默认收起，用于低频或高级项。
 */
export interface ConfigBlock {
  id: string
  title: string
  description?: string
  render?: 'fields' | 'runtime' | 'projects' | 'specs' | 'plugins' | 'custom'
  fields: FieldDef[]
  /** 块自己管理的、不是普通字段的配置路径（如群列表）。 */
  paths?: string[]
  /** 默认折叠（低频 / 高级内容）。 */
  folded?: boolean
  /** 生效说明的显式文案；缺省时按字段路径与热配置前缀推导。 */
  effectLabel?: string
}

/** 配置分组：配置页的一级层次。 */
export interface ConfigGroup {
  id: string
  title: string
  description: string
  /** 渠道组的内容来自渠道注册表，不在这里列字段。 */
  kind?: 'channels'
  blocks: ConfigBlock[]
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

/**
 * LLM Provider：Router 研判与图片转写用的大模型接入。
 *
 * 密钥只写不读——保存后 `publicConfig` 只回 `apiKeySet`，不会把明文下发回面板。
 * 初始化页与配置页共用同一份字段定义。
 */
export const LLM_FIELDS: FieldDef[] = [
  {
    path: 'llm.baseUrl',
    label: '模型 Base URL',
    kind: 'text',
    placeholder: '例如 https://api.deepseek.com/v1',
    hint: '接口地址，必填；OpenAI 兼容填到 /v1，Anthropic 兼容填网关根地址（不带 /v1/messages）',
  },
  {
    path: 'llm.api',
    label: '接口协议',
    kind: 'select',
    options: [
      { value: 'openai-completions', label: 'openai-completions · OpenAI 兼容（默认）', hint: 'DeepSeek / 通义 / Kimi 等 /chat/completions 接口' },
      { value: 'anthropic-messages', label: 'anthropic-messages · Anthropic 兼容', hint: 'Claude Code / CCSwitch 里常见的 ANTHROPIC_BASE_URL 网关' },
    ],
    hint: '从本地 Claude Code / CCSwitch 配置导入时会自动设置',
  },
  {
    path: 'llm.model',
    label: '模型名',
    kind: 'text',
    placeholder: '例如 deepseek-v4-flash',
    hint: 'Router 研判与图片转写默认都使用这个模型',
  },
  {
    path: 'llm.apiKey',
    label: 'API Key',
    kind: 'password',
    placeholder: '留空 = 保持已配置的密钥',
    hint: '只写入 config.yaml，保存后不会回显；必填，环境变量 RA_LLM_API_KEY 可覆盖',
  },
  {
    path: 'llm.authHeader',
    label: '密钥用 Bearer 发送',
    kind: 'switch',
    hint: 'Anthropic 兼容端点使用 ANTHROPIC_AUTH_TOKEN 时开启；使用 ANTHROPIC_API_KEY（x-api-key）时保持关闭',
  },
]

/**
 * 配置页的分组与块。
 *
 * 顺序原则：先「能不能跑起来」（LLM 接入、运行时、渠道、项目），再「谁来叫醒它」
 * （消息准入），最后是低频的其它设置。
 */
export const CONFIG_GROUPS: ConfigGroup[] = [
  {
    id: 'llm',
    title: 'LLM Provider',
    description: 'Router 用哪个模型研判、怎么说话、上下文怎么复用。',
    blocks: [
      {
        id: 'llm',
        title: '模型接入',
        description: 'Router 研判与图片转写使用的大模型接入，Base URL / 模型 / API Key 三项必填。密钥只写入 config.yaml，保存后不回显明文。',
        fields: LLM_FIELDS,
      },
      {
        id: 'judgement',
        title: '研判预算',
        description: '单次研判的超时与 token 上限；超预算会走兜底回复。',
        fields: [
          { path: 'router.timeoutMs', label: '单次研判超时', kind: 'number', min: 1_000, max: 600_000, unit: '毫秒', ms: true },
          { path: 'router.tokenBudget', label: '单次 token 预算', kind: 'number', min: 0, max: 10_000_000, unit: 'token', hint: '0 表示不限制' },
          { path: 'router.agentDir', label: 'Pi 配置目录', kind: 'text', placeholder: '留空 = ~/.router-agent/pi' },
        ],
      },
      {
        id: 'persona',
        title: '人格',
        description: '机器人怎么称呼自己、用什么口吻回复。',
        fields: [
          { path: 'router.persona.name', label: '机器人自称', kind: 'text' },
          { path: 'router.persona.style', label: '说话风格', kind: 'select', options: PERSONA_STYLE_OPTIONS },
          { path: 'router.persona.language', label: '回复语言', kind: 'text', placeholder: 'zh-CN' },
        ],
      },
      {
        id: 'specs',
        title: '规范文件',
        description: 'Router 与 Worker 的提示词规范统一存放在内置存储里，可直接查看、编辑、保存或恢复默认；不再需要指定外部文件路径。',
        render: 'specs',
        fields: [],
        effectLabel: '保存后按项生效',
      },
      {
        id: 'session',
        title: '会话复用',
        description: '按人保留落盘的 Pi session，减少每次研判的重复上下文。低频项，保持默认即可。',
        folded: true,
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
    ],
  },
  {
    id: 'runtime',
    title: '运行时配置',
    description: '工单交给哪个运行时执行，同时能并发跑几张。',
    blocks: [
      {
        id: 'runtime',
        title: 'Worker 运行时',
        description: '选择执行工单的运行时；只影响新工单，已派出的工单继续使用创建时的运行时。',
        render: 'runtime',
        fields: [
          {
            path: 'runtime.default',
            label: 'Worker 运行时',
            kind: 'select',
            options: WORKER_RUNTIMES.map(runtime => ({ value: runtime.id, label: runtime.label, hint: runtime.hint })),
            hint: '只影响新工单；已派出的工单继续使用创建时的运行时',
          },
        ],
      },
      {
        id: 'concurrency',
        title: '并发上限',
        description: '同一时间最多跑几张工单；超出的工单排队等空闲 worker。',
        fields: [
          { path: 'policy.maxWorkers', label: '并发上限', kind: 'number', min: 1, max: 64, unit: '张' },
        ],
      },
    ],
  },
  {
    id: 'channels',
    title: '渠道配置',
    description: '消息从哪个渠道进来。先选渠道，再配它的接入、接收范围与消息处理。',
    kind: 'channels',
    blocks: [],
  },
  {
    id: 'projects',
    title: '项目配置',
    description: '可派工的项目清单，按运行时隔离。',
    blocks: [
      {
        id: 'projects',
        title: '项目清单',
        description: '可派工的项目。项目按运行时隔离，切换上方「Worker 运行时」即可编辑另一套。',
        render: 'projects',
        fields: [],
      },
    ],
  },
  {
    id: 'admission',
    title: '消息准入',
    description: '哪些消息能开工单、以什么方式接单。保存后立即生效，不需要重启。',
    blocks: [
      {
        id: 'accept-mode',
        title: '接单方式',
        description: '决定 Router 收到消息后是只记录、只研判，还是直接开单派工。',
        fields: [
          { path: 'policy.acceptMode', label: '接单模式', kind: 'select', options: ACCEPT_MODE_OPTIONS },
        ],
      },
      {
        id: 'admission-rules',
        title: '谁能叫醒机器人',
        description: '按「是否在名单里」和「是否 @ 了机器人」两个维度决定一条消息是否进入研判。',
        fields: [
          {
            path: 'policy.admission.listedNotAddressed',
            label: '名单内成员 · 未 @ 机器人',
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
    ],
  },
  {
    id: 'ops',
    title: '其他设置',
    description: '进展同步、闲置治理、工作区回收与服务端口。',
    blocks: [
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
        description: '长时间没有进展的工单，先提醒、再自动关单。',
        fields: [
          { path: 'retention.enabled', label: '启用闲置治理', kind: 'switch' },
          { path: 'retention.idleHours', label: '多久没进展发提醒', kind: 'number', min: 1, max: 8_760, unit: '小时' },
          { path: 'retention.closeGraceHours', label: '提醒后多久自动关单', kind: 'number', min: 1, max: 8_760, unit: '小时' },
          { path: 'retention.zombieHours', label: '僵尸进程判定', kind: 'number', min: 1, max: 8_760, unit: '小时' },
          { path: 'retention.sweepMinutes', label: '扫描间隔', kind: 'number', min: 1, max: 1_440, unit: '分钟' },
        ],
      },
      {
        id: 'workspace',
        title: '工作区回收',
        description: '工单关闭后只停 worker，workspace 先保留一段时间，再由定时任务回收；也可以随时在「清理工作区」里手动回收。',
        fields: [
          { path: 'workspace.enabled', label: '启用定时回收', kind: 'switch' },
          { path: 'workspace.keepHours', label: '关单后保留多久', kind: 'number', min: 0, max: 8_760, unit: '小时', hint: '0 = 下个扫描周期就回收' },
          { path: 'workspace.sweepMinutes', label: '扫描间隔', kind: 'number', min: 1, max: 1_440, unit: '分钟' },
        ],
      },
      {
        id: 'service',
        title: '服务与门禁',
        description: '面板端口与工单交付门禁。',
        fields: [
          { path: 'server.port', label: '面板端口', kind: 'number', min: 1, max: 65_535, unit: '端口' },
          {
            path: 'worker.evidence.ui',
            label: 'UI 证据门禁',
            kind: 'select',
            options: [
              { value: 'off', label: 'off · 关闭' },
              { value: 'warn', label: 'warn · 只记日志' },
              { value: 'enforce', label: 'enforce · 拦截 ready' },
            ],
            hint: 'UI 工单报 ready 时检查 PR / MR 是否有 Before / After 证据；修改后需重启服务',
          },
        ],
      },
      {
        id: 'plugins',
        title: '插件',
        description: '内置运行时与通道之外，还可以按包名或路径加载自定义插件；保存后重启服务生效。',
        render: 'plugins',
        fields: [],
        folded: true,
        effectLabel: '保存后重启生效',
      },
    ],
  },
]

/** 分组里所有块的字段。 */
export function groupFields(groups: ConfigGroup[]): FieldDef[] {
  return groups.flatMap(group => group.blocks.flatMap(block => block.fields))
}

/** 块管理的全部配置路径：普通字段 + 块自己声明的路径。 */
export function blockPaths(block: ConfigBlock): string[] {
  return [...block.fields.map(field => field.path), ...(block.paths ?? [])]
}

/** 所有标量字段的点路径，用于计算「哪些配置被改过」。 */
export function fieldPaths(fields: FieldDef[]): string[] {
  return fields.map(field => field.path)
}

/**
 * 运行时自己声明的选项 → 面板字段。
 *
 * 面板不关心具体是哪个运行时：新增运行时只要声明了自己的选项，这里就会自动渲染。
 */
export function runtimeOptionFields(runtimeId: string, specs?: RuntimeOptionSpec[]): FieldDef[] {
  const spec = optionSpecOf(runtimeId) ?? specs?.find(item => item.runtimeId === runtimeId) ?? null
  return spec ? runtimeOptionFieldsOf(runtimeId, spec) : []
}

/** 插件加载时带上来的 option 声明；自定义运行时也能渲染设置弹窗。 */
export function runtimeOptionFieldsOf(runtimeId: string, spec: FieldSpec | null | undefined): FieldDef[] {
  if (!spec) return []
  return spec.fields.map(field => ({
    path: runtimeOptionPath(runtimeId, field.key),
    label: field.label,
    kind: field.kind === 'select' ? 'select' : field.kind === 'switch' ? 'switch' : field.kind === 'number' ? 'number' : 'text',
    ...(field.options
      ? {
          options: field.options.map(option => ({
            value: option.value,
            label: option.label,
            ...(option.hint ? { hint: option.hint } : {}),
          })),
        }
      : {}),
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    ...(field.hint ? { hint: field.hint } : {}),
    ...(field.default !== undefined ? { defaultValue: field.default } : {}),
    ...(field.min !== undefined ? { min: field.min } : {}),
    ...(field.max !== undefined ? { max: field.max } : {}),
  }))
}

type FieldSpec = RuntimeOptionSpec

/** 所有已声明运行时的选项字段；保存前统一校验，避免某个运行时的脏值溜过去。 */
export function allRuntimeOptionFields(specs?: RuntimeOptionSpec[]): FieldDef[] {
  return [...RUNTIME_OPTION_SPECS, ...(specs ?? [])]
    .filter((spec, index, all) => all.findIndex(item => item.runtimeId === spec.runtimeId) === index)
    .flatMap(spec => runtimeOptionFieldsOf(spec.runtimeId, spec))
}

/** 字段路径 → 声明默认值，供 `fieldValue` 回退；自定义运行时也参与校验。 */
export function runtimeOptionDefaults(fields: FieldDef[]): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .filter(field => field.defaultValue !== undefined)
      .map(field => [field.path, field.defaultValue]),
  )
}

/**
 * 运行时选项回写值：选回声明默认值时写成空串，让后端把键删掉。
 *
 * 这样 config.yaml 里不会留下一个「和默认值相同」的多余配置，
 * 后续调整声明默认值也能直接生效。
 */
export function runtimeOptionPatchValue(field: FieldDef, value: unknown): unknown {
  const parsed = parseRuntimeOptionPath(field.path)
  if (!parsed) return value
  const fallback = runtimeOptionDefault(parsed.runtimeId, parsed.key)
  if (fallback === undefined) return value
  return JSON.stringify(value) === JSON.stringify(fallback) ? '' : value
}

/** 探测结果 → runtime.default 的下拉选项；无探测结果时回退静态清单。 */
export function runtimeOptions(choices?: RuntimeChoiceView[], selectedId?: string): FieldOption[] {
  // 内置运行时永远保留；探测结果按 id 覆盖，避免旧缓存里缺 orca / claude-code。
  const merged = new Map<string, RuntimeChoiceView>()
  for (const runtime of WORKER_RUNTIMES) {
    merged.set(runtime.id, { id: runtime.id, name: runtime.name, label: runtime.label, hint: runtime.hint, status: 'pending' })
  }
  for (const choice of choices ?? []) merged.set(choice.id, { ...merged.get(choice.id), ...choice })
  // 探测结果还没回来时，把目录里的 ACP 运行时以「待检测」占位，避免已配置的
  // acp-* 默认值被前端误判成非法值、卡住保存。
  for (const agent of ACP_AGENTS) {
    if (!merged.has(agent.runtimeId)) {
      merged.set(agent.runtimeId, {
        id: agent.runtimeId,
        name: agent.name,
        label: agent.label,
        hint: agent.hint,
        status: 'pending',
        installable: Boolean(agent.package),
        ...(agent.deprecated ? { deprecated: true } : {}),
      })
    }
  }
  const source = [...merged.values()]
    // 已有原生运行时替代品的（Claude Code / Codex 的 ACP 版本）不再列为可选项；
    // 当前正选中的要留着，否则老配置在下拉里找不到自己。
    .filter(choice => !isDeprecatedRuntime(choice) || choice.id === selectedId)
  return source.map(choice => {
    const available = choice.status === 'ready' || choice.status === 'unverified' || choice.status === 'pending'
    const statusLabel = runtimeStatusLabel(choice.status)
    const name = runtimeOptionLabel(choice)
    return {
      value: choice.id,
      label: choice.status === 'pending'
        ? `${name} · 待检测`
        : available
          ? `${name}${choice.version ? ` · ${choice.version}` : ''}`
          : `${name}（${statusLabel}）`,
      hint: choice.reason ?? choice.hint,
      disabled: !available,
      ...(choice.reason ? { reason: choice.reason } : {}),
    }
  })
}

/**
 * 用动态 choices 替换 runtime.default 的 options；其余字段原样保留。
 *
 * 运行时自己的选项不在页面上平铺：它们通过卡片上的「设置」弹窗编辑，
 * 见 runtime-settings.tsx。
 */
export function groupsFor(choices?: RuntimeChoiceView[], selectedId?: string, extraChoices?: RuntimeChoiceView[]): ConfigGroup[] {
  const options = runtimeOptions([...(choices ?? []), ...(extraChoices ?? [])], selectedId)
  return CONFIG_GROUPS.map(group => ({
    ...group,
    blocks: group.blocks.map(block => ({
      ...block,
      fields: block.fields.map(field => field.path === 'runtime.default' ? { ...field, options } : field),
    })),
  }))
}

/** 配置块的生效方式：立即生效 / 重启生效 / 两者混合。 */
export type BlockEffect = { label: string; tone: 'hot' | 'cold' | 'mixed' }

export function blockEffect(block: ConfigBlock, hotPaths: string[]): BlockEffect {
  if (block.effectLabel) return { label: block.effectLabel, tone: 'cold' }
  if (block.fields.length === 0) return { label: '重启生效', tone: 'cold' }
  const hot = block.fields.filter(field => hotPaths.some(prefix => field.path.startsWith(prefix))).length
  if (hot === 0) return { label: '重启生效', tone: 'cold' }
  if (hot === block.fields.length) return { label: '立即生效', tone: 'hot' }
  return { label: '部分立即生效', tone: 'mixed' }
}

/** 分组的生效方式：块里只要有一项是热配置，就不能整体标成「重启生效」。 */
export function groupEffect(group: ConfigGroup, hotPaths: string[]): BlockEffect {
  const effects = group.blocks.map(block => blockEffect(block, hotPaths))
  if (effects.length === 0) return { label: '重启生效', tone: 'cold' }
  if (effects.every(effect => effect.tone === 'hot')) return { label: '立即生效', tone: 'hot' }
  if (effects.every(effect => effect.tone === 'cold')) return { label: '重启生效', tone: 'cold' }
  return { label: '部分立即生效', tone: 'mixed' }
}

export function getByPath(doc: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => {
    if (!node || typeof node !== 'object') return undefined
    return (node as Record<string, unknown>)[part]
  }, doc)
}

/**
 * 取字段当前值。
 *
 * 运行时选项没配置过时回落到声明里的默认值（没声明默认值则按空串算），
 * 这样面板显示的就是实际会生效的取值，也不会误报「有未保存的修改」。
 */
export function fieldValue(doc: unknown, path: string, defaults?: Record<string, unknown>): unknown {
  const value = getByPath(doc, path)
  if (value !== undefined && value !== '') return value
  if (path.startsWith('runtime.options.')) {
    const parsed = parseRuntimeOptionPath(path)
    const fallback = parsed ? runtimeOptionDefault(parsed.runtimeId, parsed.key) ?? defaults?.[path] : undefined
    return fallback ?? ''
  }
  return value
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
  if (field.kind === 'select' && field.options) {
    // 没有配置过（值为空）时，只要声明里留了空选项，就视为「不覆盖」。
    if ((value === undefined || value === '') && field.options.some(item => item.value === '')) return null
    const option = field.options.find(item => item.value === value)
    if (!option) return '请选择一个有效值'
    // 当前选中项不可用（未安装/不兼容）时只置灰，不阻止用户保存其它字段。
    if (option.disabled) return null
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
