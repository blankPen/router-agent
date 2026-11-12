/**
 * 运行时共用的可执行文件解析与版本提取（纯函数，不 spawn）。
 * ACP 插件与其它运行时插件都从这里取同一份语义。
 */
import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/** 在 PATH 里解析命令；支持 Windows 的 PATHEXT。返回绝对路径。 */
export function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = command.trim()
  if (!value) return undefined
  if (isAbsolute(value) || value.includes('/') || value.includes('\\')) {
    return existsSync(value) ? value : undefined
  }
  const pathValue = env.PATH ?? env.Path ?? ''
  const extensions = process.platform === 'win32'
    ? ['', '.cmd', '.exe', '.bat']
    : ['']
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const ext of extensions) {
      const candidate = join(dir, `${value}${ext}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** 从 `--version` 输出里提取 x.y.z；找不到返回 undefined。 */
export function parseVersion(text: string): string | undefined {
  const match = /(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/.exec(text)
  return match?.[1]
}
