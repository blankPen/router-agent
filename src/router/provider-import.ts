/**
 * 从本机已有的 Agent 配置里发现 LLM Provider。
 *
 * 支持这些来源（都在用户主目录下，只读，不改动原文件）：
 * - Claude Code：`~/.claude/settings.json` 的 `env`（ANTHROPIC_BASE_URL / ANTHROPIC_*_MODEL）；
 * - CCSwitch：新版 `~/.cc-switch/cc-switch.db`（SQLite providers 表）与旧版 `config.json`；
 * - Pi：`~/.pi/agent/models.json`；
 * - OpenCode：`~/.config/opencode/opencode.json`；
 * - Magpie：`~/.config/magpie/providers.json`。
 *
 * 安全约束：`apiKey` 只保留在服务端候选对象里，`toLocalProviderView` 负责剥掉，
 * 任何日志 / HTTP 响应都不得出现明文密钥。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LLM_APIS, type LlmApi } from '../config.js'

export type LocalProviderSource = 'claude-code' | 'cc-switch' | 'pi' | 'opencode' | 'magpie'

export interface LocalProviderCandidate {
  /** 稳定标识；导入时按它重新发现，不接受客户端传路径或密钥。 */
  id: string
  source: LocalProviderSource
  sourceLabel: string
  name: string
  baseUrl: string
  model: string
  api: LlmApi
  /** anthropic-messages 下是否用 Authorization: Bearer。 */
  authHeader?: boolean
  contextWindow?: number
  /** 只留在服务端，永不下发。 */
  apiKey: string
}

/** 下发给面板的候选：不含明文密钥。 */
export type LocalProviderView = Omit<LocalProviderCandidate, 'apiKey'> & { apiKeySet: boolean }

export interface LocalProviderSourceStatus {
  id: LocalProviderSource
  label: string
  /** 实际读取的路径；找不到时为第一个候选路径。 */
  path: string
  found: boolean
  /** 读取失败原因（不含密钥）。 */
  error?: string
}

export interface LocalProviderScan {
  candidates: LocalProviderCandidate[]
  sources: LocalProviderSourceStatus[]
}

export interface DiscoverLocalProvidersOptions {
  /** 用户主目录；默认取 `os.homedir()`。测试可注入临时目录。 */
  home: string
  env?: NodeJS.ProcessEnv
  /** 覆盖默认路径，便于测试。 */
  claudeSettingsPaths?: string[]
  piModelsPath?: string
  ccSwitchDbPath?: string
  ccSwitchConfigPath?: string
  opencodeConfigPath?: string
  magpieProvidersPath?: string
}

const SOURCE_LABELS: Record<LocalProviderSource, string> = {
  'claude-code': 'Claude Code',
  'cc-switch': 'CCSwitch',
  pi: 'Pi',
  opencode: 'OpenCode',
  magpie: 'Magpie',
}

/** 把服务端候选变成可以安全下发的视图。 */
export function toLocalProviderView(candidate: LocalProviderCandidate): LocalProviderView {
  const { apiKey, ...rest } = candidate
  return { ...rest, apiKeySet: Boolean(apiKey) }
}

/**
 * 扫描本机配置。单个来源失败不影响其它来源；失败原因写进 sources 供面板提示。
 */
