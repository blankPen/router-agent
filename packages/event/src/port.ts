/**
 * 事件来源端口。
 *
 * 一个事件来源只回答「有什么事件可订阅」：
 * - `EventCatalog` 声明可订阅的事件类型与连接参数（插件唯一必须实现的）；
 * - `EventFetcher` 是可选的拉取扩展点，不实现就由宿主按目录拉。
 *
 * 订阅本身不属于来源：订阅是自动化任务的一部分（见 `packages/core/src/automation.ts`）。
 */

/** 来源侧的一条原始事件；来源只做归一化，不写业务结论。 */
export interface EventEnvelope {
  /**
   * 来源自己的事件 id；**同一来源内必须稳定不变**。
   *
   * 这是去重的唯一依据：宿主按 `(订阅 id, externalId)` 唯一入库，
   * 同一事件无论被拉取多少次，表里永远只有一条。
   *
   * 复合唯一性由来源自己保证（飞书的表情事件要把 message_id + 类型 + 时间拼起来），
   * 宿主不猜、不改写来源的 id。
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
   * 来源已知的上下文线索（例如订阅里写明的仓库、群 id、发送人）。
   *
   * 这类线索只作为判定模型的输入，不直接决定归属项目：
   * 归属项目是自动化任务的属性，由会话解析时从对话内容分析得出。
   */
  context?: Record<string, string>
}

/** 一个可订阅的事件类型。 */
export interface EventTypeDescriptor {
  /** 带来源前缀的完整类型 id，如 `github.issues.opened`。 */
  id: string
  /** 人话标签，面板与模型提示词里用。 */
  label: string
  /** 分组，如「Issue」「群与成员」。 */
  group: string
  /**
   * 可用性标注：当前来源能不能直接用这个类型。
   *
   * 飞书有 18 个类型需要先在开发者后台订阅事件类型；这类类型要**列出来并标注**，
   * 而不是藏起来 —— 用户要知道「有这个能力，去开一下就能用」。
   */
  availability?: EventTypeAvailability
}

/** 事件类型的可用性；缺省表示开箱可用。 */
export interface EventTypeAvailability {
  /** 是否开箱可用（不需要任何前置操作）。 */
  ready: boolean
  /** 需要在来源侧后台订阅事件类型。 */
  requiresConsoleSubscription?: boolean
  /** 需要用户身份（bot 身份订阅不了）。 */
  requiresUserIdentity?: boolean
  /** 需要额外的权限 scope。 */
  requiresScopes?: string[]
  /** 需要用户额外提供的参数（如白板的 whiteboard_id）。 */
  requiresParams?: string[]
  /** 给用户看的前置条件说明。 */
  note?: string
}

/** 连接参数声明：来源插件自己说「我要用户提供什么」。 */
export interface EventParamDescriptor {
  key: string
  label: string
  kind: 'text' | 'password' | 'select' | 'number' | 'boolean'
  hint?: string
  options?: string[]
  /** 必填参数：会话建任务时必须问到它，问不到就不建任务。 */
  required?: boolean
}

/**
 * 事件目录：插件唯一必须实现的接口。
 *
 * 只回答「有什么事件可订阅」，不拉取、不判定、不派工。
 */
export interface EventCatalog {
  readonly id: string
  /** 来源种类：github / feishu / 插件 id。 */
  readonly kind: string
  /** 来源名字（面板展示）。 */
  readonly name: string
  /** 这个来源能订阅哪些事件类型。 */
  types(): EventTypeDescriptor[]
  /** 这个来源需要哪些连接参数；没声明就是零参数。 */
  params(): EventParamDescriptor[]
}

/**
 * 事件拉取器：插件可选实现。
 *
 * 不实现就用宿主的通用 watcher（轮询 + 去重 + 窗口裁剪）。
 */
export interface EventFetcher {
  readonly id: string
  readonly kind: string
  /** 拉一批新事件；没有新事件返回空数组。 */
  poll?(subscription: EventSubscription): Promise<EventEnvelope[]> | EventEnvelope[]
  stop?(): void
  /**
   * 把结论回写到来源（Issue 评论 / HTTP 回调）。
   *
   * 没有回写能力的事件只落库，面板里能看到，但不会假装「做完了」。
   */
  publish?(target: { externalId: string; url?: string }, text: string): Promise<void>
}

/** 一次订阅：宿主从自动化任务里推导出来，交给 watcher 拉事件。 */
export interface EventSubscription {
  /** 订阅 id：等于自动化任务 id，事件按它归属。 */
  id: string
  /** 来源目录 id。 */
  source: string
  /** 订阅的事件类型（带前缀）。 */
  types: string[]
  /** 每个订阅自己的参数（仓库、群、白板 id …）。 */
  params: Record<string, string>
}

/**
 * 事件来源的公共契约：轮询型实现 poll。
 *
 * @deprecated v0.4.0 起不再加载实现此接口的插件；改用 `EventCatalog`。
 */
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
   * @deprecated 改用 `EventFetcher.publish`。
   */
  publish?(target: { externalId: string; url?: string }, text: string): Promise<void>
}
