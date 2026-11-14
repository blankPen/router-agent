/**
 * 节点与中心之间的链路。
 *
 * 两侧各只有一个接口，消息形态完全一样；直连与中继只是换了承载消息的地址。
 */
import type { CenterToNodeMessage, NodeToCenterMessage } from '#core/node.js'
import { errorMessage } from '#infra/logger.js'
import type { NodeRegistry } from './registry.js'

/** 中心侧：把消息投给某台设备。 */
export interface CenterNodeLink {
  deliver(nodeId: string, message: CenterToNodeMessage): Promise<void>
  /** 中继模式：中心主动长轮询取节点消息；直连模式返回空数组（节点直接 POST 上来）。 */
  poll(timeoutMs: number): Promise<Array<{ nodeId: string; message: NodeToCenterMessage }>>
}

/** 节点侧：把消息发给中心、从中心取消息。 */
export interface NodeAgentLink {
  /**
   * 发一条消息给中心。
   *
   * 返回中心的应答：worker 的上报可能被证据门禁拒绝（422），
   * 节点必须把这个状态码原样回给本机 worker，它才知道要补证。
   */
  send(message: NodeToCenterMessage): Promise<{ status: number; body: unknown }>
  receive(timeoutMs: number): Promise<CenterToNodeMessage[]>
}

export interface HttpLinkOptions {
  baseUrl: string
  nodeId: string
  token: string
  fetchImpl?: typeof fetch
}

/** 直连：节点直接连中心 Router 的节点端点（同内网 / Tailscale）。 */
export class DirectNodeAgentLink implements NodeAgentLink {
  private readonly baseUrl: string
  private readonly nodeId: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: HttpLinkOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.nodeId = opts.nodeId
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async send(message: NodeToCenterMessage): Promise<{ status: number; body: unknown }> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/nodes/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: this.nodeId, token: this.token, message }),
    })
    // 中心的判定（404 工单不存在、422 证据不足）要原样带回 worker，这里不抛。
    return { status: res.status, body: await readBody(res) }
  }

  async receive(timeoutMs: number): Promise<CenterToNodeMessage[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/nodes/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: this.nodeId, token: this.token }),
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    })
    if (!res.ok) throw new Error(`中心拒绝节点轮询(${res.status})：${(await res.text()).slice(0, 200)}`)
    const body = (await res.json()) as { messages?: CenterToNodeMessage[] }
    return Array.isArray(body.messages) ? body.messages : []
  }
}

/** 直连：中心把消息写进节点信箱，节点长轮询时取走。 */
export class DirectCenterLink implements CenterNodeLink {
  constructor(private readonly registry: NodeRegistry) {}

  async deliver(nodeId: string, message: CenterToNodeMessage): Promise<void> {
    this.registry.enqueue(nodeId, message)
  }

  async poll(): Promise<Array<{ nodeId: string; message: NodeToCenterMessage }>> {
    // 直连模式下节点主动把消息 POST 上来，中心不用主动去取。
    return []
  }
}

export interface RelayLinkOptions {
  /** 中继服务地址。 */
  baseUrl: string
  /** 中继模式下标识中心 Router。 */
  routerId: string
  nodeId: string
  /** 中继服务的接入密钥。 */
  relayToken: string
  fetchImpl?: typeof fetch
}

/** 中继：节点与中心都连自建公网中继，由中继转发消息。 */
export class RelayNodeAgentLink implements NodeAgentLink {
  private readonly base: string
  private readonly routerId: string
  private readonly nodeId: string
  private readonly relayToken: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: RelayLinkOptions) {
    this.base = `${opts.baseUrl.replace(/\/+$/, '')}/relay/${encodeURIComponent(opts.routerId)}/node/${encodeURIComponent(opts.nodeId)}`
    this.routerId = opts.routerId
    this.nodeId = opts.nodeId
    this.relayToken = opts.relayToken
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async send(message: NodeToCenterMessage): Promise<{ status: number; body: unknown }> {
    const res = await this.fetchImpl(`${this.base}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Token': this.relayToken },
      body: JSON.stringify({ message }),
    })
    return { status: res.status, body: await readBody(res) }
  }

  async receive(timeoutMs: number): Promise<CenterToNodeMessage[]> {
    const res = await this.fetchImpl(`${this.base}/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Token': this.relayToken },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    })
    if (!res.ok) throw new Error(`中继拒绝节点轮询(${res.status})：${(await res.text()).slice(0, 200)}`)
    const body = (await res.json()) as { messages?: CenterToNodeMessage[] }
    return Array.isArray(body.messages) ? body.messages : []
  }
}

export interface RelayCenterLinkOptions {
  baseUrl: string
  routerId: string
  relayToken: string
  fetchImpl?: typeof fetch
}

/** 中继：中心把消息交给中继，中继转给目标节点。 */
export class RelayCenterLink implements CenterNodeLink {
  private readonly base: string
  private readonly routerId: string
  private readonly relayToken: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: RelayCenterLinkOptions) {
    this.base = `${opts.baseUrl.replace(/\/+$/, '')}/relay/${encodeURIComponent(opts.routerId)}/router`
    this.routerId = opts.routerId
    this.relayToken = opts.relayToken
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async deliver(nodeId: string, message: CenterToNodeMessage): Promise<void> {
    const res = await this.fetchImpl(`${this.base}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Token': this.relayToken },
      body: JSON.stringify({ nodeId, message }),
    })
    if (!res.ok) throw new Error(`中继拒绝中心消息(${res.status})：${(await res.text()).slice(0, 200)}`)
  }

  async poll(timeoutMs: number): Promise<Array<{ nodeId: string; message: NodeToCenterMessage }>> {
    const res = await this.fetchImpl(`${this.base}/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Token': this.relayToken },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    })
    if (!res.ok) throw new Error(`中继拒绝中心轮询(${res.status})：${(await res.text()).slice(0, 200)}`)
    const body = (await res.json()) as { items?: Array<{ nodeId: string; message: NodeToCenterMessage }> }
    return Array.isArray(body.items) ? body.items : []
  }
}

/** 把失败变成一句话；日志与 worker 提示都用得上。 */
export function linkError(error: unknown): string {
  return errorMessage(error)
}

/** 读应答体；不是 JSON 就按文本返回。 */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
