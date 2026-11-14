import { describe, expect, it } from 'vitest'
import { NodeRegistry } from '../../src/node/registry.js'

function registry(now: () => string): NodeRegistry {
  return new NodeRegistry({
    devices: [
      { id: 'macbook-air', name: 'MacBook Air', token: 'secret-air' },
      { id: 'thinkpad', name: 'ThinkPad', token: 'secret-tp' },
    ],
    clock: now,
    offlineAfterMs: 60_000,
  })
}

const registration = {
  nodeId: 'macbook-air',
  name: 'MacBook Air',
  runtimes: ['claude-code'],
  projects: [{ name: 'router-agent', path: '/Users/pz/dev/router-agent' }],
}

describe('节点注册表', () => {
  it('未登记的设备不能通过鉴权', () => {
    const reg = registry(() => '2026-11-15T00:00:00.000Z')
    expect(reg.authenticate('macbook-air', 'secret-air')).toBe(true)
    expect(reg.authenticate('macbook-air', 'wrong')).toBe(false)
    expect(reg.authenticate('unknown-device', 'secret-air')).toBe(false)
  })

  it('心跳后节点在线，超过离线窗口后判为离线', () => {
    let now = '2026-11-15T00:00:00.000Z'
    const reg = registry(() => now)
    reg.touch(registration)
    expect(reg.status()[0]!.online).toBe(true)
    now = '2026-11-15T00:02:00.000Z'
    expect(reg.status()[0]!.online).toBe(false)
  })

  it('投递的消息只被目标节点取走', () => {
    const reg = registry(() => '2026-11-15T00:00:00.000Z')
    reg.enqueue('macbook-air', {
      kind: 'task',
      payload: {
        assignmentId: 'as_1',
        ticketId: 'tk-1',
        title: '标题',
        scope: '范围',
        project: 'router-agent',
        branch: 'main',
        workBranch: 'ra/tk-1',
      },
    })
    expect(reg.take('thinkpad')).toEqual([])
    expect(reg.take('macbook-air')).toHaveLength(1)
    expect(reg.take('macbook-air')).toEqual([])
  })

  it('状态视图汇总节点在线情况、项目与在执行工单', () => {
    const reg = registry(() => '2026-11-15T00:00:00.000Z')
    reg.touch(registration)
    reg.enqueue('macbook-air', {
      kind: 'task',
      payload: {
        assignmentId: 'as_1',
        ticketId: 'tk-1',
        title: '标题',
        scope: '范围',
        project: 'router-agent',
        branch: 'main',
        workBranch: 'ra/tk-1',
      },
    })
    const view = reg.status().find(node => node.nodeId === 'macbook-air')!
    expect(view.projects).toEqual(['router-agent'])
    expect(view.runtimes).toEqual(['claude-code'])
    expect(view.tickets).toEqual(['tk-1'])
  })
})
