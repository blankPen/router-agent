/**
 * Web 面板的 API 请求与配置快照类型。
 *
 * 单独放一个文件，避免 runtime-cards.tsx 反向 import app.tsx 形成循环依赖。
 */
import type { RuntimeChoiceView } from './runtime-model.js'
import type { IdentityStatusView } from './identity-status.js'
import type { RuntimeOptionSpec } from '#runtime/runtimes/options.js'

export type { IdentityEntryView, IdentityStatusView } from './identity-status.js'

export type ConfigDoc = Record<string, any>

export interface ConfigBundle {
  config: ConfigDoc
  defaults: ConfigDoc
  configPath: string
  runtimeChoices?: RuntimeChoiceView[]
  detecting?: boolean
  /** 插件目录与加载状态；旧版服务端可能没有这个字段。 */
  plugins?: PluginView[]
  /** 允许名单与机器人身份的解析状态；旧版服务端可能没有这个字段。 */
  identity?: IdentityStatusView
  /** 保存后立即生效的配置路径前缀；旧版服务端可能没有这个字段。 */
  hotPaths?: string[]
}

/** 服务端已注册的消息渠道。 */
export interface ChannelRegistryView {
  channels?: { id: string; kind: string }[]
}

export type PluginKind = 'runtime' | 'channel'

export interface PluginView {
  id: string
  kind: PluginKind
  name?: string
  label?: string
  hint?: string
  installHint?: string
  installUrl?: string
  packageName?: string
  default?: boolean
  entry?: unknown
  loadedIds?: string[]
  /** 运行时插件声明的配置项；自定义运行时据此渲染设置弹窗。 */
  options?: RuntimeOptionSpec
  status: 'builtin' | 'configured' | 'loaded' | 'failed'
  error?: string
  /** 加载失败时实际尝试的包名 / 路径。 */
  specifier?: string
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  const data = await res.json()
  if (!res.ok) throw new Error((data as { message?: string; error?: string }).message ?? (data as { error?: string }).error ?? `HTTP ${res.status}`)
  return data as T
}

export async function sendJson<T>(path: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) {
    const failure = data as { error?: string; message?: string; errors?: { path: string; message: string }[] }
    const detail = failure.errors?.map(item => `${item.path}: ${item.message}`).join('；')
    throw new Error(detail || failure.message || failure.error || `HTTP ${res.status}`)
  }
  return data as T
}

/** 配置保存的统一返回；两个配置页共用。 */
export interface ConfigSaveResult extends ConfigBundle {
  changed: string[]
  restartRequired: boolean
  policyChanged: boolean
  /** 允许名单是否已即时生效；`false` 表示保存后重解析失败，新名单还没生效。 */
  identityEffective?: boolean
}

/** 本机 LLM Provider 候选（服务端已剥掉明文密钥）。 */
export interface LocalProviderView {
  id: string
  source: string
  sourceLabel: string
  name: string
  baseUrl: string
  model: string
  api: string
  authHeader?: boolean
  contextWindow?: number
  apiKeySet: boolean
}

export interface LocalProviderSourceStatus {
  id: string
  label: string
  path: string
  found: boolean
  error?: string
}

export interface LocalProviderList {
  candidates: LocalProviderView[]
  sources: LocalProviderSourceStatus[]
}

export interface LocalProviderImportResult extends ConfigSaveResult {
  imported: {
    id: string
    source: string
    sourceLabel: string
    name: string
    baseUrl: string
    model: string
    api: string
  }
}

export async function listLocalProviders(): Promise<LocalProviderList> {
  return getJson<LocalProviderList>('/api/llm/local-providers')
}

export async function importLocalProvider(id: string): Promise<LocalProviderImportResult> {
  return sendJson<LocalProviderImportResult>('/api/llm/local-providers/import', 'POST', { id })
}

export async function saveConfigPatch(patch: Record<string, unknown>): Promise<ConfigSaveResult> {
  return sendJson<ConfigSaveResult>('/api/config', 'PUT', { patch })
}
