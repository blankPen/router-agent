/**
 * 自然语言 → 自动化任务的解析器。
 *
 * 一次模型调用把用户原话解析成结构化参数，然后**闭集校验**：
 * 来源、事件类型、参数、项目、处理方式都必须落在目录 / 清单里，
 * 选不中就回问，绝不编造（决策 A1：项目由会话解析时从对话内容分析得出）。
 */
import type { EventCatalog, EventTypeDescriptor } from '#event/port.js'
import type { ChatClient } from '#infra/chat.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import type { AutomationSchedule, EventFilter, EventHandlingMode } from '#core/automation.js'
import { validateSchedule } from '#core/automation-schedule.js'
import type { ProjectConfig } from '../config.js'
import { extractJsonObject } from '../router/model-config.js'
import { EVENT_SKILLS } from '../events/skills.js'
import { speechDelta } from './stream-speech.js'

/** 解析出来的一份任务参数。 */
export interface AutomationTaskDraft {
  name: string
  description: string
  type: 'ai' | 'script'
  /** 执行提示词。 */
  prompt: string
  /** 事件订阅；定时任务没有。 */
  subscription?: {
    source: string
    types: string[]
    params: Record<string, string>
    filter: EventFilter
    mode: EventHandlingMode
  }
  /** 定时计划；事件任务没有。 */
  schedule?: AutomationSchedule
  project: string
  skill: string
  notifyTo: string
}

/** 解析结果。 */
export type ParseResult =
  | { kind: 'task'; task: AutomationTaskDraft; speech?: string }
  | { kind: 'clarify'; question: string; missing: string[]; speech?: string }
  | { kind: 'none'; speech?: string }
  | { kind: 'unavailable' }

/** 解析器需要的依赖。 */
export interface ParseDeps {
  /** 模型客户端；没配模型时返回 unavailable。 */
  client: ChatClient | null
  /** 全部事件目录。 */
  catalogs: EventCatalog[]
  /** 候选项目（闭集）。 */
  projects: ProjectConfig[]
  /** 候选处理方式（闭集）。 */
  skills?: readonly { id: string; name: string; hint: string }[]
  /**
   * 参数探活：校验订阅参数是不是真的存在（如 GitHub 仓库）。
   *
   * 返回字符串表示这条参数不能用，错误文案直接回给用户；
   * 返回 null 表示通过。没提供就只做闭集校验（key 与格式）。
   */
  probeParams?: (source: string, params: Record<string, string>) => Promise<string | null>
  /**
   * 逐段回调模型输出（流式）。
   *
 * 给了就边收边转述给用户看，没给就一次性解析 —— 两条路径的结果一致。
   */
  onDelta?: (text: string) => void
  logger?: Logger
}

const DEFAULT_SKILLS = EVENT_SKILLS

/** 缺项时给用户看的问题。 */
const ASK: Record<string, (ctx: { catalogs: EventCatalog[]; projects: ProjectConfig[] }) => string> = {
  source: ({ catalogs }) => `要订阅哪个来源？目前可用：${catalogs.map(item => item.name).join('、') || '（没有已加载的来源）'}。`,
  types: () => '这个来源下面想订阅哪些事件？我可以给你列出来。',
  params: () => '还差一个必要参数，请补一下。',
  project: ({ projects }) => `在哪个项目里做？${projects.length ? '候选：' + projects.map(item => item.name).join('、') : '（当前没有候选项目）'}`,
  mode: () => '命中之后直接执行，还是先给你看一眼？',
  schedule: () => '什么时候跑？每天几点、每周几，还是 cron？',
  skill: () => '这类事情按什么方式处理？',
  name: () => '给这条自动化起个名字吧。',
  prompt: () => '命中之后要做什么？请描述清楚处理流程。',
}

/**
 * 解析一句话。
 *
 * 返回 clarify 时给出「缺哪一项」与「问什么」——
 * 一次只问一项，不一口气列一堆必填（§12.1 V1）。
 */
