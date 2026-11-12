import { errorMessage, noopLogger, type Logger } from '@router-agent/infra/logger.js'
import type { CommandRunner } from '@router-agent/infra/process.js'
import {
  loadPluginModules,
  pluginEntryTarget,
  pluginSpecifier,
  throwRunner,
  type PluginFailure,
} from '@router-agent/infra/plugin-loader.js'
import { ChannelRegistry } from '../registry.js'
import type { ChannelAdapter } from '../port.js'
import type {
  ChannelPlugin,
  ChannelPluginEntry,
  ChannelPluginMeta,
  ChannelPluginModuleLoader,
} from './types.js'

export const DEFAULT_CHANNEL_PLUGINS: Readonly<Record<string, string>> = {
  feishu: '@router-agent/channel-feishu',
}

export interface ChannelPluginConfigView {
  home?: string
  channels?: Record<string, ChannelPluginEntry>
}

export function channelPluginEntryOf(config: ChannelPluginConfigView, id: string): string {
  return pluginSpecifier(config.channels?.[id]) ?? DEFAULT_CHANNEL_PLUGINS[id] ?? id
}

export function describeChannelPluginLoadError(id: string, error: unknown): string {
  return `channel 插件 ${id} 加载失败：${errorMessage(error)}`
}

export interface ChannelPluginDeps {
  home?: string
  env?: NodeJS.ProcessEnv
  logger?: Logger
  runner?: (bin: string) => CommandRunner
  services?: Record<string, unknown>
  loader?: ChannelPluginModuleLoader
  /** 测试注入：跳过内置包加载。 */
  builtins?: readonly string[]
}

export interface LoadedChannelPlugins {
  registry: ChannelRegistry
  metas: ChannelPluginMeta[]
  adapters: ChannelAdapter[]
  /** 配置 id → 实际注册的通道实例 id；一个插件包可以注册多个。 */
  loadedIds: Record<string, string[]>
  failures: PluginFailure[]
}

/** 加载 channel 插件并注册 adapter；单个插件失败只记录，不阻塞其它通道。 */
export async function loadChannelPlugins(
  config: ChannelPluginConfigView,
  deps: ChannelPluginDeps = {},
): Promise<LoadedChannelPlugins> {
  const logger = deps.logger ?? noopLogger
  const home = deps.home ?? config.home ?? ''
  const ids = [...new Set([...(deps.builtins ?? Object.keys(DEFAULT_CHANNEL_PLUGINS)), ...Object.keys(config.channels ?? {})])]
  const registry = new ChannelRegistry(logger)
  const metas: ChannelPluginMeta[] = []
  const adapters: ChannelAdapter[] = []
  const loadedIds: Record<string, string[]> = {}
  const failures: PluginFailure[] = []

  const loaded = await loadPluginModules<ChannelPlugin>({
    kind: 'channel',
    home,
    ids,
    ...(deps.loader ? { loader: deps.loader } : {}),
    logger,
    specifierOf: id => {
      const entry = config.channels?.[id]
      if (entry !== undefined) return pluginSpecifier(entry)
      return DEFAULT_CHANNEL_PLUGINS[id] ?? id
    },
    entryOf: id => pluginEntryTarget(config.channels?.[id]),
  })
  failures.push(...loaded.failures)
  for (const { id: configId, plugin } of loaded.entries) {
    try {
      const ctx = {
        home,
        config: config as Record<string, unknown>,
        env: deps.env ?? process.env,
        logger,
        runner: deps.runner ?? (bin => throwRunner('channel', bin)),
        ...(deps.services ? { services: deps.services } : {}),
      }
      const created = plugin.createAll ? await plugin.createAll(ctx) : [await plugin.create(ctx)]
      const ids: string[] = []
      for (const adapter of created) {
        if (!adapter) continue
        registry.register(adapter)
        adapters.push(adapter)
        ids.push(adapter.id)
        logger.info('plugin:loaded', { kind: 'channel', id: adapter.id })
      }
      loadedIds[configId] = ids
      if (plugin.meta) {
        if (plugin.meta.id !== configId) {
          logger.warn('plugin:id-mismatch', {
            kind: 'channel',
            id: configId,
            declared: plugin.meta.id,
            detail: '配置里的插件 id 与插件声明的 meta.id 不一致，请改成一致以便面板回链',
          })
        }
        metas.push({ ...plugin.meta, id: configId })
      }
    } catch (error) {
      const failureId = configId || plugin.meta?.id || 'unknown'
      logger.error('plugin:create-failed', { kind: 'channel', id: failureId, detail: errorMessage(error) })
      failures.push({ kind: 'channel', id: failureId, specifier: channelPluginEntryOf(config, failureId), message: errorMessage(error) })
    }
  }
  return { registry, metas, adapters, loadedIds, failures }
}

