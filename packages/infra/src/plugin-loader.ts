import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { errorMessage, type Logger } from './logger.js'
import type { CommandRunner } from './process.js'

/** 插件在配置里的条目：包名、本地路径或目录。 */
export type PluginEntry = string | {
  /** npm 包名或本地路径。 */
  package?: string
  path?: string
  /** 配置别名：与 path 等价。 */
  plugin?: string
  /** 包内入口，例如 `dist/index.js`。 */
  entry?: string
  enabled?: boolean
}

export interface PluginMeta {
  id: string
  name: string
  label?: string
  hint?: string
  installHint?: string
  installUrl?: string
  installable?: boolean
  packageName?: string
  deprecated?: boolean
  repoSelector?: boolean
  default?: boolean
}

export type PluginKind = 'runtime' | 'channel'

/** node:module 的 resolve/import 抽象；测试可注入。 */
export interface PluginModuleLoader {
  resolve(specifier: string, parent?: string): string
  import(url: string): Promise<unknown>
}

/** 一次插件加载失败；面板与日志都要能看到「哪个包、为什么」。 */
export interface PluginFailure {
  kind: PluginKind
  id: string
  specifier: string
  message: string
}

export interface PluginLoadResult<T> {
  plugins: T[]
  /** 插件与其在配置里的 id 一一对应；插件声明的 meta.id 可能不同。 */
  entries: Array<{ id: string; plugin: T }>
  failures: PluginFailure[]
}

export interface PluginLoadOptions {
  kind: PluginKind
  home: string
  specifierOf(id: string): string | undefined
  /** 包内入口，例如 dist/index.js；目录型插件用它选具体文件。 */
  entryOf?(id: string): string | undefined
  ids: readonly string[]
  loader?: PluginModuleLoader
  logger: Logger
}

export function pluginSpecifier(entry: PluginEntry | undefined): string | undefined {
  if (!entry) return undefined
  if (typeof entry === 'string') return entry.trim() || undefined
  if (entry.enabled === false) return undefined
  return (entry.plugin ?? entry.path ?? entry.package)?.trim() || undefined
}

export function pluginEntryTarget(entry: PluginEntry | undefined): string | undefined {
  if (typeof entry === 'string') return entry.trim() || undefined
  return entry?.entry?.trim() || undefined
}

/**
 * 解析插件入口。
 *
 * 支持裸包名、绝对路径、相对 home 的路径、目录和 `entry`。目录优先读 package.json
 * 的 `exports` / `module` / `main`，再退回 index.js / index.mjs。
 */
export function resolvePluginSpecifier(
  specifier: string,
  home: string,
  loader: PluginModuleLoader,
  entry?: string,
): string {
  if (specifier.startsWith('file://')) return specifier
  if (isAbsolute(specifier) || specifier.startsWith('.')) {
    const base = isAbsolute(specifier) ? specifier : resolve(home, specifier)
    return pathToFileURL(resolvePluginPath(base, entry)).href
  }
  try {
    const resolved = loader.resolve(specifier, resolve(home, 'config.yaml'))
    return pathToFileURL(entry ? resolvePluginPath(resolved, entry) : resolved).href
  } catch {
    // 裸包名解析失败时保留原名，让 import 报出真实的「找不到包」；
    // 这里不能静默吞掉，否则面板只会看到一条没有包名的错误。
    return specifier
  }
}

export function resolvePluginPath(path: string, entry?: string): string {
  if (!existsSync(path)) return path
  if (!statSync(path).isDirectory()) return path
  if (entry) {
    const candidate = join(path, entry)
    if (existsSync(candidate)) return candidate
  }
  const manifest = join(path, 'package.json')
  if (existsSync(manifest)) {
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
        exports?: unknown
        module?: unknown
        main?: unknown
      }
      const exported = exportTarget(pkg.exports)
      for (const value of [exported, pkg.module, pkg.main]) {
        if (typeof value !== 'string' || !value.trim()) continue
        const candidate = join(path, value.trim())
        if (existsSync(candidate)) return candidate
      }
    } catch {
      // package.json 坏了就继续按目录默认入口找，最后的加载失败会带出真实原因。
    }
  }
  for (const name of ['index.js', 'index.mjs', 'index.cjs']) {
    const candidate = join(path, name)
    if (existsSync(candidate)) return candidate
  }
  return path
}

function exportTarget(exports: unknown): string | undefined {
  if (typeof exports === 'string') return exports
  if (!exports || typeof exports !== 'object' || Array.isArray(exports)) return undefined
  const root = (exports as Record<string, unknown>)['.']
  if (typeof root === 'string') return root
  if (root && typeof root === 'object' && !Array.isArray(root)) {
    const record = root as Record<string, unknown>
    for (const key of ['import', 'node', 'default']) {
      if (typeof record[key] === 'string') return record[key] as string
    }
  }
  return undefined
}