export async function parseAutomationIntent(text: string, deps: ParseDeps): Promise<ParseResult> {
  const logger = deps.logger ?? noopLogger
  if (!deps.client) return { kind: 'unavailable' }
  const skills = deps.skills ?? DEFAULT_SKILLS
  const catalogText = catalogTextOf(deps.catalogs)
  const projectText = deps.projects.map(project => `- ${project.name}（仓库 ${project.repo}）`).join('\n')
  const skillText = skills.map(skill => `- ${skill.id}（${skill.name}）：${skill.hint}`).join('\n')

  let parsed: Record<string, unknown> | null
  try {
    const messages = [
      { role: 'system' as const, content: systemPrompt(catalogText, projectText, skillText) },
      { role: 'user' as const, content: text },
    ]
    // 有流式能力就边收边转述：助手逐字说话，用户能看到它在想什么。
    if (deps.client.completeStream && deps.onDelta) {
      let raw = ''
      let seen = ''
      for await (const chunk of deps.client.completeStream(messages)) {
        raw += chunk
        const delta = speechDelta(raw, seen)
        seen = delta.seen
        if (delta.text) deps.onDelta(delta.text)
      }
      parsed = extractJsonObject(raw)
    } else {
      const turn = await deps.client.complete(messages)
      parsed = extractJsonObject(turn.content)
    }
  } catch (error) {
    logger.warn('automation:parse-failed', { message: errorMessage(error) })
    return { kind: 'unavailable' }
  }
  if (!parsed) {
    logger.warn('automation:parse-failed', { message: '模型输出不是 JSON' })
    return { kind: 'none' }
  }
  if (parsed.intent === false) {
    const speech = typeof (parsed as Record<string, unknown>).speech === 'string'
      ? String((parsed as Record<string, unknown>).speech).trim()
      : ''
    return { kind: 'none', ...(speech ? { speech } : {}) }
  }

  const raw = parsed as Record<string, unknown>
  // 模型给的一句人话：有它就用它当回问的开场，没有就用工件里写好的问法。
  const speech = typeof raw.speech === 'string' ? raw.speech.trim() : ''
  const source = typeof raw.source === 'string' ? raw.source.trim() : ''
  const catalog = deps.catalogs.find(item => item.id === source)
  const types = Array.isArray(raw.types) ? raw.types.map(item => String(item).trim()).filter(Boolean) : []

  // 闭集校验：类型必须在目录里。
  const validTypes = catalog ? types.filter(type => catalog.types().some(item => item.id === type)) : []
  const rejectedTypes = types.filter(type => !validTypes.includes(type))

  const params = raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)
    ? Object.fromEntries(Object.entries(raw.params as Record<string, unknown>).map(([key, value]) => [key, String(value ?? '')]))
    : {}
  const paramKeys = catalog ? catalog.params().map(item => item.key) : []
  const validParams = Object.fromEntries(Object.entries(params).filter(([key]) => paramKeys.includes(key)))

  const filter = filterOf(raw.filter)
  const mode: EventHandlingMode = raw.mode === 'review' || raw.mode === 'notify' ? raw.mode : 'auto'

  const projectName = typeof raw.project === 'string' ? raw.project.trim() : ''
  const project = resolveProject(projectName, deps.projects)

  const skillId = typeof raw.skill === 'string' ? raw.skill.trim() : ''
  const skill = skills.find(item => item.id === skillId)

  const schedule = scheduleOf(raw.schedule)
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''

  // 缺项判定：一次只报一项，按「来源 → 类型 → 参数 → 项目 → 模式 → 计划 → 名称 → 提示词」的顺序。
  const missing: string[] = []
  if (source && !catalog) {
    // 来源名不在目录里：这是「拒绝并说明目录里实际有什么」的场景（§12.1 V5）。
    logger.warn('automation:session-rejected', { reason: 'unknown-type', source })
    return {
      kind: 'clarify',
      question: `目录里没有「${source}」这个来源。目前可订阅的是：${deps.catalogs.map(item => `${item.name}（${item.id}）`).join('、') || '（空）'}。`,
      missing: ['source'],
      ...(speech ? { speech } : {}),
    }
  }
  if (!source) missing.push('source')
  else if (catalog && rejectedTypes.length > 0) {
    // 模型给了目录里没有的类型：明确拒掉并列出目录里实际有什么（§12.1 V5）。
    logger.warn('automation:session-rejected', { reason: 'unknown-type', types: rejectedTypes })
    return {
      kind: 'clarify',
      question: `目录里没有「${rejectedTypes.join('、')}」这些事件类型。${catalog.name} 下可选的是：${catalog.types().map(item => item.id).join('、')}。`,
      missing: ['types'],
      ...(speech ? { speech } : {}),
    }
  }
  else if (catalog && validTypes.length === 0) missing.push('types')
  // 目录声明的必填参数必须问到。
  const requiredParams = catalog
    ? catalog.params().filter(item => item.required && !validParams[item.key]?.trim())
    : []
  if (requiredParams.length > 0) missing.push('params')

  // 参数探活：格式对但资源不存在（如「订阅不存在的仓库 xxx/yyy」）也要拦下来，
  // 否则任务建好了却永远等不到事件（§12.1 V6）。
  if (source && catalog && requiredParams.length === 0 && deps.probeParams) {
    const invalid = await deps.probeParams(source, validParams)
    if (invalid) {
      logger.warn('automation:session-rejected', { reason: 'invalid-param', source, params: validParams })
      return {
        kind: 'clarify',
        question: invalid,
        missing: ['params'],
        ...(speech ? { speech } : {}),
      }
    }
  }
  if (!project) missing.push('project')
  if (!schedule && !source) missing.push('schedule')
  if (!skill && skills.length > 0) missing.push('skill')
  if (!name) missing.push('name')
  if (!prompt) missing.push('prompt')

  if (missing.length > 0) {
    const field = missing[0]!
    logger.info('automation:session-step', { step: 'clarify', missing })
    return {
      kind: 'clarify',
      question: ASK[field]?.({ catalogs: deps.catalogs, projects: deps.projects }) ?? '请再说清楚一点。',
      missing,
      ...(speech ? { speech } : {}),
    }
  }

  const task: AutomationTaskDraft = {
    name,
    description: text.trim().slice(0, 200),
    type: raw.type === 'script' ? 'script' : 'ai',
    prompt,
    ...(source ? {
      subscription: {
        source,
        types: validTypes,
        params: validParams,
        filter,
        mode,
      },
    } : {}),
    ...(schedule ? { schedule } : {}),
    project: project!.name,
    skill: skill!.id,
    notifyTo: typeof raw.notifyTo === 'string' ? raw.notifyTo.trim() : '',
  }
  logger.info('automation:session-step', { step: 'parse', missing: [] })
  return { kind: 'task', task, ...(speech ? { speech } : {}) }
}

