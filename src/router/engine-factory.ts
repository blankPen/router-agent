import { join } from 'node:path'
import type { AppConfig } from '../config.js'
import type { Store } from '../store/db.js'
import type { Engine } from '../core/engine.js'
import type { PiModelConfig } from './model-config.js'
import { PiDecisionEngine } from './pi-decision-engine.js'
import { SqliteSessionPersistence } from './session-persistence.js'
import { RouterToolbox } from './tools.js'

export interface DecisionEngineFactoryOptions {
  config: AppConfig
  store: Store
  model: PiModelConfig
  /** 关单 / 回收 workspace 等运维工具需要 Engine；只读场景可不传。 */
  engine?: Engine
}

/** 装配唯一的研判引擎：Pi。 */
export function createDecisionEngine(opts: DecisionEngineFactoryOptions): PiDecisionEngine {
  const session = opts.config.router.session
  return new PiDecisionEngine({
    model: opts.model,
    toolbox: new RouterToolbox({
      store: opts.store,
      ...(opts.engine ? { engine: opts.engine } : {}),
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
