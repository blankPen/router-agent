/**
 * 节点侧的 HTTP 端点。
 *
 * 节点主动连回中心（直连模式）或经中继转发（见 link.ts），
 * 这里只负责鉴权与消息搬运；真正的业务处理由中心服务给回调。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { NodeToCenterMessage, NodeStatusView } from '#core/node.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import type { NodeRegistry } from './registry.js'

/** 中心处理一条节点消息的结果。 */
export interface NodeMessageResult {
  status: number
  body: Record<string, unknown>
}

export interface NodeApiOptions {
  registry: NodeRegistry
  /** 处理节点发来的消息（注册 / 上报）。 */
  onMessage: (nodeId: string, message: NodeToCenterMessage) => Promise<NodeMessageResult>
  /** 节点长轮询的等待时长；超时返回空列表。 */
  pollTimeoutMs?: number
  logger?: Logger
}

export interface NodeApi {
  /** 处理请求；返回 false 表示这个路径不归节点 API 管。 */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>
  /** 节点状态视图；面板与 CLI 用同一份。 */
  status(): NodeStatusView[]
}

const DEFAULT_POLL_TIMEOUT_MS = 25_000

export function createNodeApi(opts: NodeApiOptions): NodeApi {
  const logger = opts.logger ?? noopLogger
  const pollTimeoutMs = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS

  return {
    async handle(req, res): Promise<boolean> {
      const path = (req.url ?? '').split('?')[0] ?? ''
      if (path === '/api/nodes' && req.method === 'GET') {
        respond(res, 200, { nodes: opts.registry.status() })
        return true
      }
      if (path === '/api/nodes/message' && req.method === 'POST') {
        await handleMessage(req, res)
        return true
      }
      if (path === '/api/nodes/poll' && req.method === 'POST') {
        await handlePoll(req, res)
        return true
      }
      return false
    },

    status(): NodeStatusView[] {
      return opts.registry.status()
    },
  }

  async function handleMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req)
    const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : ''
    const token = typeof body.token === 'string' ? body.token : ''
    if (!nodeId || !opts.registry.authenticate(nodeId, token)) {
      logger.warn('node:auth-failed', { node: nodeId, path: '/api/nodes/message' })
      respond(res, 401, { error: 'node-unauthorized' })
      return
    }
    const message = body.message as NodeToCenterMessage | undefined
    if (!message || (message.kind !== 'register' && message.kind !== 'report')) {
      respond(res, 400, { error: 'invalid-message' })
      return
    }
    if (message.kind === 'register' && message.payload?.nodeId !== nodeId) {
      respond(res, 400, { error: 'node-id-mismatch' })
      return
    }
    try {
      const result = await opts.onMessage(nodeId, message)
      respond(res, result.status, result.body)
    } catch (error) {
      logger.error('node:message-failed', { node: nodeId, message: errorMessage(error) })
      respond(res, 500, { error: 'internal', message: errorMessage(error) })
    }
  }

  async function handlePoll(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req)
    const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : ''
    const token = typeof body.token === 'string' ? body.token : ''
    if (!nodeId || !opts.registry.authenticate(nodeId, token)) {
      logger.warn('node:auth-failed', { node: nodeId, path: '/api/nodes/poll' })
      respond(res, 401, { error: 'node-unauthorized' })
      return
    }
    // 顺带刷新心跳：节点在长轮询里就说明它还活着。
    opts.registry.heartbeat(nodeId)
    const messages = await opts.registry.waitFor(nodeId, pollTimeoutMs)
    respond(res, 200, { messages })
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    // 请求体不是合法 JSON：按空对象处理，交给校验层统一报错。
    return {}
  }
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}
