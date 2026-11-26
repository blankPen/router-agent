/**
 * 订阅命中与幂等：事件从来源到任务的那一段。
 *
 * 覆盖 §12.3（V11~V16）：装配订阅、事件入库、幂等、关键词过滤、
 * 同一事件被两个任务订阅、来源失败不影响别的任务。
 * 以及 §12.5（V22~V24）：归属信息、订阅命中聚合、长期 0 命中的提示。
 */
import { describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { defaultConfig, policyOf, type AppConfig } from '../../src/config.js'
import { EventDecisionService } from '../../src/events/decision.js'
import { EventPipeline } from '../../src/events/pipeline.js'
import { EventManager } from '../../src/events/manager.js'
import { deriveSubscriptions, matchesKeywords, subscriptionMatchesType } from '../../src/events/subscriptions.js'
import { subscription } from './fixtures.js'
import type { Automation } from '#core/automation.js'

const SOURCE = { enabled: true, kind: 'github' as const, repo: 'blankPen/router-agent' }

/** 造一条事件触发的自动化任务。 */
function taskOf(over: Partial<Automation> = {}): Automation {
  return {
    id: 'auto_1',
    name: 'Issue 处理',
    description: '',
    type: 'ai',
    prompt: '处理这条 issue。',
    trigger: {
      kind: 'event',
      source: 'github',
      types: ['github.issues.opened'],
      params: { repo: 'blankPen/router-agent' },
      filter: { keywords: [], semantic: '' },
      mode: 'auto',
    },
    runtimeId: '',
    project: 'router-agent',
    repo: '/r/router-agent',
    branch: 'main',
    enabled: true,
    createdBy: '',
    createdAt: '2026-11-13T10:00:00.000Z',
    updatedAt: '2026-11-13T10:00:00.000Z',
    ...over,
  }
}

function setup(subscriptions = [subscription()]) {
  const store = new Store(':memory:')
  const base = defaultConfig()
  const config: AppConfig = {
    ...base,
    projects: [{ name: 'router-agent', repo: '/r/router-agent', defaultBranch: 'main' }],
    events: { ...base.events, enabled: true, sources: { github: SOURCE } },
  }
  const now = new Date(2026, 10, 13, 22, 0, 0).toISOString()
  let counter = 0
  const engine = new Engine({ store, policy: policyOf(config), clock: { now: () => now }, ids: { next: p => `${p}_${counter}` } })
  const decision = new EventDecisionService({ decision: config.events.decision })
  const pipeline = new EventPipeline({
    store, engine, config: () => config, clock: () => now,
    ids: p => `${p}_${++counter}`, decision, subscriptions: () => subscriptions,
  })
  const manager = new EventManager({
    store, pipeline, config: () => config, clock: () => now,
    runner: { run: async () => ({ code: 1, stdout: '', stderr: '拉取失败' }) },
    subscriptions: () => subscriptions,
    tickMs: 30,
  })
  return { store, config, pipeline, manager }
}

describe('订阅推导', () => {
  it('定时任务不产生订阅，事件任务产生一条', () => {
    const eventTask = taskOf()
    const scheduleTask = taskOf({
      id: 'auto_2',
      trigger: { kind: 'schedule', schedule: { kind: 'daily', at: '09:00' } },
    })
    const subs = deriveSubscriptions([eventTask, scheduleTask])
    expect(subs).toHaveLength(1)
    expect(subs[0]!.id).toBe('auto_1')
    expect(subs[0]!.taskName).toBe('Issue 处理')
  })

  it('停用的任务不产生订阅', () => {
    expect(deriveSubscriptions([taskOf({ enabled: false })])).toHaveLength(0)
  })

  it('事件类型精确匹配，通配不成立', () => {
    const sub = subscription()
    expect(subscriptionMatchesType(sub, 'github.issues.opened')).toBe(true)
    expect(subscriptionMatchesType(sub, 'github.issues.closed')).toBe(false)
    expect(subscriptionMatchesType(sub, '*')).toBe(false)
  })

  it('没配关键词时一律通过；配了则任一命中即通过', () => {
    expect(matchesKeywords(subscription(), '随便什么内容')).toBe(true)
    expect(matchesKeywords(subscription({ filter: { keywords: ['退款'], semantic: '' } }), '我要退款')).toBe(true)
    expect(matchesKeywords(subscription({ filter: { keywords: ['退款'], semantic: '' } }), '无关内容')).toBe(false)
  })
})

describe('事件入库与幂等', () => {
  it('任务建好后 watcher 自动装配并注册订阅（V11）', async () => {
    const subs = [subscription()]
    const { manager } = setup(subs)
    await manager.reloadSubscriptions()
    const sources = manager.listSources()
    expect(sources.some(item => item.subscriptions === 1)).toBe(true)
    manager.stop()
  })

  it('事件入库时带上订阅 id（V12）', () => {
    const { store, pipeline } = setup()
    const event = pipeline.ingest('github', 'github', subscription(), {
      externalId: 'issue:x#1',
      title: '崩',
      body: '崩',
      eventType: 'github.issues.opened',
    })
    expect(store.getEvent(event.id)?.subscriptionId).toBe('auto_test')
  })

  it('同一条事件再拉一次不重复入库（V13）', () => {
    const { store, pipeline } = setup()
    const sub = subscription()
    const envelope = { externalId: 'issue:x#2', title: '崩', body: '崩', eventType: 'github.issues.opened' }
    const first = pipeline.ingest('github', 'github', sub, envelope)
    const second = pipeline.ingest('github', 'github', sub, envelope)
    expect(second.id).toBe(first.id)
    expect(store.listEvents({ limit: 50 }).filter(item => item.externalId === 'issue:x#2')).toHaveLength(1)
  })

  it('不命中关键词的事件被过滤掉，不进判定（V14）', async () => {
    const sub = subscription({ filter: { keywords: ['退款'], semantic: '' } })
    const { store, pipeline } = setup([sub])
    const event = pipeline.ingest('github', 'github', sub, {
      externalId: 'issue:x#3',
      title: '文档更新',
      body: '无关内容',
      eventType: 'github.issues.opened',
    })
    await pipeline.tick()
    expect(store.getEvent(event.id)?.status).toBe('invalid')
    expect(store.getEvent(event.id)?.reason).toContain('未命中订阅关键词')
  })

  it('同一个事件被两个任务订阅，各存一条，互不干扰（V15）', () => {
    const subA = subscription({ id: 'auto_a' })
    const subB = subscription({ id: 'auto_b' })
    const { store, pipeline } = setup([subA, subB])
    const envelope = { externalId: 'issue:x#4', title: '崩', body: '崩', eventType: 'github.issues.opened' }
    pipeline.ingest('github', 'github', subA, envelope)
    pipeline.ingest('github', 'github', subB, envelope)
    const rows = store.listEvents({ limit: 50 }).filter(item => item.externalId === 'issue:x#4')
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(item => item.subscriptionId))).toEqual(new Set(['auto_a', 'auto_b']))
  })

  it('来源拉取失败不影响别的任务（V16）', async () => {
    const { manager } = setup()
    await manager.start()
    await manager.runTick()
    // 拉取失败不该把管理器打挂：来源还在，其它任务照常。
    expect(manager.listSources().length).toBeGreaterThan(0)
    manager.stop()
  })

  it('订阅命中按任务聚合，长期 0 命中可识别（V23/V24）', async () => {
    const sub = subscription({ id: 'auto_x', taskName: 'CI 修复' })
    const { store, pipeline } = setup([sub])
    const event = pipeline.ingest('github', 'github', sub, {
      externalId: 'issue:x#5',
      title: '崩',
      body: '崩',
      eventType: 'github.workflow_run.failure',
    })
    await pipeline.tick()
    const stats = store.countEventsBySubscription()
    expect(stats['auto_x']).toBeTruthy()
    const counted = Object.values(stats['auto_x']!).reduce((sum, value) => sum + value, 0)
    expect(counted).toBeGreaterThan(0)
    // 没命中的任务在聚合里查不到 —— 面板据此显示「尚未命中」。
    expect(stats['auto_never']).toBeUndefined()
    expect(store.getEvent(event.id)?.subscriptionId).toBe('auto_x')
  })
})
