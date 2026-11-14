import type { EventSource } from './port.js'
import { errorMessage, noopLogger, type Logger } from '@router-agent/infra/logger.js'

/**
 * 事件来源注册表。
 *
 * 来源按配置 id 注册；同名来源后来者不覆盖先注册的，
 * 避免插件重载时把正在跑的来源换掉。
 */
export class EventSourceRegistry {
  private logger: Logger
  private sources = new Map<string, EventSource>()

  constructor(logger: Logger = noopLogger) {
    this.logger = logger
  }

  register(source: EventSource): void {
    if (this.sources.has(source.id)) {
      this.logger.warn('event:source-duplicate', { sourceId: source.id })
      return
    }
    this.sources.set(source.id, source)
    this.logger.info('event:source-registered', { sourceId: source.id, kind: source.kind })
  }

  get(id: string): EventSource | undefined {
    return this.sources.get(id)
  }

  list(): EventSource[] {
    return [...this.sources.values()]
  }

  ids(): string[] {
    return [...this.sources.keys()]
  }
}

/** 停止所有来源；单个来源停止失败不影响其它来源。 */
export async function stopEventSources(sources: EventSource[], logger: Logger = noopLogger): Promise<void> {
  for (const source of sources) {
    try {
      source.stop?.()
    } catch (error) {
      logger.warn('event:source-stop-failed', { sourceId: source.id, message: errorMessage(error) })
    }
  }
}
