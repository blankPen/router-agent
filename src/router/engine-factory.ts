import { join } from 'node:path'
import type { AppConfig } from '../config.js'
import type { Store } from '../store/db.js'
import type { Engine } from '../core/engine.js'
import type { PiModelConfig } from './model-config.js'
import { PiDecisionEngine } from './pi-decision-engine.js'
import { PiIntakeEngine } from './intake-engine.js'
import { SqliteSessionPersistence } from './session-persistence.js'
import { RouterToolbox, type RouterToolboxDeps } from './tools.js'
import type { Logger } from '#infra/logger.js'
import { effectiveAllowed, effectiveAllowedByChat } from '#core/policy.js'
import { DecisionAgent, JevDecisionProvider, LlmDecisionProvider, type DecisionProvider } from './decision/agent.js'
import type { IntakeEngine } from './intake-engine.js'

export interface DecisionEngineFactoryOptions {
  config: AppConfig
  store: Store
  model: PiModelConfig
  /** 关单 / 回收 workspace 等运维工具需要 Engine；只读场景可不传。 */
  engine?: Engine
  /** 版本检查 / 升级；传入后模型才拥有 router_update 工具。 */
  updater?: RouterToolboxDeps['updater']
  /** 安装成功后安排重启；不传时更新工具只安装不重启（simulate 等场景）。 */
  scheduleRestart?: RouterToolboxDeps['scheduleRestart']
}

/** 装配唯一的研判引擎：Pi。 */
export function createDecisionEngine(opts: DecisionEngineFactoryOptions): PiDecisionEngine {
  const session = opts.config.router.session
  return new PiDecisionEngine({
    model: opts.model,
    toolbox: new RouterToolbox({
      store: opts.store,
      ...(opts.engine ? { engine: opts.engine } : {}),
      ...(opts.updater ? { updater: opts.updater } : {}),
      ...(opts.scheduleRestart ? { scheduleRestart: opts.scheduleRestart } : {}),
    }),
    agentDir: opts.config.router.agentDir || join(opts.config.home, 'pi'),
    cwd: opts.config.home,
    timeoutMs: opts.config.router.timeoutMs,
    tokenBudget: opts.config.router.tokenBudget,
    ...(session.enabled
      ? {
          sessionPersistence: new SqliteSessionPersistence(opts.store),
          sessionDir: session.dir || join(opts.config.home, 'sessions'),
          sessionIdleTtlMs: session.idleTtlMs,
          maxActiveSessions: session.maxActive,
          sessionTimeoutMs: session.turnTimeoutMs,
          sessionTokenBudget: session.tokenBudget,
          compaction: session.compaction,
          contextWindow: opts.config.llm?.contextWindow ?? 128_000,
        }
      : {}),
  })
}


/** 决策层装配参数：在研判引擎参数之上多一个分析引擎（LLM 兜底用）。 */
export interface DecisionAgentFactoryOptions extends DecisionEngineFactoryOptions {
  intakeEngine?: IntakeEngine
  logger?: Logger
}

/**
 * 装配决策层：普通成员消息先过确定性准入，再交 Jev（或 LLM 模拟）分类。
 * 未开启（decision.enabled=false）或没有可用 Provider 时返回 null，保持原有 LLM 初筛行为。
 */
export function createDecisionAgent(opts: DecisionAgentFactoryOptions): DecisionAgent | null {
  const decision = opts.config.decision
  if (!decision.enabled) return null
  let provider: DecisionProvider
  if (decision.provider === 'jev' && decision.jev.apiKey && decision.jev.model) {
    provider = new JevDecisionProvider({
      apiKey: decision.jev.apiKey,
      model: decision.jev.model,
      ...(decision.jev.baseUrl ? { baseUrl: decision.jev.baseUrl } : {}),
    })
  } else if (opts.intakeEngine) {
    provider = new LlmDecisionProvider(opts.intakeEngine, opts.config.home)
  } else {
    opts.logger?.warn('decision:provider-missing', { detail: 'decision.enabled 但 Jev 密钥与 LLM 引擎都不可用，回退 LLM 初筛' })
    return null
  }
  return new DecisionAgent({
    provider,
    isAdmin: trigger => {
      const policy = opts.engine?.policy()
      if (!policy) return false
      const scoped = effectiveAllowedByChat(policy, trigger.chatId)
      const allowed = scoped ?? effectiveAllowed(policy)
      return allowed.includes(trigger.actorId)
    },
    // 话题已绑定在办工单的放行消息由 Gate 打标（unaddressedAdmitted），走工单相关路径。
    hasBoundTicket: trigger => Boolean(trigger.unaddressedAdmitted),
    isCommand: text => /^\s*(?:@\S+\s+)?\/new\s*$/.test(text),
    logger: opts.logger,
  })
}

/** 装配需求识别引擎：初筛与分析共用一个 Pi 通道，读代码能力由 intake-flow 逐轮决定。 */
export function createIntakeEngine(
  opts: Omit<DecisionEngineFactoryOptions, 'engine' | 'updater' | 'scheduleRestart'> & { logger?: Logger },
): PiIntakeEngine {
  return new PiIntakeEngine({
    model: opts.model,
    agentDir: opts.config.router.agentDir || join(opts.config.home, 'pi'),
    cwd: opts.config.home,
    timeoutMs: opts.config.router.timeoutMs,
    ...(opts.logger ? { logger: opts.logger } : {}),
  })
}