/** 目录文本：给模型看的「可订阅事件源与类型」。 */
export function catalogTextOf(catalogs: EventCatalog[]): string {
  const lines: string[] = []
  for (const catalog of catalogs) {
    lines.push(`[来源] ${catalog.id}（${catalog.name}）`)
    for (const type of catalog.types()) {
      const note = type.availability?.note
      lines.push(`  - ${type.id} · ${type.label}${note ? ` · ${note}` : ''}`)
    }
  }
  return lines.join('\n')
}

/** 提示词：闭集约束写清楚，模型不许外扩。 */
function systemPrompt(catalogText: string, projectText: string, skillText: string): string {
  return [
    '你把用户的一句话整理成一条「自动化任务」的参数。只输出一个 JSON 对象，不要解释。',
    '',
    '# 任务 = 订阅什么 + 触发后做什么',
    '事件触发：trigger = { source, types[], params, filter, mode }',
    '定时触发：trigger = { kind: "schedule", schedule }',
    'mode 只能是 auto（命中就做）/ review（命中先给人看）/ notify（只记录并提醒）。',
    '',
    '# 可用的事件源与类型',
    catalogText,
    '',
    '# 候选项目（只能从中选）',
    projectText || '（没有候选项目）',
    '',
    '# 候选处理方式（只能从中选）',
    skillText,
    '',
    '# 硬约束',
    '1. source 必须是目录里列出来的 id；types 每项必须在该 source 的类型清单里。',
    '2. params 的 key 必须是该 source 声明的参数。',
    '3. project 必须是候选项目之一；skill 必须是候选处理方式之一。',
    '4. 拿不准就留空（不要编造），宿主会回问你缺什么。',
    '5. 只选标了「开箱可用」的类型；标了前置条件的要在 reason 里提醒用户。',
    '',
    '# 输出格式',
    '{"intent":true,"speech":"先对用户说一句话（20 字以内，说你打算怎么做）","name":"任务名","type":"ai|script","prompt":"要做什么",',
    '"source":"目录里的来源 id","types":["目录里的类型 id"],',
    '"params":{"键":"值"},"filter":{"keywords":["词"],"semantic":"自然语言过滤条件"},',
    '"mode":"auto|review|notify","schedule":null,',
    '"project":"项目名","skill":"skill-id","reason":"一句话说明"}',
    '不是自动化需求时输出 {"intent":false,"speech":"这句没看出要建自动化任务"}。',
  ].join('\n')
}

/** 解析过滤条件。 */
function filterOf(value: unknown): EventFilter {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.map(item => String(item).trim()).filter(Boolean)
    : []
  const semantic = typeof raw.semantic === 'string' ? raw.semantic.trim() : ''
  return {
    ...(keywords.length ? { keywords } : {}),
    ...(semantic ? { semantic } : {}),
  }
}

/** 解析定时计划；非法时返回 undefined（不算缺项，交给回问）。 */
function scheduleOf(value: unknown): AutomationSchedule | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const kind = raw.kind
  if (kind !== 'hourly' && kind !== 'daily' && kind !== 'weekly' && kind !== 'cron') return undefined
  const schedule: AutomationSchedule = { kind }
  if (typeof raw.at === 'string') schedule.at = raw.at.trim()
  if (typeof raw.weekday === 'number' && Number.isInteger(raw.weekday)) schedule.weekday = raw.weekday
  if (typeof raw.time === 'string') schedule.time = raw.time.trim()
  if (typeof raw.cron === 'string') schedule.cron = raw.cron.trim()
  return validateSchedule(schedule) ? undefined : schedule
}

/** 项目名解析：命中闭集才返回；只有一个项目时可以直接采用。 */
export function resolveProject(name: string, projects: ProjectConfig[]): ProjectConfig | undefined {
  if (name) {
    const want = name.toLowerCase()
    const hit = projects.find(project =>
      project.name.toLowerCase() === want
      || project.repo.toLowerCase() === want
      || project.repo.toLowerCase().endsWith(`/${want}`))
    return hit
  }
  return projects.length === 1 ? projects[0] : undefined
}

/** 目录里某个来源的类型清单（给面板与提示词用）。 */
export function typesOf(catalog: EventCatalog | undefined): EventTypeDescriptor[] {
  return catalog?.types() ?? []
}
