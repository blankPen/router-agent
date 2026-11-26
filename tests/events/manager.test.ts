import { describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { defaultConfig, policyOf, type AppConfig } from '../../src/config.js'
import { EventDecisionService } from '../../src/events/decision.js'
import { EventPipeline } from '../../src/events/pipeline.js'
import { EventManager } from '../../src/events/manager.js'
import { subscription } from './fixtures.js'

const SOURCE = { enabled: true, kind: 'github' as const, repo: 'blankPen/router-agent' }
const SUB = subscription()

function setup() {
  const store = new Store(':memory:')
  const base = defaultConfig()
  const config: AppConfig = {
    ...base,
    projects: [{ name: 'router-agent', repo: '/r/router-agent', defaultBranch: 'main' }],
    events: {
      ...base.events,
      enabled: true,
      sources: { github: SOURCE },
    },
  }
  // 固定时刻落在低峰窗口（本地 22:00），P3 事件允许自动执行。
  const now = new Date(2026, 10, 13, 22, 0, 0).toISOString()
  let counter = 0
  const engine = new Engine({ store, policy: policyOf(config), clock: { now: () => now }, ids: { next: p => `${p}_${counter}` } })
  const decision = new EventDecisionService({ decision: config.events.decision })
  const pipeline = new EventPipeline({
    store, engine, config: () => config, clock: () => now,
    ids: p => `${p}_${++counter}`, decision, subscriptions: () => [SUB],
  })
  const manager = new EventManager({
    store, pipeline, config: () => config,
    clock: () => now,
    runner: { run: async () => ({ code: 1, stdout: '', stderr: 'x' }) },
    subscriptions: () => [SUB],
    tickMs: 30,
  })
  return { store, config, pipeline, manager }
}

describe('事件管理器', () => {
  it('关掉总开关后，已入队的事件不再判定与派发', async () => {
    const { store, config, pipeline, manager } = setup()
    await manager.start()
    const event = pipeline.ingest('github', 'github', SUB, { externalId: 'issue:x#1', title: '崩', body: '崩', eventType: 'github.issues.opened' })

    config.events.enabled = false
    await manager.reloadSubscriptions()
    await manager.runTick()

    const stored = store.getEvent(event.id)!
    expect(stored.ticketId).toBeUndefined()
    expect(store.listTickets()).toHaveLength(0)
    manager.stop()
  })

  it('总开关开着时事件照常派发', async () => {
    const { store, pipeline, manager } = setup()
    await manager.start()
    const event = pipeline.ingest('github', 'github', SUB, { externalId: 'issue:x#2', title: '崩', body: '崩', eventType: 'github.issues.opened' })
    await manager.runTick()
    expect(store.getEvent(event.id)?.ticketId).toBeTruthy()
    manager.stop()
  })

  it('启动时总开关关着，之后打开也会开始判定', async () => {
    const { store, config, pipeline, manager } = setup()
    config.events.enabled = false
    await manager.start()
    const event = pipeline.ingest('github', 'github', SUB, { externalId: 'issue:x#3', title: '崩', body: '崩', eventType: 'github.issues.opened' })
    await manager.runTick()
    expect(store.getEvent(event.id)?.ticketId).toBeUndefined()

    config.events.enabled = true
    await manager.reloadSubscriptions()
    await manager.runTick()
    expect(store.getEvent(event.id)?.ticketId).toBeTruthy()
    manager.stop()
  })

  it('没有订阅时不装配来源，也就没有事件', async () => {
    const { manager } = setup()
    const managerWithout = new EventManager({
      store: new Store(':memory:'),
      pipeline: { ingest: () => ({}) } as never,
      config: () => defaultConfig(),
      clock: () => new Date().toISOString(),
      runner: { run: async () => ({ code: 0, stdout: '', stderr: '' }) },
      subscriptions: () => [],
    })
    await managerWithout.reloadSubscriptions()
    expect(managerWithout.listSources().every(item => item.subscriptions === 0)).toBe(true)
    managerWithout.stop()
    manager.stop()
  })
})
