import { describe, expect, it } from 'vitest'
import { withContext, withFieldContext, type Logger } from '../../packages/infra/src/logger.js'

function recorder(): { logger: Logger; lines: { message: string; extra?: Record<string, unknown> }[] } {
  const lines: { message: string; extra?: Record<string, unknown> }[] = []
  const logger: Logger = {
    info: (message, extra) => lines.push({ message, ...(extra ? { extra } : {}) }),
    warn: (message, extra) => lines.push({ message, ...(extra ? { extra } : {}) }),
    error: (message, extra) => lines.push({ message, ...(extra ? { extra } : {}) }),
  }
  return { logger, lines }
}

describe('日志上下文', () => {
  it('固定上下文会补到每条日志上', () => {
    const { logger, lines } = recorder()
    const scoped = withContext(logger, { runtime: 'orca' })
    scoped.info('launch', { handle: 'h1' })
    scoped.warn('codex:busy', {})

    expect(lines.map(line => line.extra)).toEqual([
      { runtime: 'orca', handle: 'h1' },
      { runtime: 'orca' },
    ])
  })

  it('调用点自己传的字段优先于固定上下文', () => {
    const { logger, lines } = recorder()
    withContext(logger, { runtime: 'orca' }).info('launch', { runtime: 'codex-app' })

    expect(lines[0]?.extra).toEqual({ runtime: 'codex-app' })
  })

  it('按字段补上下文：带工单号的日志自动带出群与发起人', () => {
    const { logger, lines } = recorder()
    const scoped = withFieldContext(logger, 'ticketId', ticketId => ({ chat: 'oc_1', actor: ticketId }))

    scoped.info('launch', { ticketId: 'tk-1', handle: 'h1' })
    scoped.info('api:listening', { port: 8787 })

    expect(lines[0]?.extra).toEqual({ chat: 'oc_1', actor: 'tk-1', ticketId: 'tk-1', handle: 'h1' })
    // 不带工单号的日志不受影响。
    expect(lines[1]?.extra).toEqual({ port: 8787 })
  })
})
