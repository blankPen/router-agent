import type { CommandRunner } from '@router-agent/infra/process.js'
import type { Logger } from '@router-agent/infra/logger.js'
import type { PluginEntry, PluginModuleLoader } from '@router-agent/infra/plugin-loader.js'
import type { ChannelAdapter } from '../port.js'

export type ChannelPluginEntry = PluginEntry
export type ChannelPluginModuleLoader = PluginModuleLoader

export interface ChannelPluginMeta {
  id: string
  name: string
  hint: string
  default?: boolean
  packageName?: string
}

export interface ChannelPluginContext {
  home: string
  config: Record<string, unknown>
  env: NodeJS.ProcessEnv
  logger: Logger
  /** 插件自行创建的运行器；宿主不假设通道实现。 */
  runner(bin: string): CommandRunner
  /** 宿主已有的可选服务（如目录、附件转写）；插件按需取用。 */
  services?: Record<string, unknown>
}

export interface ChannelPlugin {
  kind: 'channel'
  meta?: ChannelPluginMeta
  create(ctx: ChannelPluginContext): ChannelAdapter | null | Promise<ChannelAdapter | null>
  /** 一个通道包可以注册多个实例；不实现时等价于 create()。 */
  createAll?(ctx: ChannelPluginContext): Array<ChannelAdapter | null> | Promise<Array<ChannelAdapter | null>>
}

