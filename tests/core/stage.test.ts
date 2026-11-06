import { describe, expect, it } from 'vitest'
import { canTransition, computeStage, type StageInput } from '../../src/core/stage.js'
import type { Assignment, Report, Ticket } from '../../src/core/model.js'

const ticket: Ticket = {
  id: 'tk1',
  title: '修复登录超时',
  threadId: 'feishu:chat:root',
  source: 'feishu',
  chatId: 'chat',
  mandateId: 'md1',
  stage: 'accepted',
  repo: 'dsh/router-agent',
  branch: 'main',
  prNumber: 0,
  prUrl: '',
  prState: 'none',
  createdAt: '2026-11-06T10:00:00.000Z',
  updatedAt: '2026-11-06T10:00:00.000Z',
}

function runningAssignment(over: Partial<Assignment> = {}): Assignment {
  return {
    id: 'as1',
    ticketId: 'tk1',
    backendId: 'orca',
    handle: 'term-1',
    workdir: '/tmp/wt',
    status: 'running',
    startedAt: '2026-11-06T10:01:00.000Z',
    ...over,
  }
}

function report(state: Report['state'], over: Partial<Report> = {}): Report {
  return {
    id: 'rp1',
    ticketId: 'tk1',
    assignmentId: 'as1',
    turn: 1,
    state,
    summary: '进度',
    ackedInputs: [],
    at: '2026-11-06T10:02:00.000Z',
    ...over,
  }
}

function stage(input: Partial<StageInput>): string {
  return computeStage({ ticket, ...input })
}

describe('工单阶段状态机', () => {
  it('已关闭的工单始终是 closed', () => {
    expect(stage({ ticket: { ...ticket, closedAt: '2026-11-06T12:00:00.000Z' }, assignment: runningAssignment(), latestReport: report('ready') })).toBe('closed')
  })

  it('没有派工时停在 accepted', () => {
    expect(stage({})).toBe('accepted')
  })

  it('派工处于 pending 时是 assigned', () => {
    expect(stage({ assignment: runningAssignment({ status: 'pending' }) })).toBe('assigned')
  })

  it('派工运行中且无报告时是 running', () => {
    expect(stage({ assignment: runningAssignment() })).toBe('running')
  })

  it('最新报告 ready 时进入 review', () => {
    expect(stage({ assignment: runningAssignment(), latestReport: report('ready', { prNumber: 12, prUrl: 'https://github.com/o/r/pull/12' }) })).toBe('review')
  })

  it('最新报告 blocked 或 failed 时进入 person', () => {
    expect(stage({ assignment: runningAssignment(), latestReport: report('blocked', { humanAction: '需要提供测试账号' }) })).toBe('person')
    expect(stage({ assignment: runningAssignment(), latestReport: report('failed') })).toBe('person')
  })

  it('等待人工回答的 Attention 优先于其它状态', () => {
    expect(stage({ assignment: runningAssignment(), hasAttention: true })).toBe('person')
    expect(stage({ assignment: runningAssignment(), latestReport: report('ready'), hasAttention: true })).toBe('person')
  })

  it('最新报告 waiting 或 dropped 时是 idle', () => {
    expect(stage({ assignment: runningAssignment(), latestReport: report('waiting') })).toBe('idle')
    expect(stage({ assignment: runningAssignment(), latestReport: report('dropped') })).toBe('idle')
  })

  it('派工已结束时是 idle', () => {
    expect(stage({ assignment: runningAssignment({ status: 'ended' }) })).toBe('idle')
  })

  it('progress 报告保持 running', () => {
    expect(stage({ assignment: runningAssignment(), latestReport: report('progress') })).toBe('running')
  })
})

describe('阶段迁移合法性', () => {
  it('允许主链路 draft → accepted → assigned → running → review → closed', () => {
    const chain = ['draft', 'accepted', 'assigned', 'running', 'review', 'closed'] as const
    for (let i = 0; i < chain.length - 1; i += 1) {
      expect(canTransition(chain[i]!, chain[i + 1]!)).toBe(true)
    }
  })

  it('允许在 person / idle 之间来回', () => {
    expect(canTransition('running', 'person')).toBe(true)
    expect(canTransition('person', 'running')).toBe(true)
    expect(canTransition('running', 'idle')).toBe(true)
    expect(canTransition('idle', 'running')).toBe(true)
    expect(canTransition('person', 'idle')).toBe(true)
    expect(canTransition('idle', 'person')).toBe(true)
  })

  it('禁止从 closed 回到任何状态', () => {
    expect(canTransition('closed', 'running')).toBe(false)
    expect(canTransition('closed', 'accepted')).toBe(false)
  })

  it('禁止跳过 accepted 直接 assigned', () => {
    expect(canTransition('draft', 'running')).toBe(false)
    expect(canTransition('accepted', 'review')).toBe(false)
  })

  it('允许原地不动', () => {
    expect(canTransition('running', 'running')).toBe(true)
  })
})
