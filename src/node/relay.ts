/**
 * 自建公网中继服务。
 *
 * 中心 Router 与各设备都只连中继，由中继按 routerId / nodeId 分流转发；
 * 谁都不需要在对方机器上开入站端口。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'

export interface RelayServerOptions {
  port: number
  host?: string
  /** 接入密钥；节点与中心都要带对，空值不允许启动。 */
  token: string
  /** 队列中消息的保留时长；超时丢弃。 */
  ttlMs?: number
  /** 节点长轮询的等待时长。 */
  pollTimeoutMs?: number
  logger?: Logger
  /** 当前时间（毫秒时间戳）；测试注入固定时钟。 */
  clock?: () => number
}

export interface RelayServer {
  server: Server
  close(): Promise<void>
}

interface Envelope {
  nodeId: string
  message: unknown
  at: number
}

interface RouterLane {
  toRouter: Envelope[]
  toNode: Map<string, Envelope[]>
}

const DEFAULT_TTL_MS = 30 * 60_000
const DEFAULT_POLL_TIMEOUT_MS = 25_000

export function createRelayServer(opts: RelayServerOptions): RelayServer {
  const logger = opts.logger ?? noopLogger
  const clock = opts.clock ?? (() => Date.now())
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const pollTimeoutMs = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const lanes = new Map<string, RouterLane>()
  const waiters = new Map<string, Array<{ side: 'node' | 'router'; nodeId: string; resolve: (items: Envelope[]) => void }>>()

  const lane = (routerId: string): RouterLane => {
    let current = lanes.get(routerId)
    if (!current) {
      current = { toRouter: [], toNode: new Map() }
      lanes.set(routerId, current)
    }
    return current
  }

  const push = (routerId: string, nodeId: string, message: unknown, toNode: boolean): void => {
    const current = lane(routerId)
    const envelope: Envelope = { nodeId, message, at: clock() }
    if (toNode) {
      const queue = current.toNode.get(nodeId) ?? []
      queue.push(envelope)
      current.toNode.set(nodeId, queue)
    } else {
      current.toRouter.push(envelope)
    }
    // 有人在等就立刻唤醒，不用等满一个轮询周期。
    // 节点侧只唤醒同一台设备；中心侧唤醒任意一条来自节点的消息。
    const pending = waiters.get(routerId) ?? []
    const index = pending.findIndex(item => (toNode
      ? item.side === 'node' && item.nodeId === nodeId
      : item.side === 'router'))
    const waiter = index >= 0 ? pending[index] : undefined
    if (!waiter) return
    pending.splice(index, 1)
    waiters.set(routerId, pending)
    // 消息在这里出队，否则下一次轮询会再取一遍，同一条消息被处理两次。
    waiter.resolve(take(routerId, waiter.nodeId, waiter.side === 'node'))
  }

  const take = (routerId: string, nodeId: string, toNode: boolean): Envelope[] => {
    const current = lane(routerId)
    const source = toNode ? current.toNode.get(nodeId) ?? [] : current.toRouter
    const fresh = source.filter(item => clock() - item.at < ttlMs)
    if (toNode) current.toNode.set(nodeId, [])
    else current.toRouter = []
    return fresh
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(error => {
      logger.error('relay:request-failed', { message: errorMessage(error) })
      respond(res, 500, { error: 'internal', message: errorMessage(error) })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.headers['x-relay-token'] !== opts.token) {
      logger.warn('relay:auth-failed', { path })
      respond(res, 401, { error: 'relay-unauthorized' })
      return
    }
    const route = parseRoute(path)
    if (!route) {
      respond(res, 404, { error: 'not-found' })
      return
    }
    if (route.side === 'node' && route.action === 'message') {
      const body = await readJson(req)
      push(route.routerId, route.nodeId, body.message, false)
      respond(res, 202, { ok: true })
      return
    }
    if (route.side === 'node' && route.action === 'poll') {
      await poll(res, route.routerId, route.nodeId, true)
      return
    }
    if (route.side === 'router' && route.action === 'message') {
      const body = await readJson(req)
      const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : ''
      if (!nodeId) {
        respond(res, 400, { error: 'node-id-required' })
        return
      }
      push(route.routerId, nodeId, body.message, true)
      respond(res, 202, { ok: true })
      return
    }
    if (route.side === 'router' && route.action === 'poll') {
      await poll(res, route.routerId, '', false)
      return
    }

    respond(res, 404, { error: 'not-found' })
  }

  async function poll(res: ServerResponse, routerId: string, nodeId: string, toNode: boolean): Promise<void> {
    const ready = take(routerId, nodeId, toNode)
    if (ready.length > 0) {
      respond(res, 200, toNode
        ? { messages: ready.map(item => item.message) }
        : { items: ready.map(item => ({ nodeId: item.nodeId, message: item.message })) })
      return
    }
    const items = await new Promise<Envelope[]>(resolve => {
      const pending = waiters.get(routerId) ?? []
      const waiter = { side: toNode ? ('node' as const) : ('router' as const), nodeId, resolve }
      pending.push(waiter)
      waiters.set(routerId, pending)
      setTimeout(() => {
        const current = waiters.get(routerId) ?? []
        waiters.set(routerId, current.filter(item => item !== waiter))
        resolve([])
      }, pollTimeoutMs)
    })
    // 中心侧要知道消息来自哪台设备，所以带 nodeId；节点侧只关心内容。
    respond(res, 200, toNode
      ? { messages: items.map(item => item.message) }
      : { items: items.map(item => ({ nodeId: item.nodeId, message: item.message })) })
  }

  return {
    server,
    close(): Promise<void> {
      return new Promise(resolve => {
        server.close(() => resolve())
      })
    },
  }
}

interface RelayRoute {
  routerId: string
  nodeId: string
  side: 'node' | 'router'
  action: 'message' | 'poll'
}

/** 解析 /relay/<routerId>/{node|router}/<nodeId?>/{message|poll}。 */
function parseRoute(path: string): RelayRoute | null {
  const parts = path.split('/').filter(Boolean)
  if (parts.length < 4 || parts[0] !== 'relay') return null
  const routerId = parts[1] ?? ''
  const side = parts[2]
  if (side === 'node') {
    // /relay/<routerId>/node/<nodeId>/<action>
    if (parts.length !== 5) return null
    const action = parts[4]
    if (action !== 'message' && action !== 'poll') return null
    return { routerId: decodeURIComponent(routerId), nodeId: decodeURIComponent(parts[3]!), side, action }
  }
  if (side === 'router') {
    // /relay/<routerId>/router/<action>
    if (parts.length !== 4) return null
    const action = parts[3]
    if (action !== 'message' && action !== 'poll') return null
    return { routerId: decodeURIComponent(routerId), nodeId: '', side, action }
  }
  return null
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
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
