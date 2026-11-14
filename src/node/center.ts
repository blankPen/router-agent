/**
 * 中心 Router 的节点调度中心。
 *
 * 它是「多设备」这件事在 Router 侧的唯一入口：节点消息进来在这里落账，
 * 工单出去之前在这里决定派给哪台设备。
 */
import type { Store } from '../store/db.js'
import type { NodeToCenterMessage } from '#core/node.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import { ReportRejectedError } from '#runtime/evidence-gate.js'
import type { WorkerStateFile } from '#runtime/report-poller.js'
import { dispatchProjectsOf, type AppConfig } from '../config.js'
import { buildReportState } from '../router/report-payload.js'
import type { NodeMessageResult } from './api.js'
import type { CenterNodeLink } from './link.js'
import type { NodeRegistry } from './registry.js'

export interface NodeCenterOptions {
  config: AppConfig
  store: Store
  registry: NodeRegistry
  link: CenterNodeLink
  /** 处理 worker 上报；与本地 /api/reports 走同一条路。 */
  onReport: (state: WorkerStateFile) => Promise<void>
  logger?: Logger
  clock?: () => string
}

/** 一个仓库定位对应的目标设备。 */
export interface NodeTarget {
  nodeId: string
  /** 节点侧项目标识；节点用它查本地绝对路径。 */
  project: string
}

export class NodeCenter {
  private readonly config: AppConfig
  private readonly store: Store
  private readonly registry: NodeRegistry
  private readonly link: CenterNodeLink
  private readonly onReport: (state: WorkerStateFile) => Promise<void>
  private readonly logger: Logger
  private readonly clock: () => string

  constructor(opts: NodeCenterOptions) {
    this.config = opts.config
    this.store = opts.store
    this.registry = opts.registry
    this.link = opts.link
    this.onReport = opts.onReport
    this.logger = opts.logger ?? noopLogger
    this.clock = opts.clock ?? (() => new Date().toISOString())
  }

  /** 节点当前是否在线。 */
  isOnline(nodeId: string): boolean {
    return this.registry.status().some(node => node.nodeId === nodeId && node.online)
  }

  /** 某个仓库定位应该派到哪台设备；不是节点项目就返回 null。 */
  targetOf(repo: string): NodeTarget | null {
    if (!repo) return null
    const project = dispatchProjectsOf(this.config).find(item => item.node && item.repo === repo)
    if (!project?.node) return null
    return { nodeId: project.node, project: project.nodeProject ?? project.repo }
  }

  /** 处理节点发来的一条消息。 */
  async handleMessage(nodeId: string, message: NodeToCenterMessage): Promise<NodeMessageResult> {
    if (message.kind === 'register') {
      const view = this.registry.touch(message.payload)
      this.logger.info('node:registered', {
        node: view.nodeId,
        name: view.name,
        runtimes: view.runtimes.join(','),
        projects: view.projects.join(','),
      })
      this.warnUnmatchedProjects(view.nodeId, view.projects)
      return { status: 200, body: { ok: true, heartbeatIntervalMs: 30_000 } }
    }
    if (message.kind === 'report') {
      return this.handleReport(nodeId, message.payload as unknown as Record<string, unknown>)
    }
    return { status: 400, body: { error: 'invalid-message' } }
  }

  /** 中继模式：中心主动去中继取节点消息。 */
  async drainRelayed(): Promise<void> {
    const items = await this.link.poll(25_000)
    for (const item of items) {
      try {
        await this.handleMessage(item.nodeId, item.message)
      } catch (error) {
        // 证据门禁的拒绝是预期结果：worker 收不到同步应答，靠日志与飞书通知兜住。
        if (error instanceof ReportRejectedError) {
          this.logger.warn('node:report-rejected', { node: item.nodeId, message: error.message })
          continue
        }
        this.logger.error('node:relayed-message-failed', { node: item.nodeId, message: errorMessage(error) })
      }
    }
  }

  private async handleReport(nodeId: string, body: Record<string, unknown>): Promise<NodeMessageResult> {
    const outcome = buildReportState(body, this.store, this.clock())
    if (!outcome.ok) return { status: outcome.status, body: outcome.body }
    try {
      await this.onReport(outcome.state)
    } catch (error) {
      // UI 证据门禁的可预期拒绝：回 422，让节点上的 worker 能按文案修正。
      if (error instanceof ReportRejectedError) {
        return { status: 422, body: { error: error.code, message: error.message, ...error.detail } }
      }
      throw error
    }
    const { ticketId, turn, state } = outcome.state
    this.logger.info('node:report-received', { node: nodeId, ticketId, turn, state })
    return { status: 201, body: { ok: true, ticketId, turn, state } }
  }

  /** 中心配置里排给这台设备的项目，节点没登记同名项目就要提醒。 */
  private warnUnmatchedProjects(nodeId: string, advertised: string[]): void {
    const device = this.config.nodes.devices.find(item => item.id === nodeId)
    if (!device) return
    for (const project of device.projects) {
      if (!advertised.includes(project.key)) {
        this.logger.warn('node:project-unmatched', {
          node: nodeId,
          project: project.key,
          detail: `设备没有登记同名项目，中心派单时它无法映射到本地路径`,
        })
      }
    }
  }
}
