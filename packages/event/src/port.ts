/**
 * 事件来源端口。
 *
 * 事件来源只负责「把外面发生的事变成事件」，不做判定、不派工：
 * 判定与派发在宿主的事件管线里统一做，避免每个来源各写一套。
 */

/** 来源侧的一条原始事件；来源只做归一化，不写业务结论。 */
export interface EventEnvelope {
  /** 来源自己的事件 id；同一来源内唯一，用于幂等去重。 */
  externalId: string
  /** 一句话标题。 */
  title: string
  /** 正文：判定与派工的主要依据。 */
  body: string
  /** 事件在来源侧的链接；回写结论时用。 */
  url?: string
  /** 原始载荷，便于审计与回放。 */
  raw?: unknown
  /** 到达时间（ISO）；缺省由宿主补当前时间。 */
  receivedAt?: string
  /**
   * 来源已知的上下文线索（例如订阅里写明的仓库）。
   *
   * 这类线索只作为决策模型的输入，不直接决定归属项目：
   * 归属项目由决策模型按可配置的决策 prompt 判定。
   */
  context?: Record<string, string>
}

/** 事件来源的公共契约。轮询型实现 poll，订阅型实现 start。 */
export interface EventSource {
  readonly id: string
  /** 来源种类：github / http / schedule / 自定义插件 id。 */
  readonly kind: string
  /** 拉取一批新事件；没有新事件返回空数组。 */
  poll?(): Promise<EventEnvelope[]> | EventEnvelope[]
  /** 订阅型来源：把事件推进来。 */
  start?(sink: (event: EventEnvelope) => void): Promise<void> | void
  stop?(): void
  /**
   * 把结论回写到来源（Issue 评论 / HTTP 回调）。
   *
   * 没有回写能力的事件只落库，面板里能看到，但不会假装「做完了」。
   */
  publish?(target: { externalId: string; url?: string }, text: string): Promise<void>
}

/** 事件来源的能力声明；宿主按能力决定怎么驱动它。 */
export interface EventSourceCapabilities {
  /** 支持主动拉取。 */
  poll: boolean
  /** 支持订阅推送。 */
  subscribe: boolean
  /** 支持把结论回写到来源。 */
  writeback: boolean
}

/** 按实现推断能力：实现哪个方法就有什么能力。 */
export function capabilitiesOf(source: EventSource): EventSourceCapabilities {
  return {
    poll: typeof source.poll === 'function',
    subscribe: typeof source.start === 'function',
    writeback: typeof source.publish === 'function',
  }
}