export async function discoverLocalProviders(opts: DiscoverLocalProvidersOptions): Promise<LocalProviderScan> {
  const env = opts.env ?? process.env
  const home = opts.home
  const candidates: LocalProviderCandidate[] = []
  const sources: LocalProviderSourceStatus[] = []

  const claudePaths = opts.claudeSettingsPaths ?? [join(home, '.claude', 'settings.json')]
  const claudeStatus: LocalProviderSourceStatus = {
    id: 'claude-code',
    label: SOURCE_LABELS['claude-code'],
    path: claudePaths[0] ?? join(home, '.claude', 'settings.json'),
    found: false,
  }
  for (const path of claudePaths) {
    const result = readClaudeCodeSettings(path)
    if (result.found) claudeStatus.found = true
    if (result.error && !claudeStatus.error) claudeStatus.error = result.error
    candidates.push(...result.candidates)
  }
  sources.push(claudeStatus)

  const dbPath = opts.ccSwitchDbPath ?? join(home, '.cc-switch', 'cc-switch.db')
  const legacyPath = opts.ccSwitchConfigPath ?? join(home, '.cc-switch', 'config.json')
  const ccStatus: LocalProviderSourceStatus = {
    id: 'cc-switch',
    label: SOURCE_LABELS['cc-switch'],
    path: existsSync(dbPath) ? dbPath : legacyPath,
    found: false,
  }
  if (existsSync(dbPath)) {
    ccStatus.found = true
    const result = await readCcSwitchDb(dbPath)
    if (result.error) ccStatus.error = result.error
    candidates.push(...result.candidates)
  }
  if (existsSync(legacyPath)) {
    ccStatus.found = true
    const result = readCcSwitchLegacy(legacyPath)
    if (result.error && !ccStatus.error) ccStatus.error = result.error
    candidates.push(...result.candidates)
  }
  sources.push(ccStatus)

  const piPath = opts.piModelsPath ?? join(home, '.pi', 'agent', 'models.json')
  const piStatus: LocalProviderSourceStatus = {
    id: 'pi',
    label: SOURCE_LABELS.pi,
    path: piPath,
    found: existsSync(piPath),
  }
  if (piStatus.found) {
    const result = readPiModels(piPath, env)
    if (result.error) piStatus.error = result.error
    candidates.push(...result.candidates)
  }
  sources.push(piStatus)

  const opencodePath = opts.opencodeConfigPath ?? join(home, '.config', 'opencode', 'opencode.json')
  const opencodeStatus: LocalProviderSourceStatus = {
    id: 'opencode',
    label: SOURCE_LABELS.opencode,
    path: opencodePath,
    found: existsSync(opencodePath),
  }
  if (opencodeStatus.found) {
    const result = readOpencodeConfig(opencodePath, env)
    if (result.error) opencodeStatus.error = result.error
    candidates.push(...result.candidates)
  }
  sources.push(opencodeStatus)

  const magpiePath = opts.magpieProvidersPath ?? join(home, '.config', 'magpie', 'providers.json')
  const magpieStatus: LocalProviderSourceStatus = {
    id: 'magpie',
    label: SOURCE_LABELS.magpie,
    path: magpiePath,
    found: existsSync(magpiePath),
  }
  if (magpieStatus.found) {
    const result = readMagpieProviders(magpiePath)
    if (result.error) magpieStatus.error = result.error
    candidates.push(...result.candidates)
  }
  sources.push(magpieStatus)

  return { candidates: dedupe(candidates), sources }
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/** 读取 Claude Code settings.json 的 env 块；文件不存在不算错误。 */
function readClaudeCodeSettings(path: string): { found: boolean; candidates: LocalProviderCandidate[]; error?: string } {
  if (!existsSync(path)) return { found: false, candidates: [] }
  const doc = readJson(path)
  if (!doc.ok) return { found: true, candidates: [], error: doc.error }
  const env = isRecord(doc.value) && isRecord(doc.value.env) ? doc.value.env : undefined
  if (!env) return { found: true, candidates: [] }
  const parsed = fromAnthropicEnv(env)
  if (!parsed) return { found: true, candidates: [] }
  return {
    found: true,
    candidates: [{
      id: `claude-code:${path}`,
      source: 'claude-code',
      sourceLabel: SOURCE_LABELS['claude-code'],
      name: `Claude Code · ${parsed.model}`,
      ...parsed,
    }],
  }
}

interface AnthropicEnvCandidate {
  baseUrl: string
  apiKey: string
  model: string
  api: LlmApi
  authHeader?: boolean
}

/** 从 ANTHROPIC_* 环境块里取出连接信息；缺一项就返回 null。 */
function fromAnthropicEnv(env: Record<string, unknown>): AnthropicEnvCandidate | null {
  const baseUrl = text(env.ANTHROPIC_BASE_URL)
  const authToken = text(env.ANTHROPIC_AUTH_TOKEN)
  const apiKey = authToken || text(env.ANTHROPIC_API_KEY)
  const model = normalizeModelId(
    text(env.ANTHROPIC_MODEL)
      || text(env.ANTHROPIC_DEFAULT_SONNET_MODEL)
      || text(env.ANTHROPIC_DEFAULT_OPUS_MODEL)
      || text(env.ANTHROPIC_DEFAULT_HAIKU_MODEL)
      || text(env.ANTHROPIC_DEFAULT_FABLE_MODEL),
  )
  if (!baseUrl || !apiKey || !model) return null
  return {
    baseUrl,
    apiKey,
    model,
    api: 'anthropic-messages',
    // ANTHROPIC_AUTH_TOKEN 的语义是 Authorization: Bearer；ANTHROPIC_API_KEY 才是 x-api-key。
    ...(authToken ? { authHeader: true } : {}),
  }
}

/** Claude Code / Magpie 允许用 `model[1m]` 标记上下文；真正发给网关的模型名不带这个后缀。 */
function normalizeModelId(model: string): string {
  return model.replace(/\[[0-9]+[kKmM]\]$/, '').trim()
}

/** 从 `[200k]` / `[1M]` 这类标记推断上下文窗口。 */
function contextFromMarker(model: string): number | undefined {
  const match = /\[([0-9]+)([kKmM])\]$/.exec(model)
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return undefined
  return match[2]!.toLowerCase() === 'm' ? value * 1_000_000 : value * 1_000
}

// ---------------------------------------------------------------------------
// CCSwitch（SQLite / 旧版 JSON）
// ---------------------------------------------------------------------------

interface CcSwitchRow {
  id: string
  appType: string
  name: string
  settings: unknown
}

/** 只读打开 CCSwitch SQLite，逐行解析 providers 表；锁库等错误降级为 source.error。 */
async function readCcSwitchDb(path: string): Promise<{ candidates: LocalProviderCandidate[]; error?: string }> {
  let db: import('node:sqlite').DatabaseSync | undefined
  try {
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(path, { readOnly: true })
    const rows = db.prepare(
      'SELECT id, app_type AS appType, name, settings_config AS settingsConfig FROM providers ORDER BY app_type, is_current DESC, sort_index',
    ).all() as unknown as { id: unknown; appType: unknown; name: unknown; settingsConfig: unknown }[]
    const candidates: LocalProviderCandidate[] = []
    for (const row of rows) {
      const settings = parseJsonText(row.settingsConfig)
      if (!settings) continue
      candidates.push(...candidatesFromCcSwitchRow({
        id: String(row.id ?? ''),
        appType: String(row.appType ?? ''),
        name: String(row.name ?? ''),
        settings,
      }))
    }
    return { candidates }
  } catch (error) {
    return { candidates: [], error: error instanceof Error ? error.message : String(error) }
  } finally {
    try { db?.close() } catch { /* 关闭失败不影响已经读到的结果 */ }
  }
}

/** 兼容旧版 CCSwitch config.json（只处理 claude 一类）。 */
function readCcSwitchLegacy(path: string): { candidates: LocalProviderCandidate[]; error?: string } {
  const doc = readJson(path)
  if (!doc.ok) return { candidates: [], error: doc.error }
  const rows = collectLegacyClaudeProviders(doc.value)
  const candidates: LocalProviderCandidate[] = []
  for (const row of rows) {
    candidates.push(...candidatesFromCcSwitchRow(row))
  }
  return { candidates }
}

/** 旧版 config.json 有几种历史结构，这里做宽松识别，只处理 claude 一类。 */
function collectLegacyClaudeProviders(root: unknown): CcSwitchRow[] {
  if (!isRecord(root)) return []
  const buckets: unknown[] = []
  if (isRecord(root.claude) && isRecord(root.claude.providers)) buckets.push(root.claude.providers)
  if (isRecord(root.providers) && isRecord(root.providers.claude)) {
    const claude = root.providers.claude
    buckets.push(isRecord(claude.providers) ? claude.providers : claude)
  }
  const rows: CcSwitchRow[] = []
  for (const bucket of buckets) {
    if (!isRecord(bucket)) continue
    for (const [key, value] of Object.entries(bucket)) {
      if (!isRecord(value)) continue
      const settings = isRecord(value.settingsConfig) ? value.settingsConfig
        : isRecord(value.settings_config) ? value.settings_config
          : value
      rows.push({
        id: text(value.id) || key,
        appType: 'claude',
        name: text(value.name) || key,
        settings,
      })
    }
  }
  return rows
}

/** 把一行 CCSwitch provider 转成候选；claude 走 env，其余走通用结构。 */
function candidatesFromCcSwitchRow(row: CcSwitchRow): LocalProviderCandidate[] {
  const key = `${row.appType}:${row.id}`
  if (row.appType === 'claude') {
    const env = isRecord(row.settings) && isRecord(row.settings.env) ? row.settings.env : undefined
    if (!env) return []
    const parsed = fromAnthropicEnv(env)
    if (!parsed) return []
    return [{
      id: `cc-switch:${key}`,
      source: 'cc-switch',
      sourceLabel: SOURCE_LABELS['cc-switch'],
      name: `CCSwitch · ${row.name || parsed.model}`,
      ...parsed,
    }]
  }
  return candidatesFromGenericSettings(row, key)
}

/**
 * CCSwitch 里 opencode / openclaw / pi 这类 App 的 settings_config 基本都是
 * `{ baseUrl, api, apiKey, models[] }` 的变体（opencode 用 options.baseURL）。
 */
function candidatesFromGenericSettings(row: CcSwitchRow, key: string): LocalProviderCandidate[] {
  if (!isRecord(row.settings)) return []
  const settings = row.settings
  const options = isRecord(settings.options) ? settings.options : {}
  const baseUrl = text(settings.baseUrl) || text(options.baseURL) || text(options.baseUrl)
  const rawKey = text(settings.apiKey) || text(options.apiKey)
  if (!baseUrl || !rawKey) return []
  const rawApi = text(settings.api) || text(options.api)
  const api: LlmApi = (LLM_APIS as readonly string[]).includes(rawApi) ? rawApi as LlmApi : 'openai-completions'
  const modelEntries = genericModelEntries(settings.models)
  const candidates: LocalProviderCandidate[] = []
  if (modelEntries.length === 0) {
    const model = text(options.model) || text(settings.model)
    if (!model) return []
    candidates.push({
      id: `cc-switch:${key}:${model}`,
      source: 'cc-switch',
      sourceLabel: SOURCE_LABELS['cc-switch'],
      name: `CCSwitch · ${row.name || model}`,
      baseUrl,
      model,
      apiKey: rawKey,
      api,
      ...(settings.authHeader === true ? { authHeader: true } : {}),
    })
    return candidates
  }
  for (const [index, model] of modelEntries.entries()) {
    const id = text(model.id)
    if (!id) continue
    candidates.push({
      id: `cc-switch:${key}:${id}:${index}`,
      source: 'cc-switch',
      sourceLabel: SOURCE_LABELS['cc-switch'],
      name: `CCSwitch · ${row.name || id}${text(model.name) && text(model.name) !== id ? `（${text(model.name)}）` : ''}`,
      baseUrl,
      model: id,
      apiKey: rawKey,
      api: (() => {
        const modelApi = text(model.api)
        return (LLM_APIS as readonly string[]).includes(modelApi) ? modelApi as LlmApi : api
      })(),
      ...(settings.authHeader === true ? { authHeader: true } : {}),
      ...contextWindowOf(model.contextWindow),
    })
  }
  return candidates
}

/** CCSwitch 的 models 既有数组（openclaw / pi）也有对象（opencode），统一成数组。 */
function genericModelEntries(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord)
  if (isRecord(value)) {
    return Object.entries(value).map(([id, item]) => ({ id, ...(isRecord(item) ? item : {}) }))
  }
  return []
}

