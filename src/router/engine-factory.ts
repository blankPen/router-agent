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
