import { noopLogger, type Logger } from '@router-agent/infra/logger.js'
import { ChannelError } from './errors.js'
import type { ChannelAdapter, ChannelCapabilities } from './port.js'

/**
 * 通道注册表：按实例 ID 管理适配器。
 *
 * 一期只注册飞书；接第二通道时只需在这里多注册一个实现，内核代码不动。
 */
export class ChannelRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>()
  private readonly logger: Logger

  constructor(logger: Logger = noopLogger) {
    this.logger = logger
  }

  register(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.id)) {
      this.logger.warn('channel:duplicate-id', { channel: adapter.id, kind: adapter.kind })
    }
    this.adapters.set(adapter.id, adapter)
  }

  get(id: string): ChannelAdapter | undefined {
    return this.adapters.get(id)
  }

  /** 未注册属于永久失败：重试也不会变好，交给调用方决定是否进死信。 */
  require(id: string): ChannelAdapter {
    const adapter = this.adapters.get(id)
    if (!adapter) {
      throw new ChannelError(id, 'channel:not-registered', `通道未注册: ${id}`, false)
    }
    return adapter
  }

  capabilities(id: string): ChannelCapabilities {
    return this.require(id).capabilities
  }

  list(): ChannelAdapter[] {
    return [...this.adapters.values()]
  }

  /** 依次启动所有实现 `start` 的适配器，并把原始事件标上通道 ID。 */
  async startAll(sink: (channelId: string, raw: unknown) => void): Promise<void> {
    for (const adapter of this.adapters.values()) {
      if (!adapter.start) continue
      await adapter.start(raw => sink(adapter.id, raw))
    }
  }

  stopAll(): void {
    for (const adapter of this.adapters.values()) adapter.stop?.()
  }
}