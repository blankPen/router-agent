import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store/db.js'
import { Engine } from '../src/core/engine.js'
import { RouterService } from '../src/service.js'
import { defaultConfig, policyOf, type AppConfig, chatEntry } from '../src/config.js'
import { DEFAULT_ADMISSION } from '../src/core/policy.js'
import type { WorkerBackend, WorkerContext } from '../src/worker/port.js'
import type { Trigger } from '../src/core/model.js'

class FakeBackend implements WorkerBackend {
  readonly id = 'orca'
  starts: WorkerContext[] = []
  delivered: { handle: string; text: string }[] = []
  handles = new Map<string, { lastOutputAt: string }>()
  linkedPr: Record<string, unknown> | null = null
  async start(ctx: WorkerContext) {
    const handle = `term-${this.starts.length + 1}`
    this.starts.push(ctx)
    this.handles.set(handle, { lastOutputAt: new Date().toISOString() })
    return { handle, workdir: `/tmp/${ctx.ticket.id}` }
  }
  async deliver(handle: string, inputs: { text: string }[]) {
    for (const input of inputs) this.delivered.push({ handle, text: input.text })
  }
  async registerContext() {}
  async stop() {}
  async inspect(handle: string) {
    const entry = this.handles.get(handle)
    return entry ? { handle, connected: true, writable: true, orphaned: false, lastOutputAt: entry.lastOutputAt, worktreePath: '', branch: '' } : null
  }
  async inspectWorktree() {
    return this.linkedPr
  }
}

class NullPrTracker {
  async view() { return null }
  async findByBranch() { return null }
}

function trigger(over: Partial<Trigger> = {}): Trigger {
  return {
    id: 't1', source: 'feishu', externalId: 'om_1', threadId: 'feishu:oc_dev:om_root', chatId: 'oc_dev', chatName: '研发群',
    actorId: 'ou_alice', actorName: 'Alice', isBot: false, text: '帮我把登录超时改成 30 秒', addressed: 'mention',
    receivedAt: '2026-11-06T09:59:00.000Z', disposition: 'pending', ...over,
  }
}

