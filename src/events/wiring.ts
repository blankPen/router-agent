/**
 * 事件总线的装配：把配置、模型与存储接成一条可运行的管线。
 *
 * 判定 provider 按配置在运行时选择：jev 优先、llm 兜底、rule 只用规则。
 * 模型没配时降级成规则判定，事件仍然能被处理，不会整条链路停摆。
 */
import type { AppConfig } from '../config.js'
import type { Store } from '../store/db.js'
import type { Engine } from '../core/engine.js'
import type { ChatClient } from '#infra/chat.js'
import { createChatClient } from '#infra/chat.js'
import { JevClient } from '#infra/decision/jev-client.js'
import { noopLogger, type Logger } from '#infra/logger.js'
import type { CommandRunner } from '#infra/process.js'
import { EventDecisionService, ruleDecisionPort, type EventDecisionPort } from './decision.js'
import { createJevDecisionPort, createLlmDecisionPort } from './decision-model.js'
import { EventManager } from './manager.js'
import { EventPipeline } from './pipeline.js'

export interface EventWiringDeps {
  config: () => AppConfig
  store: Store
  engine: Engine
  logger?: Logger
  /** 执行外部命令（GitHub 来源用 gh）。 */
  runner: CommandRunner
  /** 当前 LLM 连接信息；没配模型时为 null。 */
  model: () => { baseUrl: string; apiKey: string; model: string; api?: 'openai-completions' | 'anthropic-messages' } | null
  /** 事件判定后的回调（通知 admin、刷新派工）。 */
  onReview?: (event: { id: string; title: string; priority: string; reason?: string }) => void | Promise<void>
  onDispatched?: () => void | Promise<void>
}

/** 装配好的事件总线。 */
export interface EventWiring {
  manager: EventManager
  pipeline: EventPipeline
  decision: EventDecisionService
}

/**
 * 按配置动态选择判定模型：面板改完立即生效，不用重启。
 * 模型没配好时返回 null，判定服务自动退回规则判定。
 */
export function createConfigurableDecisionPort(deps: {
  config: () => AppConfig
  model: () => { baseUrl: string; apiKey: string; model: string; api?: 'openai-completions' | 'anthropic-messages' } | null
  logger?: Logger
}): EventDecisionPort {
  const logger = deps.logger ?? noopLogger
  let cached: { key: string; port: EventDecisionPort } | null = null
  return {
    name: 'model',
    async decide(input) {
      const provider = deps.config().events.decision.provider
      if (provider === 'rule') return null
      if (provider === 'jev') {
        const jev = deps.config().decision.jev
        if (!jev.apiKey || !jev.model) {
          logger.warn('event:decision-provider-unavailable', { provider: 'jev' })
          return null
        }
        const key = `jev:${jev.model}:${jev.baseUrl ?? ''}`
        if (!cached || cached.key !== key) {
          const client = new JevClient({ apiKey: jev.apiKey, model: jev.model, ...(jev.baseUrl ? { baseUrl: jev.baseUrl } : {}) })
          cached = { key, port: createJevDecisionPort(client, { logger }) }
        }
        return cached.port.decide(input)
      }
      const model = deps.model()
      if (!model) {
        logger.warn('event:decision-provider-unavailable', { provider: 'llm' })
        return null
      }
      const key = `llm:${model.model}:${model.baseUrl}`
      if (!cached || cached.key !== key) {
        const client: ChatClient = createChatClient(model)
        cached = { key, port: createLlmDecisionPort(client, { logger }) }
      }
      return cached.port.decide(input)
    },
  }
}

/** 装配事件总线。 */
export function createEventWiring(deps: EventWiringDeps): EventWiring {
  const logger = deps.logger ?? noopLogger
  const decision = new EventDecisionService({
    decision: deps.config().events.decision,
    rule: ruleDecisionPort,
    model: createConfigurableDecisionPort({
      config: deps.config,
      model: deps.model,
      logger,
    }),
    logger,
  })
  const pipeline = new EventPipeline({
    store: deps.store,
    engine: deps.engine,
    config: deps.config,
    clock: () => new Date().toISOString(),
    ids: prefix => `${prefix}_${crypto.randomUUID()}`,
    decision,
    logger,
    ...(deps.onReview ? { onReview: deps.onReview } : {}),
    ...(deps.onDispatched ? { onDispatched: deps.onDispatched } : {}),
  })
  const manager = new EventManager({
    store: deps.store,
    pipeline,
    config: deps.config,
    clock: () => new Date().toISOString(),
    runner: deps.runner,
    logger,
  })
  return { manager, pipeline, decision }
}
