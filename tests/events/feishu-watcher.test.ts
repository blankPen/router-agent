/**
 * 飞书长连接 watcher：进程管理、就绪识别、重连、优雅退出、预检。
 *
 * 覆盖 §12.8 的 V32、V36~V40：
 * 事件实时入库、预检不过不起进程、同一 EventKey 只起一个进程、
 * 停用最后一个订阅后进程退出、重启不报「订阅已存在」、stderr WARN 看得见。
 */
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { FeishuEventWatcher, larkStderrLevel, parseEventPrecheck } from '../../src/events/feishu-watcher.js'
import type { ResolvedSubscription } from '../../src/events/subscriptions.js'
import type { EventEnvelope } from '#event/port.js'

/** 一个假的 `lark-cli event consume` 子进程。 */
class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  killed = false
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true
    this.emit('exit', 0)
    return true
  }
}

function subscription(over: Partial<ResolvedSubscription> = {}): ResolvedSubscription {
  return {
    id: 'auto_1',
    taskName: '飞书消息订阅',
    source: 'feishu',
    types: ['feishu.message'],
    params: {},
    filter: { keywords: [], semantic: '' },
    mode: 'auto',
    project: 'router-agent',
    skill: 'bug-triage',
    prompt: '处理这条消息。',
    notifyTo: '',
    enabled: true,
    ...over,
  }
}

/** 记录日志事件，供断言。 */
function loggerOf(): { events: Array<{ level: string; event: string; fields: Record<string, unknown> }> } & {
  info: (event: string, fields?: Record<string, unknown>) => void
  warn: (event: string, fields?: Record<string, unknown>) => void
  error: (event: string, fields?: Record<string, unknown>) => void
} {
  const events: Array<{ level: string; event: string; fields: Record<string, unknown> }> = []
  const push = (level: string) => (event: string, fields: Record<string, unknown> = {}) => {
    events.push({ level, event, fields })
  }
  return { events, info: push('info'), warn: push('warn'), error: push('error') }
}