// ---------------------------------------------------------------------------
// Pi models.json
// ---------------------------------------------------------------------------

/** 读取 Pi models.json 的 providers 与模型清单。 */
function readPiModels(path: string, env: NodeJS.ProcessEnv): { candidates: LocalProviderCandidate[]; error?: string } {
  const doc = readJson(path)
  if (!doc.ok) return { candidates: [], error: doc.error }
  if (!isRecord(doc.value) || !isRecord(doc.value.providers)) return { candidates: [] }
  const candidates: LocalProviderCandidate[] = []
  for (const [providerId, provider] of Object.entries(doc.value.providers)) {
    if (!isRecord(provider)) continue
    const baseUrl = text(provider.baseUrl)
    const apiKey = resolveEnvRef(text(provider.apiKey), env)
    if (!baseUrl || !apiKey) continue
    const models = Array.isArray(provider.models) ? provider.models : []
    for (const [index, model] of models.entries()) {
      if (!isRecord(model)) continue
      const id = text(model.id)
      if (!id) continue
      const rawApi = text(model.api) || text(provider.api)
      candidates.push({
        id: `pi:${providerId}:${id}:${index}`,
        source: 'pi',
        sourceLabel: SOURCE_LABELS.pi,
        name: `Pi · ${text(model.name) || id}`,
        baseUrl: text(model.baseUrl) || baseUrl,
        model: id,
        apiKey,
        api: (LLM_APIS as readonly string[]).includes(rawApi) ? rawApi as LlmApi : 'openai-completions',
        ...(provider.authHeader === true ? { authHeader: true } : {}),
        ...contextWindowOf(model.contextWindow),
      })
    }
  }
  return { candidates }
}

