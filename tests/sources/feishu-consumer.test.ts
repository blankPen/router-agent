import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { FeishuConsumer, larkStderrLevel } from '#channel/sources/feishu.js'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  kill = vi.fn()
}

function setup() {
  const child = new FakeChild()
  const calls: { bin: string; args: string[]; opts: { stdio: string[]; env?: NodeJS.ProcessEnv } }[] = []
  const events: Record<string, unknown>[] = []
  const ready = vi.fn()
  const errors: string[] = []
  const reconnects: { attempt: number; delayMs: number }[] = []
  const consumer = new FeishuConsumer({
    onEvent: raw => events.push(raw),
    onReady: ready,
    onError: error => errors.push(error.message),
    onReconnect: info => reconnects.push(info),
    spawnImpl: (bin, args, opts) => {
      calls.push({ bin, args, opts })
      return child as unknown as ChildProcess
    },
  })
  return { consumer, child, calls, events, ready, errors, reconnects }
}

describe('飞书事件消费者', () => {
  it('用保持打开的 stdin 启动 lark-cli（stdin EOF 会被当作退出信号）', () => {
    const { consumer, calls } = setup()
    consumer.start()
    expect(calls[0]?.args).toEqual(['event', 'consume', 'im.message.receive_v1', '--as', 'bot'])
    expect(calls[0]?.opts.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(consumer.running).toBe(true)
  })

  it('stdout 的 NDJSON 被解析成事件', () => {
    const { consumer, child, events } = setup()
    consumer.start()
    child.stdout.write('{"message_id":"om_1"}\n{"message_id":"om_2"}\n')
    expect(events.map(event => event.message_id)).toEqual(['om_1', 'om_2'])
  })

  it('stderr 的例行信息不算错误，就绪信号回调 onReady', () => {
    const { consumer, child, ready, errors } = setup()
    consumer.start()
    child.stderr.write('[event] listening for events (key=im.message.receive_v1); send SIGTERM or close stdin to stop\n')
    child.stderr.write('[event] ready event_key=im.message.receive_v1\n')
    expect(ready).toHaveBeenCalled()
    expect(errors).toHaveLength(0)
  })

  it('真正的错误行才回调 onError', () => {
    const { consumer, child, errors } = setup()
    consumer.start()
    child.stderr.write('[event] error: unauthorized scope missing\n')
    expect(errors[0]).toContain('unauthorized')
  })

  it('坏 JSON 行通过 onError 报出，不打断后续事件', () => {
    const { consumer, child, events, errors } = setup()
    consumer.start()
    child.stdout.write('not-json\n{"message_id":"om_3"}\n')
    expect(errors[0]).toContain('invalid-json')
    expect(events[0]?.message_id).toBe('om_3')
  })

  it('stop 时优雅关闭，不把退出当错误', () => {
    const { consumer, child, errors } = setup()
    consumer.start()
    consumer.stop()
    expect(child.stdin.end).toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('exit', 0)
    expect(errors).toHaveLength(0)
    expect(consumer.running).toBe(false)
  })

  it('异常退出后按退避自动重连，stop 之后不再重连', () => {
    vi.useFakeTimers()
    try {
      const { consumer, child, calls, errors } = setup()
      consumer.start()
      child.emit('exit', 2)
      expect(errors.some(message => message.includes('consumer-exit'))).toBe(true)
      expect(calls).toHaveLength(1)
      vi.advanceTimersByTime(5000)
      expect(calls).toHaveLength(2)
      consumer.stop()
      vi.advanceTimersByTime(120_000)
      expect(calls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('事件总线冲突的错误原文可被上层识别', () => {
    const { consumer, child, errors } = setup()
    consumer.start()
    child.stderr.write('another event bus is already connected to this app\n')
    expect(errors[0]).toContain('another event bus')
  })

  it('stderr 分级规则', () => {
    expect(larkStderrLevel('[event] ready event_key=x')).toBe('ready')
    expect(larkStderrLevel('[event] listening for events (key=x)')).toBe('ready')
    expect(larkStderrLevel('[event] error: unauthorized')).toBe('error')
    expect(larkStderrLevel('[event] to stop gracefully: send SIGTERM')).toBe('ignore')
  })
})
describe('飞书事件消费者日志', () => {
  it('异常退出后回调 onReconnect，给出第几次与退避时间', () => {
    vi.useFakeTimers()
    try {
      const { consumer, child, reconnects } = setup()
      consumer.start()
      child.emit('exit', 1)
      expect(reconnects[0]).toEqual({ attempt: 1, delayMs: 5000 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('lark-cli 无法拉起时记 spawn-failed 并安排重连，不让进程直接崩', () => {
    vi.useFakeTimers()
    try {
      const { consumer, child, errors, reconnects } = setup()
      consumer.start()
      child.emit('error', new Error('spawn lark-cli ENOENT'))
      expect(errors[0]).toContain('feishu:spawn-failed')
      expect(reconnects).toHaveLength(1)
      expect(consumer.running).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
