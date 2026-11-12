import { describe, expect, it } from 'vitest'
import { scheduleIdentityRetry } from '../../src/cli/index.js'
import type { IdentityStatusView } from '#channel/sources/feishu-identity.js'
import type { Logger } from '#infra/logger.js'

/** 采集日志调用，便于断言事件名与字段。 */
function captureLogger() {
  const events: { level: string; message: string; extra?: Record<string, unknown> }[] = []
  const logger: Logger = {
    info: (message, extra) => { events.push({ level: 'info', message, ...(extra ? { extra } : {}) }) },
    warn: (message, extra) => { events.push({ level: 'warn', message, ...(extra ? { extra } : {}) }) },
    error: (message, extra) => { events.push({ level: 'error', message, ...(extra ? { extra } : {}) }) },
  }
  return { events, logger }
}

function status(over: { pending?: number; botResolved?: boolean } = {}): IdentityStatusView {
  return {
    entries: [],
    bot: { botOpenIds: [], botNames: [], resolved: over.botResolved ?? true, detail: '' },
    invalidCount: 0,
    pendingCount: over.pending ?? 0,
  }
}

/** 等一轮 setTimeout(0) 链跑完。 */
function wait(ms = 60): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('身份解析后台重试', () => {
  it('首次解析就有待重试项时启动，成功后重建策略并写 info 事件', async () => {
    const { events, logger } = captureLogger()
    let applied = 0
    let calls = 0
    scheduleIdentityRetry({
      initial: status({ pending: 2 }),
      logger,
      refresh: async () => {
        calls += 1
        return status({ pending: 0, botResolved: true })
      },
      apply: () => { applied += 1 },
      delays: [0],
    })

    await wait()

    expect(calls).toBe(1)
    expect(applied).toBe(1)
    const resolved = events.find(event => event.message === 'identity:retry-resolved')
    expect(resolved?.level).toBe('info')
    expect(resolved?.extra).toMatchObject({ round: 1, pending: 0 })
  })

  it('首次解析干净时不启动重试', async () => {
    const { events, logger } = captureLogger()
    let calls = 0
    scheduleIdentityRetry({
      initial: status({ pending: 0, botResolved: true }),
      logger,
      refresh: async () => {
        calls += 1
        return status()
      },
      apply: () => {},
      delays: [0],
    })

    await wait()

    expect(calls).toBe(0)
    expect(events).toHaveLength(0)
  })

  it('一直没解析出来时按次数重试，用完后写 exhausted 事件', async () => {
    const { events, logger } = captureLogger()
    let calls = 0
    scheduleIdentityRetry({
      initial: status({ pending: 1 }),
      logger,
      refresh: async () => {
        calls += 1
        return status({ pending: 1 })
      },
      apply: () => {},
      delays: [0, 0],
    })

    await wait(120)

    expect(calls).toBe(2)
    const deferred = events.filter(event => event.message === 'identity:retry-deferred')
    expect(deferred).toHaveLength(2)
    expect(events.find(event => event.message === 'identity:retry-exhausted')?.extra).toMatchObject({ attempts: 2 })
  })
})
