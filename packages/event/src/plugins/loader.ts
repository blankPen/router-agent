import { errorMessage, noopLogger, type Logger } from '@router-agent/infra/logger.js'
import type { CommandRunner } from '@router-agent/infra/process.js'
import {
  loadPluginModules,
  pluginEntryTarget,
  pluginSpecifier,
  throwRunner,
  type PluginFailure,
} from '@router-agent/infra/plugin-loader.js'
import { EventSourceRegistry } from '../registry.js'
import type { EventSource } from '../port.js'
import type {
  EventPlugin,
  EventPluginEntry,
  EventPluginMeta,
  EventPluginModuleLoader,
} from './types.js'

/** 事件来源插件的装配视图；AppConfig 结构上兼容。 */
export interface EventPluginConfigView {
  home?: string
  events?: {
    /** 来源 id → 插件入口（npm 包名 / 本地路径 / 目录）。 */
    sources?: Record<string, EventPluginEntry>
  }
}

/** 取某个来源 id 的插件入口；没配就没有插件。 */
export function eventPluginEntryOf(config: EventPluginConfigView, id: string): string | undefined {
  return pluginSpecifier(config.events?.sources?.[id])
}

export interface EventPluginDeps {
  home?: string
  env?: NodeJS.ProcessEnv
  logger?: Logger
  runner?: (bin: string) => CommandRunner
  services?: Record<string, unknown>
  loader?: EventPluginModuleLoader
}

export interface LoadedEventPlugins {
  registry: EventSourceRegistry
  metas: EventPluginMeta[]
  sources: EventSource[]
  /** 配置 id → 实际注册的来源实例 id；一个插件包可以注册多个。 */
  loadedIds: Record<string, string[]>
  failures: PluginFailure[]
}

/**
 * 加载事件来源插件并注册来源。
 *
 * 只有配置里声明了插件入口的来源 id 才会尝试加载；内置来源（github / http / schedule）
 * 由宿主直接装配，不走这里。
 */
export async function loadEventPlugins(
  config: EventPluginConfigView,
  deps: EventPluginDeps = {},
): Promise<LoadedEventPlugins> {
  const logger = deps.logger ?? noopLogger
  const home = deps.home ?? config.home ?? ''
  const ids = Object.keys(config.events?.sources ?? {}).filter(id => eventPluginEntryOf(config, id))
  const registry = new EventSourceRegistry(logger)
  const metas: EventPluginMeta[] = []
  const sources: EventSource[] = []
  const loadedIds: Record<string, string[]> = {}
  const failures: PluginFailure[] = []

  const loaded = await loadPluginModules<EventPlugin>({
    kind: 'event',
    home,
    ids,
    ...(deps.loader ? { loader: deps.loader } : {}),
    logger,
    specifierOf: id => eventPluginEntryOf(config, id),
    entryOf: id => pluginEntryTarget(config.events?.sources?.[id]),
  })
  failures.push(...loaded.failures)
  for (const { id: configId, plugin } of loaded.entries) {
    try {
      const ctx = {
        home,
        config: config as Record<string, unknown>,
        env: deps.env ?? process.env,
        logger,
        runner: deps.runner ?? (bin => throwRunner('event', bin)),
        ...(deps.services ? { services: deps.services } : {}),
      }
      const created = plugin.createAll ? await plugin.createAll(ctx) : [await plugin.create(ctx)]
      const instanceIds: string[] = []
      for (const source of created) {
        if (!source) continue
        registry.register(source)
        sources.push(source)
        instanceIds.push(source.id)
        logger.info('plugin:loaded', { kind: 'event', id: source.id })
      }
      loadedIds[configId] = instanceIds
      if (plugin.meta) {
        if (plugin.meta.id !== configId) {
          logger.warn('plugin:id-mismatch', {
            kind: 'event',
            id: configId,
            declared: plugin.meta.id,
            detail: '配置里的插件 id 与插件声明的 meta.id 不一致，请改成一致以便面板回链',
          })
        }
        metas.push({ ...plugin.meta, id: configId })
      }
    } catch (error) {
      const failureId = configId || plugin.meta?.id || 'unknown'
      logger.error('plugin:create-failed', { kind: 'event', id: failureId, detail: errorMessage(error) })
      failures.push({
        kind: 'event',
        id: failureId,
        specifier: eventPluginEntryOf(config, failureId) ?? failureId,
        message: errorMessage(error),
      })
    }
  }
  return { registry, metas, sources, loadedIds, failures }
}
