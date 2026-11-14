/**
 * 中心 Router 侧的节点注册表。
 *
 * 记着「有哪些设备、密钥对不对、现在在线吗、中心给每台设备排了什么活」，
 * 是多设备调度唯一的状态来源；连通方式（直连 / 中继）不在这层。
 */
import type { CenterToNodeMessage, NodeRegistration, NodeStatusView } from '#core/node.js'

/** 配置里登记的一台设备。 */
export interface NodeDeviceConfig {
  id: string
  name: string
  /** 节点密钥；节点侧用同一个值上报。 */
  token: string
}

export interface NodeRegistryOptions {
  devices: NodeDeviceConfig[]
  /** 当前时间；测试注入固定时钟。 */
  clock?: () => string
  /** 超过这个时长没心跳就算离线；默认 90 秒。 */
  offlineAfterMs?: number
}

interface NodeState {
  device: NodeDeviceConfig
  lastSeenAt: string
  registration: NodeRegistration | null
  /** 中心 → 节点的消息队列。 */
  outbox: CenterToNodeMessage[]
  /** 节点正在执行的工单。 */
  tickets: Set<string>
}

const DEFAULT_OFFLINE_AFTER_MS = 90_000

export class NodeRegistry {
  private readonly devices = new Map<string, NodeDeviceConfig>()
  private readonly states = new Map<string, NodeState>()
  private readonly waiters = new Map<string, Array<(messages: CenterToNodeMessage[]) => void>>()
  private readonly clock: () => string
  private readonly offlineAfterMs: number

  constructor(opts: NodeRegistryOptions) {
    this.clock = opts.clock ?? (() => new Date().toISOString())
    this.offlineAfterMs = opts.offlineAfterMs ?? DEFAULT_OFFLINE_AFTER_MS
    for (const device of opts.devices) {
      this.devices.set(device.id, device)
      this.states.set(device.id, {
        device,
        lastSeenAt: '',
        registration: null,
        outbox: [],
        tickets: new Set(),
      })
    }
  }

  /** 节点 id 与密钥都匹配已登记设备才算通过。 */
  authenticate(nodeId: string, token: string): boolean {
    const device = this.devices.get(nodeId)
    return Boolean(device) && device!.token !== '' && device!.token === token
  }

  /** 只刷新心跳时间，不动已登记的设备信息。 */
  heartbeat(nodeId: string): void {
    const state = this.states.get(nodeId)
    if (state) state.lastSeenAt = this.clock()
  }

  /** 记录一次心跳 / 注册信息。 */
  touch(registration: NodeRegistration): NodeStatusView {
    const state = this.states.get(registration.nodeId)
    if (!state) throw new Error(`未登记的节点: ${registration.nodeId}`)
    state.lastSeenAt = this.clock()
    state.registration = registration
    return this.viewOf(state)
  }

  /** 节点离线后清掉它的在执行工单：中心已经知道它不在线，留着会误导。 */
  markOffline(nodeId: string): void {
    const state = this.states.get(nodeId)
    if (!state) return
    state.tickets.clear()
  }

  /** 中心 → 节点：消息入队。 */
  enqueue(nodeId: string, message: CenterToNodeMessage): void {
    const state = this.states.get(nodeId)
    if (!state) throw new Error(`未登记的节点: ${nodeId}`)
    state.outbox.push(message)
    if (message.kind === 'task') state.tickets.add(message.payload.ticketId)
    this.wake(nodeId)
  }

  /**
   * 等中心给某节点的消息：消息已在队列里就立刻返回，否则挂到超时。
   * 节点侧长轮询用它，被投递时立即唤醒，不用等满一个轮询周期。
   */
  waitFor(nodeId: string, timeoutMs: number): Promise<CenterToNodeMessage[]> {
    const ready = this.take(nodeId)
    if (ready.length > 0) return Promise.resolve(ready)
    return new Promise(resolve => {
      const settle = (messages: CenterToNodeMessage[]): void => resolve(messages)
      const timer = setTimeout(() => {
        const pending = this.waiters.get(nodeId) ?? []
        this.waiters.set(nodeId, pending.filter(item => item !== settle))
        settle([])
      }, timeoutMs)
      const wrapped = (messages: CenterToNodeMessage[]): void => {
        clearTimeout(timer)
        settle(messages)
      }
      const pending = this.waiters.get(nodeId) ?? []
      pending.push(wrapped)
      this.waiters.set(nodeId, pending)
    })
  }

  private wake(nodeId: string): void {
    const pending = this.waiters.get(nodeId)
    if (!pending || pending.length === 0) return
    const messages = this.take(nodeId)
    if (messages.length === 0) return
    this.waiters.set(nodeId, [])
    for (const waiter of pending) waiter(messages)
  }

  /** 节点长轮询：取走队列里的消息。 */
  take(nodeId: string): CenterToNodeMessage[] {
    const state = this.states.get(nodeId)
    if (!state) return []
    const messages = state.outbox
    state.outbox = []
    return messages
  }

  /** 工单结束：节点不再执行它。 */
  finishTicket(nodeId: string, ticketId: string): void {
    this.states.get(nodeId)?.tickets.delete(ticketId)
  }

  /** 所有登记设备的状态视图；离线设备也列出来，便于排查。 */
  status(): NodeStatusView[] {
    return [...this.states.values()].map(state => this.viewOf(state))
  }

  private viewOf(state: NodeState): NodeStatusView {
    const registration = state.registration
    const online = state.lastSeenAt !== '' && Date.parse(this.clock()) - Date.parse(state.lastSeenAt) < this.offlineAfterMs
    return {
      nodeId: state.device.id,
      name: state.device.name,
      online,
      lastSeenAt: state.lastSeenAt,
      runtimes: registration?.runtimes ?? [],
      projects: registration?.projects.map(project => project.name) ?? [],
      tickets: [...state.tickets],
    }
  }
}