/** `$NAME` / `${NAME}` 从环境变量取值；`!command` 不执行（发现阶段不做副作用）。 */
function resolveEnvRef(value: string, env: NodeJS.ProcessEnv): string {
  if (!value) return ''
  const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(value)
  if (!match) return value.startsWith('!') ? '' : value
  return text(env[match[1] ?? match[2] ?? ''])
}

// ---------------------------------------------------------------------------
// OpenCode（~/.config/opencode/opencode.json）
// ---------------------------------------------------------------------------

/** 读取 OpenCode opencode.json 的 provider.options 与 models。 */
function readOpencodeConfig(path: string, env: NodeJS.ProcessEnv): { candidates: LocalProviderCandidate[]; error?: string } {
  const doc = readJson(path)
  if (!doc.ok) return { candidates: [], error: doc.error }
  if (!isRecord(doc.value) || !isRecord(doc.value.provider)) return { candidates: [] }
  const candidates: LocalProviderCandidate[] = []
  for (const [providerId, provider] of Object.entries(doc.value.provider)) {
    if (!isRecord(provider)) continue
    const options = isRecord(provider.options) ? provider.options : {}
    const baseUrl = text(options.baseURL) || text(options.baseUrl) || text(provider.baseURL)
    const apiKey = resolveOpencodeSecret(options.apiKey, env)
    if (!baseUrl || !apiKey) continue
    const npm = text(provider.npm)
    const api: LlmApi = /anthropic/i.test(npm) ? 'anthropic-messages' : 'openai-completions'
    const models = isRecord(provider.models) ? Object.entries(provider.models) : []
    for (const [index, [modelId, model]] of models.entries()) {
      const id = normalizeModelId(modelId)
      if (!id) continue
      const entry = isRecord(model) ? model : {}
      const limit = isRecord(entry.limit) ? entry.limit : {}
      const contextWindow = typeof limit.context === 'number' ? limit.context
        : typeof entry.contextWindow === 'number' ? entry.contextWindow
          : contextFromMarker(modelId)
      candidates.push({
        id: `opencode:${providerId}:${id}:${index}`,
        source: 'opencode',
        sourceLabel: SOURCE_LABELS.opencode,
        name: `OpenCode · ${text(provider.name) || providerId} · ${id}`,
        baseUrl,
        model: id,
        apiKey,
        api,
        ...contextWindowOf(contextWindow),
      })
    }
  }
  return { candidates }
}

