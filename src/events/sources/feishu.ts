/**
 * 飞书消息订阅来源：本期占位。
 *
 * 飞书群消息已经由 channel 链路（路 A）处理，事件链路不重复接管；
 * 这里只保留开关与占位实现，二期再补规则检测（例如「@某人 + 关键词」才进事件队列）。
 */
import type { EventSourceConfig } from '../../config.js'
import type { EventEnvelope, EventSource } from '#event/port.js'
import { noopLogger, type Logger } from '#infra/logger.js'

/** 飞书事件的来源前缀：事件类型与幂等键都带它。 */
export const FEISHU_EVENT_PREFIX = 'feishu'

/** 飞书消息订阅来源（占位）。 */
export class FeishuEventSource implements EventSource {
  readonly id: string
  readonly kind = 'feishu'
  private logger: Logger

  constructor(id: string, _config: EventSourceConfig, deps: { logger?: Logger } = {}) {
    this.id = id
    this.logger = deps.logger ?? noopLogger
  }

  /** 占位：不产出事件。 */
  poll(): EventEnvelope[] {
    this.logger.info('event:source-placeholder', { sourceId: this.id, kind: this.kind })
    return []
  }
}
