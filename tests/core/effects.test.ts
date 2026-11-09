import { beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import { EffectsProcessor } from '../../src/core/effects.js'

class FakeSender {
  sent: string[] = []
  failTimes = 0
  async send(item: { text: string; key: string }): Promise<void> {
    if (this.failTimes > 0) {
      this.failTimes -= 1
      throw new Error('network down')
    }
    this.sent.push(item.text)
  }
}

describe('Effects / Outbox 处理器', () => {
  let store: Store
  let sender: FakeSender

  beforeEach(() => {
    store = new Store(':memory:')
    sender = new FakeSender()
  })

  it('发送失败事件带上渠道与重试次数，便于排查投递问题', async () => {
    sender.failTimes = 1
    const events: { event: string; [key: string]: unknown }[] = []
    store.enqueueOutbox({ id: 'o1', key: 'k1', channelKind: 'feishu', channelId: 'c', threadId: 'r', text: 'hi', now: '2026-11-06T10:00:00.000Z' })
    const processor = new EffectsProcessor({ store, sender, clock: { now: () => '2026-11-06T10:00:01.000Z' }, onEvent: event => events.push(event) })
    await processor.tick()
    expect(events.find(event => event.event === 'outbox:failed')).toMatchObject({ key: 'k1', channel: 'feishu:c', error: 'network down' })
  })

  it('effect 执行失败与缺少处理器都会发出 effect:failed', async () => {
    const events: { event: string; [key: string]: unknown }[] = []
    store.enqueueEffect({ id: 'e1', key: 'launch:tk1', kind: 'flaky', payload: {}, now: '2026-11-06T10:00:00.000Z' })
    store.enqueueEffect({ id: 'e2', key: 'x:1', kind: 'unknown-kind', payload: {}, now: '2026-11-06T10:00:00.000Z' })
    const processor = new EffectsProcessor({
      store,
      sender,
      clock: { now: () => '2026-11-06T10:00:01.000Z' },
      onEvent: event => events.push(event),
      handlers: { flaky: async () => { throw new Error('boom') } },
    })
    await processor.tick()

    const failed = events.filter(event => event.event === 'effect:failed')
    expect(failed).toHaveLength(2)
    expect(failed.find(event => event.kind === 'flaky')).toMatchObject({ key: 'launch:tk1', error: 'boom' })
    expect(failed.find(event => event.kind === 'unknown-kind')).toMatchObject({ error: 'effect:no-handler:unknown-kind' })
  })

  it('发送成功/失败会发出可追踪事件', async () => {
    const events: { event: string; [key: string]: unknown }[] = []
    store.enqueueOutbox({ id: 'o1', key: 'k1', channelKind: 'feishu', channelId: 'c', threadId: 'r', text: '已开工', now: '2026-11-06T10:00:00.000Z' })
    const processor = new EffectsProcessor({ store, sender, clock: { now: () => '2026-11-06T10:00:01.000Z' }, onEvent: event => events.push(event) })
    await processor.tick()
    expect(events.find(event => event.event === 'outbox:sent')).toMatchObject({ key: 'k1', text: '已开工' })
  })

  it('领取到期的 Outbox 并发送，成功后不再出现', async () => {
    store.enqueueOutbox({ id: 'o1', key: 'k1', channelKind: 'feishu', channelId: 'oc_chat', threadId: 'om_root', text: '收到，开始处理', now: '2026-11-06T10:00:00.000Z' })
    const processor = new EffectsProcessor({ store, sender, clock: { now: () => '2026-11-06T10:00:01.000Z' } })
    const result = await processor.tick()
    expect(result.sent).toBe(1)
    expect(sender.sent).toEqual(['收到，开始处理'])
    expect(store.claimOutbox('2026-11-06T10:10:00.000Z', 10)).toHaveLength(0)
  })

  it('发送失败时保留 pending 并安排退避重试', async () => {
    sender.failTimes = 1
    store.enqueueOutbox({ id: 'o1', key: 'k1', channelKind: 'feishu', channelId: 'c', threadId: 'r', text: 'hi', now: '2026-11-06T10:00:00.000Z' })
    const processor = new EffectsProcessor({ store, sender, clock: { now: () => '2026-11-06T10:00:01.000Z' } })
    expect((await processor.tick()).failed).toBe(1)
    expect(store.claimOutbox('2026-11-06T10:00:02.000Z', 10)).toHaveLength(0)

    const later = new EffectsProcessor({ store, sender, clock: { now: () => '2026-11-06T10:00:03.000Z' } })
    expect((await later.tick()).sent).toBe(1)
  })

  it('Effects 回调成功标记 done，重复 tick 不重复执行', async () => {
    const calls: unknown[] = []
    store.enqueueEffect({ id: 'e1', key: 'launch:tk1', kind: 'launch-worker', payload: { ticketId: 'tk1' }, now: '2026-11-06T10:00:00.000Z' })
    const processor = new EffectsProcessor({
      store,
      sender,
      clock: { now: () => '2026-11-06T10:00:01.000Z' },
      handlers: { 'launch-worker': async payload => { calls.push(payload) } },
    })
    expect((await processor.tick()).effects).toBe(1)
    expect((await processor.tick()).effects).toBe(0)
    expect(calls).toEqual([{ ticketId: 'tk1' }])
  })

  it('未知 effect kind 记为失败并退避，不阻塞其它任务', async () => {
    store.enqueueEffect({ id: 'e1', key: 'x:1', kind: 'unknown-kind', payload: {}, now: '2026-11-06T10:00:00.000Z' })
    store.enqueueOutbox({ id: 'o1', key: 'k1', channelKind: 'feishu', channelId: 'c', threadId: 'r', text: 'hi', now: '2026-11-06T10:00:00.000Z' })
    const processor = new EffectsProcessor({ store, sender, clock: { now: () => '2026-11-06T10:00:01.000Z' } })
    const result = await processor.tick()
    expect(result.effectsFailed).toBe(1)
    expect(result.sent).toBe(1)
  })

  it('effect 回调失败时按退避重试', async () => {
    let attempts = 0
    store.enqueueEffect({ id: 'e1', key: 'x:1', kind: 'flaky', payload: {}, now: '2026-11-06T10:00:00.000Z' })
    const first = new EffectsProcessor({
      store, sender, clock: { now: () => '2026-11-06T10:00:01.000Z' },
      handlers: { flaky: async () => { attempts += 1; throw new Error('boom') } },
    })
    expect((await first.tick()).effectsFailed).toBe(1)
    expect(attempts).toBe(1)
    const second = new EffectsProcessor({
      store, sender, clock: { now: () => '2026-11-06T10:00:03.000Z' },
      handlers: { flaky: async () => { attempts += 1 } },
    })
    expect((await second.tick()).effects).toBe(1)
    expect(attempts).toBe(2)
  })

  it('tick 内单条失败不影响同批其它条目', async () => {
    store.enqueueOutbox({ id: 'o1', key: 'k1', channelKind: 'feishu', channelId: 'c', threadId: 'r', text: 'first', now: '2026-11-06T10:00:00.000Z' })
    store.enqueueOutbox({ id: 'o2', key: 'k2', channelKind: 'feishu', channelId: 'c', threadId: 'r', text: 'second', now: '2026-11-06T10:00:00.000Z' })
    let n = 0
    const flaky = {
      async send(item: { text: string }) {
        n += 1
        if (n === 1) throw new Error('first fails')
        sender.sent.push(item.text)
      },
    }
    const processor = new EffectsProcessor({ store, sender: flaky, clock: { now: () => '2026-11-06T10:00:01.000Z' } })
    const result = await processor.tick()
    expect(result.sent).toBe(1)
    expect(result.failed).toBe(1)
  })
})