/** OpenCode 的 apiKey 支持字符串与 `{ env: "VAR" }` 两种写法。 */
function resolveOpencodeSecret(value: unknown, env: NodeJS.ProcessEnv): string {
  if (typeof value === 'string') return text(value)
  if (isRecord(value) && typeof value.env === 'string') return text(env[value.env])
  return ''
}

// ---------------------------------------------------------------------------
// Magpie（~/.config/magpie/providers.json）
// ---------------------------------------------------------------------------

/** 读取 Magpie providers.json，按 chat / anthropic 地址生成候选。 */
function readMagpieProviders(path: string): { candidates: LocalProviderCandidate[]; error?: string } {
  const doc = readJson(path)
  if (!doc.ok) return { candidates: [], error: doc.error }
  if (!isRecord(doc.value) || !Array.isArray(doc.value.providers)) return { candidates: [] }
  const candidates: LocalProviderCandidate[] = []
  for (const [providerIndex, provider] of doc.value.providers.entries()) {
    if (!isRecord(provider)) continue
    const apiKey = text(provider.key)
    if (!apiKey) continue
    const target = magpieTarget(provider)
    if (!target) continue
    const models = magpieModels(provider)
    const providerName = text(provider.name) || text(provider.id) || `provider-${providerIndex + 1}`
    for (const [index, rawModel] of models.entries()) {
      const id = normalizeModelId(rawModel)
      if (!id) continue
      const contextWindow = contextFromMarker(rawModel)
      candidates.push({
        id: `magpie:${text(provider.id) || providerIndex}:${id}:${index}`,
        source: 'magpie',
        sourceLabel: SOURCE_LABELS.magpie,
        name: `Magpie · ${providerName} · ${id}`,
        baseUrl: target.baseUrl,
        model: id,
        apiKey,
        api: target.api,
        ...(target.authHeader ? { authHeader: true } : {}),
        ...contextWindowOf(contextWindow),
      })
    }
  }
  return { candidates }
}

