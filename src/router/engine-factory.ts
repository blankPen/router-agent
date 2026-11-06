import { join } from 'node:path'
import type { AppConfig } from '../config.js'
import type { Store } from '../store/db.js'
import type { PiModelConfig } from './model-config.js'
import { PiDecisionEngine } from './pi-decision-engine.js'
import { RouterToolbox } from './tools.js'

export interface DecisionEngineFactoryOptions {
  config: AppConfig
  store: Store
  model: PiModelConfig
}

/** 装配唯一的研判引擎：Pi。 */
export function createDecisionEngine(opts: DecisionEngineFactoryOptions): PiDecisionEngine {
  return new PiDecisionEngine({
    model: opts.model,
    toolbox: new RouterToolbox({ store: opts.store }),
    agentDir: opts.config.router.agentDir || join(opts.config.home, 'pi'),
    cwd: opts.config.home,
    timeoutMs: opts.config.router.timeoutMs,
    tokenBudget: opts.config.router.tokenBudget,
  })
}