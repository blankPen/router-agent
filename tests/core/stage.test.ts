import { describe, expect, it } from 'vitest'
import {
  canTransition,
  computeStage,
  LEGACY_STAGE_MAP,
  normalizeStage,
  stageAliases,
  STAGE_LABELS,
  STAGE_VALUES,
  type StageInput,
} from '../../src/core/stage.js'
import type { Assignment, Report, Ticket } from '../../src/core/model.js'

const ticket: Ticket = {
  id: 'tk1',
  title: '修复登录超时',
  threadId: 'feishu:chat:root',
  source: 'feishu',
  chatId: 'chat',
  mandateId: 'md1',
  stage: 'todo',
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
    runtimeId: 'orca',
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

describe('工单阶段只有五种', () => {
  it('阶段值固定为 todo / running / review / blocked / done', () => {
    expect(STAGE_VALUES).toEqual(['todo', 'running', 'review', 'blocked', 'done'])
    expect(Object.keys(STAGE_LABELS).sort()).toEqual([...STAGE_VALUES].sort())
  })
})

describe('工单阶段状态机', () => {
  it('已关闭的工单始终是 done', () => {
    expect(stage({ ticket: { ...ticket, closedAt: '2026-11-06T12:00:00.000Z' }, assignment: runningAssignment(), latestReport: report('ready') })).toBe('done')
  })

  it('没有派工时是 todo', () => {
    expect(stage({})).toBe('todo')
  })

  it('派工处于 pending 时也是 running（已派工即进行中）', () => {
    expect(stage({ assignment: runningAssignment({ status: 'pending' }) })).toBe('running')
  })

  it('派工运行中且无报告时是 running', () => {
    expect(stage({ assignment: runningAssignment() })).toBe('running')
  })

  it('最新报告 ready 时进入 review', () => {
    expect(stage({ assignment: runningAssignment(), latestReport: report('ready', { prNumber: 12, prUrl: 'https://github.com/o/r/pull/12' }) })).toBe('review')
  })

  it('最新报告 blocked 或 failed 时进入 blocked', () => {
    expect(stage({ assignment: runningAssignment(), latestReport: report('blocked', { humanAction: '需要提供测试账号' }) })).toBe('blocked')
    expect(stage({ assignment: runningAssignment(), latestReport: report('failed') })).toBe('blocked')
  })

  it('等待人工回答的 Attention 优先于其它状态', () => {
    expect(stage({ assignment: runningAssignment(), hasAttention: true })).toBe('blocked')
    expect(stage({ assignment: runningAssignment(), latestReport: report('ready'), hasAttention: true })).toBe('blocked')
  })

  it('最新报告 waiting 或 dropped 时进入 blocked', () => {
    expect(stage({ assignment: runningAssignment(), latestReport: report('waiting') })).toBe('blocked')
    expect(stage({ assignment: runningAssignment(), latestReport: report('dropped') })).toBe('blocked')
  })

  it('派工已结束时进入 blocked（需要人工推动）', () => {
    expect(stage({ assignment: runningAssignment({ status: 'ended' }) })).toBe('blocked')
  })

  it('progress 报告保持 running', () => {
    expect(stage({ assignment: runningAssignment(), latestReport: report('progress') })).toBe('running')
  })
})

describe('旧阶段读时兼容', () => {
  it('把旧八阶段映射到新五阶段', () => {
    expect(normalizeStage('draft')).toBe('todo')
    expect(normalizeStage('accepted')).toBe('todo')
    expect(normalizeStage('assigned')).toBe('running')
    expect(normalizeStage('running')).toBe('running')
    expect(normalizeStage('review')).toBe('review')
    expect(normalizeStage('person')).toBe('blocked')
    expect(normalizeStage('idle')).toBe('blocked')
    expect(normalizeStage('closed')).toBe('done')
  })

  it('新阶段原样返回，未知值返回 null', () => {
    for (const value of STAGE_VALUES) expect(normalizeStage(value)).toBe(value)
    expect(normalizeStage('nope')).toBeNull()
    expect(normalizeStage(null)).toBeNull()
  })

  it('按新阶段查询时带上旧别名', () => {
    expect(stageAliases('todo').sort()).toEqual(['accepted', 'draft', 'todo'])
    expect(stageAliases('running').sort()).toEqual(['assigned', 'running'])
    expect(stageAliases('blocked').sort()).toEqual(['blocked', 'idle', 'person'])
    expect(stageAliases('done').sort()).toEqual(['closed', 'done'])
    expect(stageAliases('review')).toEqual(['review'])
  })

  it('映射表覆盖全部旧阶段', () => {
    expect(Object.keys(LEGACY_STAGE_MAP).sort()).toEqual(['accepted', 'assigned', 'closed', 'draft', 'idle', 'person', 'review', 'running'])
  })
})

describe('阶段迁移合法性', () => {
  it('允许主链路 todo → running → review → done', () => {
    const chain = ['todo', 'running', 'review', 'done'] as const
    for (let i = 0; i < chain.length - 1; i += 1) {
      expect(canTransition(chain[i]!, chain[i + 1]!)).toBe(true)
    }
  })

  it('活跃阶段之间可以互转，blocked 可以从任意阶段进入', () => {
    expect(canTransition('running', 'blocked')).toBe(true)
    expect(canTransition('blocked', 'running')).toBe(true)
    expect(canTransition('blocked', 'review')).toBe(true)
    expect(canTransition('review', 'running')).toBe(true)
    expect(canTransition('running', 'todo')).toBe(true)
  })

  it('禁止从 done 回到任何状态', () => {
    expect(canTransition('done', 'running')).toBe(false)
    expect(canTransition('done', 'todo')).toBe(false)
    expect(canTransition('done', 'blocked')).toBe(false)
  })

  it('允许原地不动', () => {
    expect(canTransition('running', 'running')).toBe(true)
    expect(canTransition('done', 'done')).toBe(true)
  })
})
