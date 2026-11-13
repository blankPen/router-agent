import { describe, expect, it } from 'vitest'
import { logDimensions, messageContext } from '../../packages/core/src/events.js'

describe('日志结构维度', () => {
  it('从事件名切出域与动作', () => {
    expect(logDimensions('trigger:ingested')).toEqual({ domain: 'trigger', event: 'ingested', category: 'message' })
    expect(logDimensions('session:cleanup:failed')).toEqual({ domain: 'session', event: 'cleanup:failed', category: 'event' })
  })

  it('没有冒号的事件名整体当作域', () => {
    expect(logDimensions('launch')).toEqual({ domain: 'launch', event: '', category: 'action' })
  })

  it('按域推导类别：消息 / 动作 / 事件', () => {
    expect(logDimensions('trigger:ingested').category).toBe('message')
    expect(logDimensions('intake:screen').category).toBe('message')
    expect(logDimensions('input:delivered').category).toBe('action')
    expect(logDimensions('outbox:repaired').category).toBe('action')
    expect(logDimensions('report:ready').category).toBe('action')
    expect(logDimensions('worker:status-failed').category).toBe('event')
  })

  it('显式给的类别优先于域推导', () => {
    expect(logDimensions('trigger:ingested', { category: 'action' }).category).toBe('action')
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
      // 类别跟着域走：域被显式改成 feishu，就不再是消息类事件。
      category: 'event',
      trace: 'tk-1',
    })
  })
})

describe('日志上下文', () => {
  it('从消息推导群与发起人', () => {
    expect(messageContext({ chatId: 'oc_1', chatName: '研发群', actorId: 'ou_1', actorName: 'Alice', isBot: false })).toEqual({
      chat: 'oc_1',
      chatName: '研发群',
      actor: 'ou_1',
      actorName: 'Alice',
      actorType: 'user',
    })
  })

  it('机器人发的消息记为 bot', () => {
    expect(messageContext({ chatId: 'oc_1', actorId: 'ou_bot', actorName: 'Bot', isBot: true }).actorType).toBe('bot')
  })

  it('缺名字时只留 ID', () => {
    expect(messageContext({ chatId: 'oc_1', actorId: 'ou_1' })).toEqual({ chat: 'oc_1', actor: 'ou_1', actorType: 'user' })
  })
})