describe('运行时机制', () => {
  let store: Store
  let engine: Engine
  let backend: FakeBackend
  let config: AppConfig
  let service: RouterService
  let now: number

  beforeEach(() => {
    now = Date.parse('2026-11-06T10:05:00.000Z')
    const home = mkdtempSync(join(tmpdir(), 'ra-rt-'))
    store = new Store(':memory:')
    config = { ...defaultConfig(), home }
    config.projects = [{ name: 'acme/web', repo: 'acme/web', branches: [], defaultBranch: 'main' }]
    config.policy = { acceptMode: 'auto', maxWorkers: 4, admission: { ...DEFAULT_ADMISSION } }
    config.feishu = { ...config.feishu, chats: [chatEntry('oc_dev')], allowed: ['ou_alice'] }
    let n = 0
    engine = new Engine({ store, policy: policyOf(config), clock: { now: () => new Date(now).toISOString() }, ids: { next: p => `${p}_${++n}` } })
    backend = new FakeBackend()
    service = new RouterService({
      config, store, engine, backend,
      llm: { complete: async () => ({ content: '{"decision":"accept","reason":"test","title":"测试工单","scope":"测试"}', toolCalls: [] }) },
      prTracker: new NullPrTracker(),
      clock: { now: () => new Date(now).toISOString() },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      agentLoopOptions: { batchWindowMs: 0 },
    })
  })

  async function launchOne(): Promise<{ ticketId: string; handle: string; assignmentId: string }> {
    engine.ingest(trigger())
    await service.runOnce()
    const ticket = store.listTickets()[0]!
    const assignment = store.latestAssignment(ticket.id)!
    return { ticketId: ticket.id, handle: assignment.handle, assignmentId: assignment.id }
  }

  it('有新输入时，把未 ack 的旧输入一并重投（去重靠 id）', async () => {
    const { ticketId, handle } = await launchOne()
    const first = engine.deliverInput(ticketId, { kind: 'followup', text: '第一件事' })
    await service.runOnce()
    expect(backend.delivered.map(d => d.text)).toEqual(['第一件事'])

    const second = engine.deliverInput(ticketId, { kind: 'followup', text: '第二件事' })
    await service.runOnce()
    const lastTwo = backend.delivered.slice(-2).map(d => d.text)
    expect(lastTwo).toEqual(['第一件事', '第二件事'])
    expect(handle).toBeTruthy()
    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
  })

  it('ack 过的输入不会重投', async () => {
    const { ticketId, assignmentId } = await launchOne()
    engine.deliverInput(ticketId, { kind: 'followup', text: '第一件事' })
    await service.runOnce()
    service.onWorkerState({
      ticketId, assignmentId, turn: 2, state: 'progress', summary: '收到', prNumber: 0, prUrl: '',
      ackedInputs: [store.listInputs(ticketId)[0]!.id], updatedAt: new Date(now).toISOString(),
    })
    engine.deliverInput(ticketId, { kind: 'followup', text: '第二件事' })
    await service.runOnce()
    expect(backend.delivered.slice(-1).map(d => d.text)).toEqual(['第二件事'])
  })

  it('终端长时间无输出时发 status? 唤醒，仍无响应则标记 stale 并通知', async () => {
    const { ticketId, handle, assignmentId } = await launchOne()
    service.onWorkerState({
      ticketId, assignmentId, turn: 1, state: 'progress', summary: '做到一半', prNumber: 0, prUrl: '',
      ackedInputs: [], updatedAt: new Date(now).toISOString(),
    })
    // 终端最后输出在 10 分钟前
    backend.handles.set(handle, { lastOutputAt: new Date(now - 10 * 60_000).toISOString() })

    await service.checkIdle(now)
    expect(backend.delivered.some(d => d.text.includes('status?'))).toBe(true)

    await service.checkIdle(now + 10 * 60_000)
    expect(store.getAttention(ticketId)?.question).toContain('无响应')
    const outbox = store.claimOutbox(new Date(now + 20 * 60_000).toISOString(), 10)
    expect(outbox.some(item => item.text.includes('无响应'))).toBe(true)
  })

  it('有新上报后 idle 计时应重置', async () => {
    const { ticketId, handle, assignmentId } = await launchOne()
    service.onWorkerState({
      ticketId, assignmentId, turn: 1, state: 'progress', summary: '做到一半', prNumber: 0, prUrl: '',
      ackedInputs: [], updatedAt: new Date(now).toISOString(),
    })
    backend.handles.set(handle, { lastOutputAt: new Date(now - 10 * 60_000).toISOString() })
    await service.checkIdle(now)
    const before = backend.delivered.length

    service.onWorkerState({
      ticketId, assignmentId, turn: 2, state: 'progress', summary: '又动了', prNumber: 0, prUrl: '',
      ackedInputs: [], updatedAt: new Date(now + 1000).toISOString(),
    })
    await service.checkIdle(now + 2000)
    expect(backend.delivered.length).toBe(before)
  })

  it('PR 优先取 Orca worktree 的 linkedPR，拿不到才回退 gh', async () => {
    const { ticketId } = await launchOne()
    backend.linkedPr = { linkedPR: { number: 42, url: 'https://github.com/acme/web/pull/42' } }
    await service.trackPullRequests()
    expect(store.getTicket(ticketId)?.prNumber).toBe(42)
    expect(store.getTicket(ticketId)?.prState).toBe('open')
  })

  it('重启对账：orphaned 但仍 connected 的终端按存活复用', async () => {
    const { ticketId } = await launchOne()
    const assignment = store.latestAssignment(ticketId)!
    // 模拟实测行为：CLI 创建的终端 orphaned=true，但连接正常
    const original = backend.inspect.bind(backend)
    backend.inspect = async handle => {
      const info = await original(handle)
      return info ? { ...info, orphaned: true } : null
    }
    await service.recover()
    expect(backend.starts).toHaveLength(1)
    expect(store.latestAssignment(ticketId)!.id).toBe(assignment.id)
  })

  it('worktree 已被删除时 PR 跟踪静默跳过，不抛错也不刷日志', async () => {
    const { ticketId } = await launchOne()
    backend.inspectWorktree = async () => { throw new Error('orca:command-failed(worktree show): selector_not_found') }
    await expect(service.trackPullRequests()).resolves.toBeUndefined()
    expect(store.getTicket(ticketId)?.prNumber).toBe(0)
  })

  it('启动时执行历史补拉，补回来的消息进入领域', async () => {
    service = new RouterService({
      config, store, engine, backend,
      llm: { complete: async () => ({ content: '{"decision":"accept","reason":"test","title":"测试工单","scope":"测试"}', toolCalls: [] }) },
      prTracker: new NullPrTracker(),
      clock: { now: () => new Date(now).toISOString() },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      backfill: async () => [{
        id: 'feishu_om_backfill', source: 'feishu', externalId: 'om_backfill',
        threadId: 'feishu:oc_dev:om_backfill', chatId: 'oc_dev', chatName: '',
        actorId: 'ou_alice', actorName: 'Alice', isBot: false, text: '历史消息：改一下超时',
        addressed: 'none', receivedAt: new Date(now - 60_000).toISOString(), disposition: 'pending',
      }],
    } as never)
    await service.start()
    service.stop()
    expect(store.listTriggers().map(t => t.externalId)).toContain('om_backfill')
  })
})
