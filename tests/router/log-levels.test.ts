import { describe, expect, it } from 'vitest'
import { logLevelOf } from '../../src/router/log-levels.js'

describe('日志事件级别', () => {
  it('投递失败按 warn 记录，成功仍是 info', () => {
    expect(logLevelOf('outbox:failed')).toBe('warn')
    expect(logLevelOf('outbox:sent')).toBe('info')
  })

  it('会话丢失与失联标记按 warn 记录', () => {
    expect(logLevelOf('worker:lost')).toBe('warn')
    expect(logLevelOf('idle:stale')).toBe('warn')
  })
})
