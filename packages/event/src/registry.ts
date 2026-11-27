import type { EventCatalog, EventFetcher } from './port.js'
import { errorMessage, noopLogger, type Logger } from '@router-agent/infra/logger.js'

/**
 * 事件目录注册表。
 *
 * 目录按来源 id 注册；同名来源后来者不覆盖先注册的，
 * 避免插件重载时把正在用的目录换掉。
 */
export class EventCatalogRegistry {
  private logger: Logger
  private catalogs = new Map<string, EventCatalog>()

  constructor(logger: Logger = noopLogger) {
    this.logger = logger
  }

  register(catalog: EventCatalog): void {
    if (this.catalogs.has(catalog.id)) {
      this.logger.warn('event:catalog-duplicate', { sourceId: catalog.id })
      return
    }
    this.catalogs.set(catalog.id, catalog)
    this.logger.info('event:catalog-registered', { sourceId: catalog.id, kind: catalog.kind })
  }

  get(id: string): EventCatalog | undefined {
    return this.catalogs.get(id)
  }

  list(): EventCatalog[] {
    return [...this.catalogs.values()]
  }

  ids(): string[] {
    return [...this.catalogs.keys()]
  }
}

/**
 * 事件拉取器注册表。
 *
 * 拉取器按来源 id 注册；同一个来源只有一个拉取器实例。
 */
export class EventFetcherRegistry {
  private logger: Logger
  private fetchers = new Map<string, EventFetcher>()

  constructor(logger: Logger = noopLogger) {
    this.logger = logger
  }

  register(fetcher: EventFetcher): void {
    if (this.fetchers.has(fetcher.id)) {
      this.logger.warn('event:fetcher-duplicate', { sourceId: fetcher.id })
      return
    }
    this.fetchers.set(fetcher.id, fetcher)
    this.logger.info('event:fetcher-registered', { sourceId: fetcher.id, kind: fetcher.kind })
  }

  get(id: string): EventFetcher | undefined {
    return this.fetchers.get(id)
  }

  list(): EventFetcher[] {
    return [...this.fetchers.values()]
  }
}

/** 停止所有拉取器；单个停止失败不影响其它。 */
export async function stopEventFetchers(fetchers: EventFetcher[], logger: Logger = noopLogger): Promise<void> {
  for (const fetcher of fetchers) {
    try {
      fetcher.stop?.()
    } catch (error) {
      logger.warn('event:fetcher-stop-failed', { sourceId: fetcher.id, message: errorMessage(error) })
    }
  }
}