/** Magpie 同时存 chat / anthropic / responses 地址；优先按 baseAPI，其次 OpenAI 兼容。 */
function magpieTarget(provider: Record<string, unknown>): { baseUrl: string; api: LlmApi; authHeader?: boolean } | null {
  const chat = text(provider.chat)
  const anthropic = text(provider.anthropic)
  const baseApi = text(provider.baseAPI)
  if (baseApi === 'anthropic' && anthropic) {
    return { baseUrl: anthropic, api: 'anthropic-messages', authHeader: true }
  }
  if (chat) return { baseUrl: chat, api: 'openai-completions' }
  if (anthropic) return { baseUrl: anthropic, api: 'anthropic-messages', authHeader: true }
  return null
}

/** Magpie 的 models 可能是字符串或对象；没有列表时退回单个 model 字段。 */
function magpieModels(provider: Record<string, unknown>): string[] {
  const list = Array.isArray(provider.models) ? provider.models : []
  const models = list
    .map(item => (typeof item === 'string' ? item : isRecord(item) ? text(item.id) : ''))
    .filter(Boolean)
  if (models.length > 0) return models
  const single = text(provider.model)
  return single ? [single] : []
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

const MIN_CONTEXT_WINDOW = 1_000
const MAX_CONTEXT_WINDOW = 10_000_000

/**
 * 只保留配置校验器允许的上下文窗口。
 * 本地配置里的 0 / 负值 / 过小值会让整次导入被 applyConfigPatch 拒绝，
 * 这里提前丢弃，退回到默认上下文窗口。
 */
function contextWindowOf(value: unknown): { contextWindow: number } | Record<string, never> {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_CONTEXT_WINDOW
    && value <= MAX_CONTEXT_WINDOW
    ? { contextWindow: value }
    : {}
}

/** 读取并解析 JSON；失败返回错误文本供面板提示。 */
function readJson(path: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 解析 JSON 字符串（如 CCSwitch 的 settings_config），失败返回 undefined。 */
function parseJsonText(value: unknown): unknown {
  if (typeof value !== 'string') return undefined
  try { return JSON.parse(value) } catch { return undefined }
}

/** 判断是否为普通对象（排除数组与 null）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 只接受字符串并去掉首尾空白，其余类型返回空串。 */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 同一来源内按 baseUrl + model + api 去重，避免 settings.json 与备份条目重复。 */
function dedupe(candidates: LocalProviderCandidate[]): LocalProviderCandidate[] {
  const seen = new Set<string>()
  const result: LocalProviderCandidate[] = []
  for (const candidate of candidates) {
    const key = `${candidate.source}|${candidate.baseUrl}|${candidate.model}|${candidate.api}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(candidate)
  }
  return result
}
