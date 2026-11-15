import type { CommandRunner } from '@router-agent/infra/process.js'
import type { Logger } from '@router-agent/infra/logger.js'
import type { PluginEntry, PluginModuleLoader } from '@router-agent/infra/plugin-loader.js'
import type { EventSource } from '../port.js'

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
  create(ctx: EventPluginContext): EventSource | null | Promise<EventSource | null>
  /** 一个包可以注册多个实例；不实现时等价于 create()。 */
  createAll?(ctx: EventPluginContext): Array<EventSource | null> | Promise<Array<EventSource | null>>
}
