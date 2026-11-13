import type { RuntimeConfigView } from '@router-agent/core/config.js'
import { errorMessage, noopLogger, type Logger } from '@router-agent/infra/logger.js'
import type { CommandRunner } from '@router-agent/infra/process.js'
import {
  loadPluginModules,
  pluginEntryTarget,
  pluginSpecifier,
  type PluginFailure,
} from '@router-agent/infra/plugin-loader.js'
import type { WorkerRuntime } from '../port.js'
import { RuntimeRegistry } from '../registry.js'
import { RuntimePluginError } from '../errors.js'
import type { RuntimeOptionSpec } from '../runtimes/options.js'
import type { PluginEntry, PluginModuleLoader } from '../plugins/types.js'
import type { RuntimePlugin, RuntimePluginContext, RuntimePluginMeta } from './types.js'

export const DEFAULT_RUNTIME_PLUGINS: Readonly<Record<string, string>> = {
  orca: '@router-agent/runtime-orca',
  'claude-code': '@router-agent/runtime-claude-code',
  'codex-app': '@router-agent/runtime-codex',
  acp: '@router-agent/runtime-acp',
  herdr: '@router-agent/runtime-herdr',
  t3code: '@router-agent/runtime-t3code',
}

export interface RuntimePluginConfigView extends RuntimeConfigView {
  runtime: RuntimeConfigView['runtime'] & {
    plugins?: Record<string, PluginEntry>
  }
}

export function pluginEntryOf(
  config: RuntimePluginConfigView,
  kind: 'runtime',
  id: string,
): string {
  const entry = config.runtime.plugins?.[id]
  return pluginSpecifier(entry) ?? DEFAULT_RUNTIME_PLUGINS[id] ?? id
}

export function describePluginLoadError(kind: 'runtime' | 'channel', id: string, error: unknown): string {
  return `${kind} 插件 ${id} 加载失败：${errorMessage(error)}`
}

export interface RuntimePluginDeps {
  home: string
  workersDir: string
  logger?: Logger
  env?: NodeJS.ProcessEnv
  runners?: {
    orca?: CommandRunner
    claude?: CommandRunner
    git?: CommandRunner
    herdr?: CommandRunner
    t3?: CommandRunner
  }
  claudeBin?: string
  claudeProjectsDir?: string
  loader?: PluginModuleLoader
  /** 测试注入：跳过内置包加载。 */
  builtins?: readonly string[]
}

export interface LoadedRuntimePlugins {
  registry: RuntimeRegistry
  metas: RuntimePluginMeta[]
  specs: RuntimeOptionSpec[]
  /** 已加载的运行时 id；未知 id 用于配置校验。 */
  ids: string[]
  /** 插件元数据 id → createAll() 实际注册的运行时 id；自定义多实例运行时用。 */
  loadedIds: Record<string, string[]>
  /** 加载失败的插件；启动不阻塞，但面板与 doctor 要能看到。 */
  failures: PluginFailure[]
}

/** 加载 runtime 插件并创建 adapter；单个插件失败只记录，不阻塞其它运行时。 */
export async function loadRuntimePlugins(
  config: RuntimePluginConfigView,
  deps: RuntimePluginDeps,
): Promise<LoadedRuntimePlugins> {
  const logger = deps.logger ?? noopLogger
  const loader = deps.loader
  const entries = config.runtime.plugins
  const builtins = deps.builtins ?? Object.keys(DEFAULT_RUNTIME_PLUGINS)
  const ids = [...new Set([...builtins, ...Object.keys(entries ?? {})])]
  const loaded = await loadPluginModules<RuntimePlugin>({
    kind: 'runtime',
    home: deps.home,
    ids,
    ...(loader ? { loader } : {}),
    logger,
    specifierOf: id => specifierOf(entries, id),
    entryOf: id => pluginEntryTarget(entries?.[id]),
  })
  const plugins = loaded.plugins
  const ctx: RuntimePluginContext = {
    home: deps.home,
    workersDir: deps.workersDir,
    config,
    env: deps.env ?? process.env,
    logger,
    runners: {
      orca: deps.runners?.orca ?? missingRunner('orca'),
      claude: deps.runners?.claude ?? missingRunner('claude'),
      git: deps.runners?.git ?? missingRunner('git'),
      herdr: deps.runners?.herdr ?? missingRunner('herdr'),
      t3: deps.runners?.t3 ?? missingRunner('t3'),
    },
    ...(deps.claudeBin ? { claudeBin: deps.claudeBin } : {}),
    ...(deps.claudeProjectsDir ? { claudeProjectsDir: deps.claudeProjectsDir } : {}),
  }

  const runtimes = new Map<string, WorkerRuntime>()
  const metas: RuntimePluginMeta[] = []
  const specs: RuntimeOptionSpec[] = []
  const loadedIds: Record<string, string[]> = {}
  for (const { id, plugin } of loaded.entries) {
    try {
      const instances = plugin.createAll ? await plugin.createAll(ctx) : [await plugin.create(ctx)]
      const ids: string[] = []
      for (const runtime of instances) {
        if (!runtime) continue
        runtimes.set(runtime.id, runtime)
        ids.push(runtime.id)
        logger.info('plugin:loaded', { kind: 'runtime', id: runtime.id })
      }
      if (plugin.meta) {
        if (plugin.meta.id !== id) {
          logger.warn('plugin:id-mismatch', {
            kind: 'runtime',
            id,
            declared: plugin.meta.id,
            detail: '配置里的插件 id 与插件声明的 meta.id 不一致，请改成一致以便面板回链',
          })
        }
        // 以配置 id 作为面板身份，声明 id 只用于说明；实例 id 另存。
        metas.push({ ...plugin.meta, id })
        loadedIds[id] = ids
      }
      if (plugin.options) specs.push(plugin.options)
      // createAll 没声明 meta 时也要把实例 id 记下来，否则无法按插件回推。
      if (!plugin.meta && ids.length > 0) loadedIds[id] = ids
    } catch (error) {
      const failureId = id || plugin.meta?.id || 'unknown'
      logger.error('plugin:create-failed', { kind: 'runtime', id: failureId, detail: errorMessage(error) })
      loaded.failures.push({ kind: 'runtime', id: failureId, specifier: pluginEntryOf(config, 'runtime', failureId), message: errorMessage(error) })
    }
  }

  const defaultId = config.runtime.default
  if (runtimes.size === 0) {
    throw new RuntimePluginError('plugin:not-found', `没有可用的 runtime 插件，无法启动 ${defaultId}`)
  }
  return {
    registry: new RuntimeRegistry(runtimes, defaultId),
    metas,
    specs,
    ids: [...runtimes.keys()],
    loadedIds,
    failures: loaded.failures,
  }
}

function specifierOf(entries: Record<string, PluginEntry> | undefined, id: string): string | undefined {
  const entry = entries?.[id]
  if (entry !== undefined) return pluginSpecifier(entry)
  return DEFAULT_RUNTIME_PLUGINS[id] ?? id
}

function missingRunner(bin: string): CommandRunner {
  return {
    async run() {
      throw new Error(`runtime 插件未注入 ${bin} 运行器`)
    },
  }
}