export function defaultPluginLoader(): PluginModuleLoader {
  return {
    resolve(specifier, parent) {
      const require = createRequire(parent ? pathToFileURL(parent) : import.meta.url)
      try {
        return require.resolve(specifier)
      } catch (error) {
        // ESM-only 包（exports 只有 import 条件）无法被 require.resolve 解析，
        // 手动按包名定位目录后再交给默认目录入口解析。
        const fallback = resolveEsmOnlyPackage(specifier, parent, error)
        if (fallback) return resolvePluginPath(fallback)
        throw error
      }
    },
    async import(url) {
      return import(url)
    },
  }
}

/**
 * 沿着 parent 所在目录向上找工作区 / 全局的 `node_modules/<specifier>`。
 *
 * RA_HOME 下的插件就是这种布局；只有 require.resolve 因 ESM-only exports
 * 失败时才走这里，找不到就返回 null，让调用方保留原始错误。
 */
function resolveEsmOnlyPackage(specifier: string, parent: string | undefined, error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' && code !== 'ERR_MODULE_NOT_FOUND') return null
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
  const start = parent ? dirname(parent) : dirname(fileURLToPath(import.meta.url))
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(candidate)) return candidate
    if (dirname(dir) === dir) return null
  }
}

export async function loadPluginModules<T extends { kind: PluginKind }>(opts: PluginLoadOptions): Promise<PluginLoadResult<T>> {
  const loader = opts.loader ?? defaultPluginLoader()
  const ids = [...new Set(opts.ids)]
  const plugins: T[] = []
  const entries: Array<{ id: string; plugin: T }> = []
  const failures: PluginFailure[] = []
  for (const id of ids) {
    const specifier = opts.specifierOf(id)
    if (!specifier) continue
    try {
      const target = resolvePluginSpecifier(specifier, opts.home, loader, opts.entryOf?.(id))
      const mod = await loader.import(target)
      const plugin = (mod as { default?: T }).default ?? mod as T
      if (!plugin || typeof plugin !== 'object' || plugin.kind !== opts.kind) {
        throw new Error(`插件 ${specifier} 没有导出 kind=${opts.kind} 的默认对象`)
      }
      plugins.push(plugin)
      entries.push({ id, plugin })
    } catch (error) {
      const message = errorMessage(error)
      failures.push({ kind: opts.kind, id, specifier, message })
      opts.logger.error('plugin:load-failed', {
        kind: opts.kind,
        id,
        package: specifier,
        detail: `${opts.kind} 插件 ${id} 加载失败：${message}`,
      })
    }
  }
  return { plugins, entries, failures }
}

export async function importPluginModule<T>(
  specifier: string,
  home: string,
  loader: PluginModuleLoader = defaultPluginLoader(),
  entry?: string,
): Promise<T> {
  const target = resolvePluginSpecifier(specifier, home, loader, entry)
  return await loader.import(target) as T
}

/** 插件包自己声明的身份；runtime / channel 通用。 */
export interface PluginDeclaration {
  /** 插件声明的 id；runtime 插件即 runtime id。 */
  id: string
  name?: string
  label?: string
  hint?: string
}

/**
 * 读取插件包声明的 id。
 *
 * 这是「装完才知道 id」的唯一可靠来源：包名没有格式约定，
 * 只有包真正能被导入、并声明 `meta.id` 时才知道它是什么运行时。
 */
export async function readPluginDeclaration(opts: {
  kind: PluginKind
  home: string
  specifier: string
  entry?: string
  loader?: PluginModuleLoader
}): Promise<PluginDeclaration> {
  const loader = opts.loader ?? defaultPluginLoader()
  const target = resolvePluginSpecifier(opts.specifier, opts.home, loader, opts.entry)
  const mod = await loader.import(target)
  const plugin = (mod as { default?: { kind?: unknown; meta?: { id?: unknown; name?: unknown; label?: unknown; hint?: unknown } } }).default
    ?? mod as { kind?: unknown; meta?: { id?: unknown; name?: unknown; label?: unknown; hint?: unknown } }
  if (!plugin || typeof plugin !== 'object' || plugin.kind !== opts.kind) {
    throw new Error(`插件 ${opts.specifier} 没有导出 kind=${opts.kind} 的默认对象`)
  }
  const id = plugin.meta?.id
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error(`插件 ${opts.specifier} 没有声明 meta.id，无法确定它的 ${opts.kind} id`)
  }
  const name = typeof plugin.meta?.name === 'string' ? plugin.meta.name : undefined
  const label = typeof plugin.meta?.label === 'string' ? plugin.meta.label : undefined
  const hint = typeof plugin.meta?.hint === 'string' ? plugin.meta.hint : undefined
  return {
    id: id.trim(),
    ...(name ? { name } : {}),
    ...(label ? { label } : {}),
    ...(hint ? { hint } : {}),
  }
}

/** 插件自行创建 runner 时用；宿主不假设具体 CLI。 */
export function throwRunner(kind: PluginKind, bin: string): CommandRunner {
  return {
    async run() {
      throw new Error(`${kind} 插件未注入 ${bin} 运行器`)
    },
  }
}
