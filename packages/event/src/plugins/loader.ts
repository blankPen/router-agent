import { errorMessage, noopLogger, type Logger } from '@router-agent/infra/logger.js'
import type { CommandRunner } from '@router-agent/infra/process.js'
import {
  loadPluginModules,
  pluginEntryTarget,
  pluginSpecifier,
  throwRunner,
  type PluginFailure,
} from '@router-agent/infra/plugin-loader.js'
import { EventCatalogRegistry, EventFetcherRegistry } from '../registry.js'
import type { EventCatalog, EventFetcher } from '../port.js'
import type {
  EventOptionField,
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
  /** 插件提供的事件目录（宿主按它渲染目录卡与注入会话提示词）。 */
  catalogs: EventCatalog[]
  /** 插件自带的拉取器；没有就是宿主通用 watcher。 */
  fetchers: EventFetcher[]
  metas: EventPluginMeta[]
  /** 配置 id → 实际注册的目录 id；一个插件包可以注册多个。 */
  loadedIds: Record<string, string[]>
  /** 配置 id → 插件声明的可配置项；面板按它渲染设置表单。 */
  optionsById: Record<string, EventOptionField[]>
  failures: PluginFailure[]
}

/**
 * 加载事件来源插件并注册来源。
 *
 * 只有配置里声明了插件入口的来源 id 才会尝试加载；内置来源（github / feishu）
 * 由宿主直接装配，不走这里。
 *
 * 插件必须提供 `catalog()`：旧插件（只实现 `EventSource`）不再加载，
 * 启动时打一条明确的弃用告警。
 */
export async function loadEventPlugins(
  config: EventPluginConfigView,
  deps: EventPluginDeps = {},
): Promise<LoadedEventPlugins> {
  const logger = deps.logger ?? noopLogger
  const home = deps.home ?? config.home ?? ''
  const ids = Object.keys(config.events?.sources ?? {}).filter(id => eventPluginEntryOf(config, id))
  const catalogRegistry = new EventCatalogRegistry(logger)
  const fetcherRegistry = new EventFetcherRegistry(logger)
  const metas: EventPluginMeta[] = []
  const catalogs: EventCatalog[] = []
  const fetchers: EventFetcher[] = []
  const loadedIds: Record<string, string[]> = {}
  const optionsById: Record<string, EventOptionField[]> = {}
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
      // 旧插件只实现 EventSource：明确废弃，不做适配层。
      // 适配层只能从 poll() 的第一条事件反推目录，不准；一个不准的目录比没有目录更危险。
      if (!plugin.catalog) {
        logger.warn('event:plugin-deprecated', {
          id: configId,
          detail: '插件实现的是已废弃的 EventSource 接口，v0.4.0 起不再加载，请升级到提供 catalog() 的版本',
        })
        failures.push({
          kind: 'event',
          id: configId,
          specifier: eventPluginEntryOf(config, configId) ?? configId,
          message: '插件未提供 catalog()，旧 EventSource 插件已废弃',
        })
        continue
      }
      const catalog = await plugin.catalog(ctx)
      const instanceIds: string[] = []
      if (catalog) {
        catalogRegistry.register(catalog)
        catalogs.push(catalog)
        instanceIds.push(catalog.id)
        logger.info('plugin:loaded', { kind: 'event', id: catalog.id })
      }
      const fetcher = plugin.fetch ? await plugin.fetch(ctx) : null
      if (fetcher) {
        fetcherRegistry.register(fetcher)
        fetchers.push(fetcher)
      }
      loadedIds[configId] = instanceIds
      optionsById[configId] = plugin.options?.fields ?? []
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
  return { catalogs, fetchers, metas, loadedIds, optionsById, failures }
}
