/**
 * Web 面板的 API 请求与配置快照类型。
 *
 * 单独放一个文件，避免 runtime-cards.tsx 反向 import app.tsx 形成循环依赖。
 */
import type { RuntimeChoiceView } from './runtime-model.js'

export type ConfigDoc = Record<string, any>

export interface ConfigBundle {
  config: ConfigDoc
  defaults: ConfigDoc
  configPath: string
  runtimeChoices?: RuntimeChoiceView[]
  detecting?: boolean
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
}

export async function saveConfigPatch(patch: Record<string, unknown>): Promise<ConfigSaveResult> {
  return sendJson<ConfigSaveResult>('/api/config', 'PUT', { patch })
}
