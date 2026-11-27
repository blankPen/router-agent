/**
 * Web 面板的 API 请求与配置快照类型。
 *
 * 单独放一个文件，避免 runtime-cards.tsx 反向 import app.tsx 形成循环依赖。
 */
import type { RuntimeChoiceView } from './runtime-model.js'
import type { IdentityStatusView } from './identity-status.js'
import type { RuntimeOptionSpec } from '#runtime/runtimes/options.js'
import { tokenHeaders } from './access-token.js'

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
  const res = await fetch(path, { headers: tokenHeaders() })
  const data = await res.json()
  if (!res.ok) throw apiError(res.status, data)
  return data as T
}

export async function sendJson<T>(path: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...tokenHeaders() },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) {
    const failure = data as { error?: string; message?: string; errors?: { path: string; message: string }[] }
    const detail = failure.errors?.map(item => `${item.path}: ${item.message}`).join('；')
    throw apiError(res.status, data, detail)
  }
  return data as T
}

/** API 报错带上状态码：面板据此区分「没带令牌」与普通失败。 */
export interface ApiError extends Error {
  status: number
  code?: string
}

function apiError(status: number, data: unknown, detail?: string): ApiError {
  const failure = data as { error?: string; message?: string }
  const error = new Error(detail || failure.message || failure.error || `HTTP ${status}`) as ApiError
  error.status = status
  error.code = failure.error
  return error
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

/**
 * 订阅一条 SSE 流。
 *
 * 用 `fetch` + `ReadableStream` 而不是 `EventSource`：EventSource 只能 GET，
 * 而会话这一轮要带用户的原话（POST）。
 */
export interface EventStreamHandlers {
  /** 收到一个事件。`event` 是事件名（turn / done / error）。 */
  onEvent: (event: string, data: unknown) => void
  /** 流结束（正常或异常都会调）。 */
  onClose?: () => void
  /** 读流出错。 */
  onError?: (error: unknown) => void
}

export async function openEventStream(
  path: string,
  body: unknown,
  handlers: EventStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...tokenHeaders() },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => null)
      throw apiError(res.status, data)
    }
    await readEventStream(res.body, handlers)
  } catch (error) {
    // 主动中断不算失败：面板关闭会话面板时会 abort。
    if (signal?.aborted) {
      handlers.onClose?.()
      return
    }
    handlers.onError?.(error)
    handlers.onClose?.()
    return
  }
  handlers.onClose?.()
}

/** 逐段解析 SSE：`event:` / `data:` 两行一组，空行分隔。 */
export async function readEventStream(body: ReadableStream<Uint8Array>, handlers: EventStreamHandlers): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf('\n\n')
    while (index >= 0) {
      const chunk = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const parsed = parseSseChunk(chunk)
      if (parsed) handlers.onEvent(parsed.event, parsed.data)
      index = buffer.indexOf('\n\n')
    }
  }
}

/** 解析一段 SSE；心跳（`: ping`）与注释行返回 null。 */
export function parseSseChunk(chunk: string): { event: string; data: unknown } | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of chunk.split('\n')) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (dataLines.length === 0) return null
  const raw = dataLines.join('\n')
  try {
    return { event, data: JSON.parse(raw) }
  } catch {
    return { event, data: raw }
  }
}
