/**
 * 事件来源端口。
 *
 * 事件来源只负责「把外面发生的事变成事件」，不做判定、不派工：
 * 判定与派发在宿主的事件管线里统一做，避免每个来源各写一套。
 */

/** 来源侧的一条原始事件；来源只做归一化，不写业务结论。 */
export interface EventEnvelope {
  /**
   * 来源自己的事件 id；**同一来源内必须稳定不变**。
   *
   * 这是去重的唯一依据：宿主按 `(来源 id, externalId)` 唯一入库，
   * 同一事件无论被拉取多少次，表里永远只有一条。
   * 插件不遵守这条约定时，同一事件会重复入队（宿主不猜、不改写来源的 id）。
   */
  externalId: string
  /** 一句话标题。 */
  title: string
  /** 正文：判定与派工的主要依据。 */
  body: string
  /**
   * 事件类型；**带来源前缀**，如 `github.issues.opened`。
   *
   * 前缀是来源自己的标识（`github` / `feishu` / 插件 id）：
   * 不同来源的同名类型靠它区分，队列里一眼能看出事件来自哪里。
   * 缺省时由宿主按来源种类补一个默认类型。
   */
  eventType?: string
  /** 来源侧的单调递增 id；来源用它做增量拉取，不参与去重。 */
  id?: string
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

/** 事件来源的公共契约：轮询型实现 poll。 */
export interface EventSource {
  readonly id: string
  /** 来源种类：github / feishu / 自定义插件 id。 */
  readonly kind: string
  /** 拉取一批新事件；没有新事件返回空数组。 */
  poll?(): Promise<EventEnvelope[]> | EventEnvelope[]
  stop?(): void
  /**
   * 把结论回写到来源（Issue 评论 / HTTP 回调）。
   *
   * 没有回写能力的事件只落库，面板里能看到，但不会假装「做完了」。
   */
  publish?(target: { externalId: string; url?: string }, text: string): Promise<void>
}
