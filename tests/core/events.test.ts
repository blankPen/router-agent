import { describe, expect, it } from 'vitest'
import { logDimensions } from '../../packages/core/src/events.js'

describe('日志结构维度', () => {
  it('从事件名切出域与动作', () => {
    expect(logDimensions('trigger:ingested')).toEqual({ domain: 'trigger', event: 'ingested' })
    expect(logDimensions('session:cleanup:failed')).toEqual({ domain: 'session', event: 'cleanup:failed' })
  })

  it('没有冒号的事件名整体当作域', () => {
    expect(logDimensions('launch')).toEqual({ domain: 'launch', event: '' })
  })

  it('按工单、触发、输入的顺序取链路 ID', () => {
    expect(logDimensions('launch', { ticketId: 'tk-84', triggerId: 'trg-1' }).trace).toBe('tk-84')
    expect(logDimensions('intake:screen', { triggerId: 'trg-1', chat: 'oc_1' }).trace).toBe('trg-1')
    expect(logDimensions('input:queued', { ticketId: 'tk-84' }).trace).toBe('tk-84')
  })

  it('没有可定位字段时没有链路 ID', () => {
    expect(logDimensions('api:listening', { port: 8787 }).trace).toBeUndefined()
  })

  it('日志行里已有的结构字段优先于事件名推导', () => {
    expect(logDimensions('trigger:ingested', { domain: 'feishu', event: 'ingested', trace: 'tk-1' })).toEqual({
      domain: 'feishu',
      event: 'ingested',
      trace: 'tk-1',
    })
  })
})
