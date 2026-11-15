import { describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { defaultConfig, policyOf, type AppConfig } from '../../src/config.js'
import { EventDecisionService, ruleDecisionPort } from '../../src/events/decision.js'
import { EventPipeline } from '../../src/events/pipeline.js'
import { EventManager } from '../../src/events/manager.js'

const SOURCE = { enabled: true, kind: 'github' as const, repo: 'a/b', project: 'router-agent', defaultPriority: 'P2' as const, defaultType: 'issue' }

function setup() {
  const store = new Store(':memory:')
  const base = defaultConfig()
  const config: AppConfig = {
    ...base,
    projects: [{ name: 'router-agent', repo: '/r/a', defaultBranch: 'main' }],
    events: { ...base.events, enabled: true, sources: { github: SOURCE } },
  }
  // 固定时刻落在低峰窗口（本地 22:00），P2 事件允许自动执行。
  const now = new Date(2026, 10, 13, 22, 0, 0).toISOString()
  let counter = 0
  const engine = new Engine({ store, policy: policyOf(config), clock: { now: () => now }, ids: { next: p => `${p}_${counter}` } })
  const decision = new EventDecisionService({ decision: config.events.decision, rule: ruleDecisionPort })
  const pipeline = new EventPipeline({ store, engine, config: () => config, clock: () => now, ids: p => `${p}_${++counter}`, decision })
  const manager = new EventManager({
    store, pipeline, config: () => config,
    clock: () => now,
    runner: { run: async () => ({ code: 1, stdout: '', stderr: 'x' }) },
    tickMs: 30,
  })
  return { store, config, pipeline, manager }
}

describe('事件管理器', () => {
  it('关掉总开关后，已入队的事件不再判定与派发', async () => {
    const { store, config, pipeline, manager } = setup()
    await manager.start()
    const event = pipeline.ingest('github', SOURCE, { externalId: 'issue:x#1', title: '崩', body: '崩' })

    config.events.enabled = false
    await manager.reloadSources()
    await manager.runTick()

    const stored = store.getEvent(event.id)!
    expect(stored.ticketId).toBeUndefined()
    expect(store.listTickets()).toHaveLength(0)
    manager.stop()
  })

  it('总开关开着时事件照常派发', async () => {
    const { store, pipeline, manager } = setup()
    await manager.start()
    const event = pipeline.ingest('github', SOURCE, { externalId: 'issue:x#2', title: '崩', body: '崩' })
    await manager.runTick()
    expect(store.getEvent(event.id)?.ticketId).toBeTruthy()
    manager.stop()
  })
})
