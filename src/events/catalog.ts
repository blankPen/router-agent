/**
 * 事件目录汇总：内置目录 + 插件目录。
 *
 * 目录是「有什么事件可订阅」的唯一事实来源：
 * 面板的目录卡、API 的目录端点、自然语言会话的提示词都从这里取。
 */
import type { EventCatalog, EventTypeDescriptor } from '#event/port.js'
import { loadEventPlugins } from '#event/plugins/loader.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import type { AppConfig } from '../config.js'
import { githubCatalog } from './catalogs/github.js'
import { feishuCatalog } from './catalogs/feishu.js'

/** 内置目录。 */
export const BUILTIN_CATALOGS: readonly EventCatalog[] = [githubCatalog, feishuCatalog]

/** 一个来源在目录视图里的完整信息。 */
export interface CatalogView {
  id: string
  kind: string
  name: string
  /** 可订阅的事件类型。 */
  types: EventTypeDescriptor[]
  /** 连接参数声明。 */
  params: ReturnType<EventCatalog['params']>
  /** 内置目录还是插件目录。 */
  builtin: boolean
  /** 插件包名或本地路径。 */
  package?: string
}

/**
 * 事件目录注册表（宿主侧）。
 *
 * 内置目录常驻；插件目录在配置变更时重新加载。
 */
export class CatalogService {
  private logger: Logger
  private catalogs = new Map<string, EventCatalog>()
  private packages = new Map<string, string>()

  constructor(logger: Logger = noopLogger) {
    this.logger = logger
    for (const catalog of BUILTIN_CATALOGS) {
      this.catalogs.set(catalog.id, catalog)
    }
  }

  /**
   * 重新加载插件目录。
   *
   * 插件加载失败不影响内置目录：目录只是「有什么可订阅」的说明，
   * 少一个来源不该让整个面板瘫掉。
   */
  async reload(config: AppConfig): Promise<void> {
    for (const id of [...this.packages.keys()]) {
      this.catalogs.delete(id)
      this.packages.delete(id)
    }
    const plugins = await loadEventPlugins(
      { home: config.home, events: { sources: pluginEntriesOf(config) } },
      {
        home: config.home,
        logger: this.logger,
        runner: bin => ({ run: async () => ({ code: 127, stdout: '', stderr: `事件插件不支持命令 ${bin}` }) }),
      },
    )
    for (const failure of plugins.failures) {
      this.logger.error('event:plugin-failed', { sourceId: failure.id, message: failure.message })
    }
    for (const catalog of plugins.catalogs) {
      this.catalogs.set(catalog.id, catalog)
    }
    for (const [configId, ids] of Object.entries(plugins.loadedIds)) {
      const source = config.events.sources[configId]
      if (source?.plugin && ids.length > 0) {
        this.packages.set(configId, source.plugin)
      }
    }
  }

  /** 按 id 取目录。 */
  get(id: string): EventCatalog | undefined {
    return this.catalogs.get(id)
  }

  /** 全部目录。 */
  list(): EventCatalog[] {
    return [...this.catalogs.values()]
  }

  /** 面板与 API 用的目录视图。 */
  views(): CatalogView[] {
    return this.list().map(catalog => ({
      id: catalog.id,
      kind: catalog.kind,
      name: catalog.name,
      types: catalog.types(),
      params: catalog.params(),
      builtin: !this.packages.has(catalog.id),
      ...(this.packages.get(catalog.id) ? { package: this.packages.get(catalog.id)! } : {}),
    }))
  }

  /** 按来源与类型 id 校验；类型不在目录里返回 false。 */
  hasType(source: string, type: string): boolean {
    const catalog = this.get(source)
    if (!catalog) return false
    return catalog.types().some(item => item.id === type)
  }

  /**
   * 给会话提示词用的目录文本。
   *
   * 可用性标注要一起带上：否则模型会给用户建一个「订阅了飞书进群事件」的任务，
   * 而那个事件类型其实还没在开发者后台开通 —— 用户等一天都不会看到事件。
   */
  catalogText(): string {
    const lines: string[] = []
    for (const catalog of this.list()) {
      lines.push(`[来源] ${catalog.id}（${catalog.name}）`)
      for (const type of catalog.types()) {
        const note = type.availability?.note
        lines.push(`  - ${type.id} · ${type.label}${note ? ` · ${note}` : ''}`)
      }
    }
    return lines.join('\n')
  }
}

/** 配置里声明了插件入口的来源条目。 */
function pluginEntriesOf(config: AppConfig): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, source] of Object.entries(config.events.sources)) {
    if (source.plugin) out[id] = source.plugin
  }
  return out
}

/** 目录加载失败不应该让服务起不来。 */
export function logCatalogLoadError(logger: Logger, error: unknown): void {
  logger.warn('event:catalog-load-failed', { message: errorMessage(error) })
}