describe('飞书长连接 watcher', () => {
  it('收到一条消息事件就扇出给订阅它的任务（V32）', async () => {
    const child = new FakeChild()
    const watcher = new FeishuEventWatcher({
      logger: loggerOf(),
      spawnImpl: () => child as never,
    })
    const received: Array<{ subscriptionId: string; envelope: EventEnvelope }> = []
    await watcher.subscribe(subscription(), async (sub, envelope) => {
      received.push({ subscriptionId: sub.id, envelope })
    })
    child.stdout.write(`${JSON.stringify({
      message_id: 'om_1',
      chat_id: 'oc_dev',
      chat_type: 'group',
      content: '{"text":"退款什么时候到账"}',
      sender_id: { open_id: 'ou_alice' },
      sender_type: 'user',
      message_type: 'text',
      create_time: '1764000000000',
    })}\n`)
    await new Promise(resolve => setImmediate(resolve))
    expect(received).toHaveLength(1)
    expect(received[0]!.envelope.eventType).toBe('feishu.message')
    expect(received[0]!.envelope.externalId).toBe('om_1')
    watcher.stop()
  })

  it('预检不过就不起进程，并记 subscribe-blocked（V36）', async () => {
    const spawnImpl = vi.fn()
    const log = loggerOf()
    const watcher = new FeishuEventWatcher({
      logger: log,
      spawnImpl: spawnImpl as never,
      precheck: async () => ({ ready: false, reason: '未在开发者后台订阅该事件类型' }),
    })
    await watcher.subscribe(subscription({ types: ['feishu.chat.member.user.added'] }), async () => undefined)
    expect(spawnImpl).not.toHaveBeenCalled()
    expect(watcher.connectionCount()).toBe(0)
    expect(log.events.some(item => item.event === 'event:feishu-subscribe-blocked')).toBe(true)
  })

  it('三个任务订阅同一个 EventKey，只起一个进程，事件扇出给三个（V37）', async () => {
    const child = new FakeChild()
    const spawnImpl = vi.fn(() => child as never)
    const watcher = new FeishuEventWatcher({ logger: loggerOf(), spawnImpl: spawnImpl as never })
    const received: string[] = []
    const sink = async (sub: ResolvedSubscription): Promise<void> => { received.push(sub.id) }
    await watcher.subscribe(subscription({ id: 'a' }), sink)
    await watcher.subscribe(subscription({ id: 'b' }), sink)
    await watcher.subscribe(subscription({ id: 'c' }), sink)
    expect(spawnImpl).toHaveBeenCalledTimes(1)
    expect(watcher.connectionCount()).toBe(1)
    child.stdout.write(`${JSON.stringify({ message_id: 'om_1', chat_id: 'oc', content: 'x' })}\n`)
    await new Promise(resolve => setImmediate(resolve))
    expect(received.sort()).toEqual(['a', 'b', 'c'])
    watcher.stop()
  })

  it('停止时优雅退出：关 stdin 而不是强杀（V38）', async () => {
    const child = new FakeChild()
    const watcher = new FeishuEventWatcher({ logger: loggerOf(), spawnImpl: () => child as never })
    await watcher.subscribe(subscription(), async () => undefined)
    watcher.stop()
    expect(child.killed).toBe(false)
    expect(watcher.connectionCount()).toBe(0)
  })

  it('进程退出后按指数退避重连（V39）', async () => {
    vi.useFakeTimers()
    try {
      const children: FakeChild[] = []
      const watcher = new FeishuEventWatcher({
        logger: loggerOf(),
        spawnImpl: () => {
          const child = new FakeChild()
          children.push(child)
          return child as never
        },
      })
      await watcher.subscribe(subscription(), async () => undefined)
      expect(children).toHaveLength(1)
      children[0]!.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(children).toHaveLength(2)
      children[1]!.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(children).toHaveLength(3)
      watcher.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stderr 的 WARN 被采集，日志里看得见（V40）', async () => {
    const child = new FakeChild()
    const log = loggerOf()
    const watcher = new FeishuEventWatcher({ logger: log, spawnImpl: () => child as never })
    await watcher.subscribe(subscription(), async () => undefined)
    child.stderr.write('WARN jq projection failed: unexpected token\n')
    await new Promise(resolve => setImmediate(resolve))
    expect(log.events.some(item => item.event === 'event:feishu-consume-warn')).toBe(true)
    watcher.stop()
  })

  it('stdout 一行坏 JSON 只跳过那一行，连接不断', async () => {
    const child = new FakeChild()
    const log = loggerOf()
    const watcher = new FeishuEventWatcher({ logger: log, spawnImpl: () => child as never })
    const received: EventEnvelope[] = []
    await watcher.subscribe(subscription(), async (_sub, envelope) => { received.push(envelope) })
    child.stdout.write('not json\n')
    child.stdout.write(`${JSON.stringify({ message_id: 'om_2', chat_id: 'oc', content: 'y' })}\n`)
    await new Promise(resolve => setImmediate(resolve))
    expect(log.events.some(item => item.event === 'event:feishu-parse-failed')).toBe(true)
    expect(received.map(item => item.externalId)).toEqual(['om_2'])
    watcher.stop()
  })
})

describe('lark-cli 输出判定', () => {
  it('就绪标记与错误行分得开', () => {
    expect(larkStderrLevel('ready event_key=im.message.receive_v1')).toBe('ready')
    expect(larkStderrLevel('listening for events')).toBe('ready')
    expect(larkStderrLevel('ERROR permission denied')).toBe('error')
    expect(larkStderrLevel('{"ok":false,"error":"failed_precondition"}')).toBe('error')
    expect(larkStderrLevel('some routine line')).toBe('ignore')
  })

  it('预检输出解析出「未开通」与提示链接', () => {
    const stdout = JSON.stringify({
      data: {
        decision: {
          status: 'blocked',
          preconditions: [
            { name: 'event_subscription', status: 'failed', hint: 'https://open.feishu.cn/app/xxx/event' },
          ],
        },
      },
    })
    const result = parseEventPrecheck(stdout)
    expect(result.ready).toBe(false)
    expect(result.reason).toContain('event_subscription')
    expect(result.hint).toContain('open.feishu.cn')
  })

  it('预检通过时是 ready', () => {
    const stdout = JSON.stringify({ data: { decision: { status: 'ready', preconditions: [] } } })
    expect(parseEventPrecheck(stdout).ready).toBe(true)
  })

  it('预检输出坏掉时按「不通」处理，不放行', () => {
    expect(parseEventPrecheck('not json').ready).toBe(false)
  })
})
