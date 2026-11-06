import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** Pi 会话需要的模型配置（OpenAI 兼容接口）。 */
export interface PiModelConfig {
  baseUrl: string
  apiKey: string
  model: string
  temperature?: number
}

export interface ResolveModelOptions {
  /** ~/.router-agent/config.yaml 路径。 */
  configPath?: string
  /** ~/.trove/config.json 路径。 */
  trovePath?: string
  env?: NodeJS.ProcessEnv
  /** 真实用户主目录，用于定位 .trove。 */
  home?: string
}

/**
 * 解析模型配置，优先级：环境变量 > ~/.router-agent/config.yaml > ~/.trove/config.json。
 * Pi 通过 OpenAI 兼容接口调用模型，这里只负责把连接信息准备好。
 */
export function resolvePiModelConfig(opts: ResolveModelOptions = {}): PiModelConfig {
  const env = opts.env ?? process.env
  const userHome = opts.home ?? homedir()
  const fromEnv = {
    ...(env.RA_LLM_BASE_URL ? { baseUrl: env.RA_LLM_BASE_URL } : {}),
    ...(env.RA_LLM_API_KEY ? { apiKey: env.RA_LLM_API_KEY } : {}),
    ...(env.RA_LLM_MODEL ? { model: env.RA_LLM_MODEL } : {}),
  }

  const raHome = env.RA_HOME ?? join(userHome, '.router-agent')
  const configPath = opts.configPath ?? join(raHome, 'config.yaml')
  const fromConfig = readYamlModel(configPath)

  const trovePath = opts.trovePath ?? join(userHome, '.trove', 'config.json')
  const fromTrove = readTroveModel(trovePath)

  const merged = { ...fromTrove, ...fromConfig, ...fromEnv }
  if (!merged.baseUrl || !merged.apiKey || !merged.model) {
    throw new Error('pi:model-config-missing: 需要 baseUrl / apiKey / model（环境变量 RA_LLM_*、~/.router-agent/config.yaml 或 ~/.trove/config.json）')
  }
  return merged as PiModelConfig
}

function readYamlModel(path: string): Partial<PiModelConfig> {
  if (!existsSync(path)) return {}
  try {
    const doc = parseYaml(readFileSync(path, 'utf8')) as Record<string, any> | null
    const llm = doc?.llm
    if (!llm) return {}
    return {
      ...(llm.baseUrl ? { baseUrl: String(llm.baseUrl) } : {}),
      ...(llm.apiKey ? { apiKey: String(llm.apiKey) } : {}),
      ...(llm.model ? { model: String(llm.model) } : {}),
      ...(llm.temperature !== undefined ? { temperature: Number(llm.temperature) } : {}),
    }
  } catch {
    return {}
  }
}

function readTroveModel(path: string): Partial<PiModelConfig> {
  if (!existsSync(path)) return {}
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
    const llm = doc?.llm
    if (!llm) return {}
    return {
      ...(llm.baseUrl ? { baseUrl: String(llm.baseUrl) } : {}),
      ...(llm.apiKey ? { apiKey: String(llm.apiKey) } : {}),
      ...(llm.model ? { model: String(llm.model) } : {}),
    }
  } catch {
    return {}
  }
}

/** 从模型自由文本里提取第一个 JSON 对象，容忍 ```json 包裹与前后说明。 */
export function extractJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1)) as Record<string, unknown>
        } catch {
          return null
        }
      }
    }
  }
  return null
}