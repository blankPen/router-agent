import { join } from 'node:path'
import type { AppConfig } from '../config.js'
import type { Engine } from '../core/engine.js'
import type { Store } from '../store/db.js'
import { CustomDecisionEngine } from './custom-decision-engine.js'
import type { DecisionEngine, DecisionEngineKind } from './decision-engine.js'
import type { LlmClient, LlmConfig } from './llm.js'
import { PiDecisionEngine } from './pi-decision-engine.js'
import { RouterToolbox } from './tools.js'

export interface DecisionEngineFactoryOptions {
  config: AppConfig
  engine: Engine
  store: Store
  /** 自研引擎与「礼貌回复」共用。 */
  llm: LlmClient
  /** Pi 引擎所需模型配置；不配置 pi 时可以不传。 */
  llmConfig?: LlmConfig
  toolbox?: RouterToolbox
}

export interface DecisionEngineBundle {
  primary: DecisionEngine
  shadow?: DecisionEngine
}

/**
 * 按配置装配研判引擎。
 * 默认仍是 custom；pi 只在显式配置后启用，shadow 与主引擎相同时自动忽略。
 */
export function createDecisionEngineBundle(opts: DecisionEngineFactoryOptions): DecisionEngineBundle {
  const toolbox = opts.toolbox ?? new RouterToolbox({ engine: opts.engine, store: opts.store })
  // 影子引擎只允许读与 proposal，不能产生任何领域副作用。
  const shadowToolbox = new RouterToolbox({ engine: opts.engine, store: opts.store, readOnly: true })
  const agentDir = opts.config.router.agentDir || join(opts.config.home, 'pi')

  const make = (kind: DecisionEngineKind, tools: RouterToolbox): DecisionEngine => {
    if (kind === 'pi') {
      if (!opts.llmConfig) throw new Error('pi:llm-config-missing')
      return new PiDecisionEngine({
        llm: opts.llmConfig,
        toolbox: tools,
        agentDir,
        cwd: opts.config.home,
        timeoutMs: opts.config.router.timeoutMs,
        tokenBudget: opts.config.router.tokenBudget,
      })
    }
    return new CustomDecisionEngine({
      llm: opts.llm,
      toolbox: tools,
      maxToolRounds: opts.config.router.maxToolRounds,
      timeoutMs: opts.config.router.timeoutMs,
      tokenBudget: opts.config.router.tokenBudget,
    })
  }

  const primary = make(opts.config.router.decisionEngine, toolbox)
  const shadowKind = opts.config.router.shadow
  const shadow = shadowKind !== 'off' && shadowKind !== opts.config.router.decisionEngine ? make(shadowKind, shadowToolbox) : undefined
  return { primary, ...(shadow ? { shadow } : {}) }
}
