import type { CommandRunner } from '@router-agent/infra/process.js'
import type { Logger } from '@router-agent/infra/logger.js'
import type { PluginEntry, PluginModuleLoader } from '@router-agent/infra/plugin-loader.js'
import type { EventCatalog, EventFetcher } from '../port.js'

export type EventPluginEntry = PluginEntry
export type EventPluginModuleLoader = PluginModuleLoader

/** 事件来源插件元数据；面板与配置校验共用。 */
export interface EventPluginMeta {
  id: string
  name: string
  hint: string
  packageName?: string
}

/** 插件声明的面板可配置项；落点统一为 events.sources.<id>.options.<key>。 */
export interface EventOptionField {
  key: string
  label: string
  kind: 'text' | 'textarea' | 'number' | 'boolean' | 'select'
  hint?: string
  options?: string[]
}

/** 事件来源 adapter 创建上下文；宿主只注入中立依赖。 */
export interface EventPluginContext {
  home: string
  config: Record<string, unknown>
  env: NodeJS.ProcessEnv
  logger: Logger
  /** 插件自行创建的运行器；宿主不假设来源实现。 */
  runner(bin: string): CommandRunner
}

/** 事件来源插件：一个包可以导出多个来源实例。 */
export interface EventPlugin {
  kind: 'event'
  meta?: EventPluginMeta
  options?: { fields: EventOptionField[] }
  /**
   * 插件提供的可订阅事件目录。
   *
   * 这是插件**唯一必须实现**的方法：它只声明「有什么事件可订阅」，
   * 不拉取、不判定、不派工。
   */
  catalog?(ctx: EventPluginContext): EventCatalog | null | Promise<EventCatalog | null>
  /**
   * 插件自带的拉取实现（可选）。
   *
   * 不实现就用宿主的通用 watcher（轮询 + 去重 + 窗口裁剪）。
   */
  fetch?(ctx: EventPluginContext): EventFetcher | null | Promise<EventFetcher | null>
}
