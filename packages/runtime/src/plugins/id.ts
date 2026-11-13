/**
 * 自定义运行时 id：从 npm 包名或本地路径推导。
 *
 * 约定包名形如 `@scope/runtime-<id>`；本地路径取目录名。
 * 结果会去掉 scope 与 `runtime-` 前缀，并归一化成插件 id 允许的字符。
 */
const RUNTIME_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

function isLocalPath(value: string): boolean {
  return value.startsWith('.')
    || value.startsWith('/')
    || value.startsWith('file:')
    || /^[a-zA-Z]:[\\/]/.test(value)
}

function baseName(value: string): string {
  return value.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? ''
}

export function runtimeIdFromPluginSource(source: string): string | undefined {
  const text = source.trim()
  if (!text) return undefined
  const name = isLocalPath(text)
    ? baseName(text)
    : text.startsWith('@')
      ? text.split('/')[1] ?? ''
      : text.split('/')[0] ?? ''
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!normalized) return undefined
  const id = normalized.startsWith('runtime-')
    ? normalized.slice('runtime-'.length)
    : normalized
  return RUNTIME_ID_PATTERN.test(id) ? id : undefined
}
