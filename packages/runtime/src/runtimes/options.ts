/**
 * 运行时选项：每个运行时自己声明「可以配什么」，面板按声明渲染、后端按声明校验。
 *
 * 这里只放纯类型与纯函数，不能依赖任何 Node 内置模块 —— Web 面板会把它一起打进前端包。
 * 配置落点是通用的 `runtime.options.<runtimeId>.<key>`，新增运行时不需要改内核或面板。
 */
import { ORCA_OPTION_SPEC, HERDR_OPTION_SPEC } from './builtin-options.js'
export { ORCA_OPTION_SPEC, HERDR_OPTION_SPEC } from './builtin-options.js'

export type RuntimeOptionKind = 'text' | 'select' | 'switch' | 'number'

export interface RuntimeOptionValue {
  value: string
  label: string
  hint?: string
}

export interface RuntimeOptionField {
  /** 选项键；配置里对应 `runtime.options.<runtimeId>.<key>`。 */
  key: string
  label: string
  kind: RuntimeOptionKind
  /**
   * 未配置时的声明式默认值。
   *
   * 运行时与面板都从这里取值，避免「默认值」散落在 adapter、面板、文档三处。
   * 有些工具的选项没有可省略的形态（例如 Orca 的 `--prompt` 必须配 `--agent`），
   * 这种情况就靠这里给出一个真实默认值，而不是让调用方猜。
   */
  default?: string | number | boolean
  /** kind=select 时的候选取值。 */
  options?: RuntimeOptionValue[]
  placeholder?: string
  hint?: string
  /** kind=number 时的取值范围。 */
  min?: number
  max?: number
}

export interface RuntimeOptionSpec {
  runtimeId: string
  fields: RuntimeOptionField[]
}

/** 所有运行时的选项声明；新增运行时在这里加一行即可。 */
export const RUNTIME_OPTION_SPECS: readonly RuntimeOptionSpec[] = [ORCA_OPTION_SPEC, HERDR_OPTION_SPEC]

export function optionSpecOf(runtimeId: string): RuntimeOptionSpec | null {
  return RUNTIME_OPTION_SPECS.find(spec => spec.runtimeId === runtimeId) ?? null
}

export function optionFieldOf(runtimeId: string, key: string): RuntimeOptionField | null {
  return optionSpecOf(runtimeId)?.fields.find(field => field.key === key) ?? null
}

/** 某个选项未配置时的声明式默认值；没有声明返回 undefined。 */
export function runtimeOptionDefault(runtimeId: string, key: string): unknown {
  return optionFieldOf(runtimeId, key)?.default
}

/** 配置里的点路径：runtime.options.<runtimeId>.<key>。 */
export function runtimeOptionPath(runtimeId: string, key: string): string {
  return `runtime.options.${runtimeId}.${key}`
}

/** 解析 `runtime.options.<runtimeId>.<key>`；不是这个形状返回 null。 */
export function parseRuntimeOptionPath(path: string): { runtimeId: string; key: string } | null {
  const match = /^runtime\.options\.([^.]+)\.([^.]+)$/.exec(path)
  if (!match) return null
  return { runtimeId: match[1]!, key: match[2]! }
}

/** 全部已声明的选项路径；面板据此判断「哪些配置被改过」。 */
export function runtimeOptionPaths(): string[] {
  return RUNTIME_OPTION_SPECS.flatMap(spec =>
    spec.fields.map(field => runtimeOptionPath(spec.runtimeId, field.key)))
}

/**
 从配置里取某个运行时的字符串选项。
 *
 * 运行时之间没有特例：调用方只需要知道「我要哪个运行时的哪个选项」。
 * 没配置（或显式留空）时回落到声明里的默认值。
 */
export function runtimeOptionString(
  options: Record<string, unknown> | undefined,
  runtimeId: string,
  key: string,
): string {
  const entry = options?.[runtimeId]
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const value = (entry as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  const fallback = runtimeOptionDefault(runtimeId, key)
  return typeof fallback === 'string' ? fallback.trim() : ''
}

/**
 * 校验一个选项值；合法返回 null，否则返回可直接展示给用户的错误文案。
 *
 * select 的候选取值里允许出现空串：它表示「不覆盖」，写入配置时应当删掉这个键。
 */
export function validateRuntimeOption(field: RuntimeOptionField, value: unknown): string | null {
  switch (field.kind) {
    case 'select': {
      const text = String(value ?? '').trim()
      const allowed = field.options?.map(option => option.value) ?? []
      if (allowed.includes(text)) return null
      // 留空表示回到声明里的默认值；没声明默认值的选项仍然必须显式选择。
      if (text === '' && field.default !== undefined) return null
      return `取值必须是：${allowed.map(item => item || '(空)').join(' / ')}`
    }
    case 'switch': {
      if (typeof value === 'boolean') return null
      const text = String(value ?? '').trim()
      return text === 'true' || text === 'false' ? null : '取值必须是 true / false'
    }
    case 'number': {
      const n = Number(value)
      if (!Number.isInteger(n)) return '必须是整数'
      if (field.min !== undefined && n < field.min) return `不能小于 ${field.min}`
      if (field.max !== undefined && n > field.max) return `不能大于 ${field.max}`
      return null
    }
    default:
      return typeof value === 'string' ? null : '必须是字符串'
  }
}

