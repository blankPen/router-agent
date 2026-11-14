/**
 * 多设备能力的装配入口。
 *
 * Router 启动时只做一件事：把配置里的设备、连通方式与远端运行时拼起来，
 * 之后所有节点行为都从这里出去。
 */
import type { Store } from '../store/db.js'
import type { AppConfig } from '../config.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import type { WorkerStateFile } from '#runtime/report-poller.js'
import { createNodeApi, type NodeApi } from './api.js'
import { NodeCenter } from './center.js'
import { DirectCenterLink, RelayCenterLink, type CenterNodeLink } from './link.js'
import { NodeRegistry } from './registry.js'

export interface NodeSetupOptions {
  config: AppConfig
  store: Store
  /** 处理 worker 上报；与本地 /api/reports 同一条路。 */
  onReport: (state: WorkerStateFile) => Promise<void>
  logger?: Logger
  clock?: () => string
}

export interface NodeSetup {
  registry: NodeRegistry
  center: NodeCenter
  link: CenterNodeLink
  /** 节点 HTTP 端点；挂在 Router 的 API 服务上。 */
  api: NodeApi
  /** 中继模式下持续去中继取节点消息；直连模式是空操作。 */
  startRelayLoop(): void
  stop(): void
}

export function createNodeSetup(opts: NodeSetupOptions): NodeSetup | null {
  const { config } = opts
  if (!config.nodes.enabled) return null
  const logger = opts.logger ?? noopLogger
  const clock = opts.clock ?? (() => new Date().toISOString())
  const registry = new NodeRegistry({
    devices: config.nodes.devices.map(device => ({ id: device.id, name: device.name, token: device.token })),
    clock,
  })
  const link: CenterNodeLink = config.nodes.mode === 'relay'
    ? new RelayCenterLink({
      baseUrl: config.nodes.relay,
      routerId: config.nodes.routerId,
      relayToken: config.nodes.relayToken,
    })
    : new DirectCenterLink(registry)
  const center = new NodeCenter({ config, store: opts.store, registry, link, onReport: opts.onReport, logger, clock })
  const api = createNodeApi({
    registry,
    onMessage: (nodeId, message) => center.handleMessage(nodeId, message),
    logger,
  })
  let relayTimer: NodeJS.Timeout | null = null
  return {
    registry,
    center,
    link,
    api,
    startRelayLoop(): void {
      if (config.nodes.mode !== 'relay' || relayTimer) return
      // 自己排下一次：drainRelayed 会阻塞到有消息或超时，不能用固定间隔叠加。
      const tick = async (): Promise<void> => {
        try {
          await center.drainRelayed()
        } catch (error) {
          logger.warn('node:relay-poll-failed', { message: errorMessage(error) })
        }
        if (relayTimer) relayTimer = setTimeout(() => { void tick() }, 1_000)
      }
      relayTimer = setTimeout(() => { void tick() }, 1_000)
      relayTimer.unref()
    },
    stop(): void {
      if (relayTimer) clearTimeout(relayTimer)
      relayTimer = null
    },
  }
}
