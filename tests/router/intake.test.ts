import { describe, expect, it } from 'vitest'
import {
  formatIntakeReport,
  formatReviewMessage,
  isApprovalCommand,
  isDismissCommand,
  isRejectionCommand,
  parseAnalystOutcome,
  parseScreenerVerdict,
  ticketFromIntake,
} from '../../src/router/intake.js'
import type { Intake } from '../../src/core/model.js'

function intake(over: Partial<Intake> = {}): Intake {
  return {
    id: 'it_t1',
    threadId: 'feishu:oc_dev:om_1',
    chatId: 'oc_dev',
    actorId: 'ou_bob',
    actorName: 'Bob',
    project: 'router-agent',
    repo: 'name:dsh/router-agent',
    branch: 'main',
    status: 'ready',
    kind: 'issue',
    rawText: '登录一直报错',
    turns: [],
    report: {
      title: '登录报错',
      problem: '点击登录后提示 500',
      background: '每天早上第一次登录',
      steps: '1. 打开登录页 2. 输入账号密码 3. 点击登录',
      environment: 'Chrome 120 / macOS',
      impact: '全员无法登录',
      expected: '正常进入首页',
      assessment: '疑似 BUG，后端 500',
    },
    questions: 2,
    createdAt: '2026-11-12T10:00:00.000Z',
    updatedAt: '2026-11-12T10:05:00.000Z',
    ...over,
  }
}

describe('初筛结果解析', () => {
  it('解析合法 JSON，容忍代码块包裹', () => {
    const verdict = parseScreenerVerdict('```json\n{"kind":"issue","reason":"登录报错"}\n```')
    expect(verdict).toEqual({ kind: 'issue', reason: '登录报错' })
  })

  it('非法 kind 或缺失 JSON 返回 null', () => {
    expect(parseScreenerVerdict('{"kind":"nope"}')).toBeNull()
    expect(parseScreenerVerdict('这不是 JSON')).toBeNull()
  })
})

describe('分析结果解析', () => {
  it('解析追问回复', () => {
    expect(parseAnalystOutcome('{"action":"reply","reply":"请提供报错原文"}')).toEqual({
      action: 'reply',
      reply: '请提供报错原文',
    })
  })

  it('解析结构化需求单，缺失字段按空串兜底', () => {
    const outcome = parseAnalystOutcome(JSON.stringify({
      action: 'report',
      reply: '整理好了',
      report: { title: '登录报错', problem: '500' },
    }))
    expect(outcome).toMatchObject({
      action: 'report',
      report: { title: '登录报错', problem: '500', steps: '', environment: '' },
    })
  })

  it('缺少 title / problem 时不允许收口', () => {
    expect(parseAnalystOutcome('{"action":"report","report":{"title":"x"}}')).toBeNull()
    expect(parseAnalystOutcome('{"action":"reply"}')).toBeNull()
    expect(parseAnalystOutcome('{"action":"unknown"}')).toBeNull()
  })
})

describe('终审口令', () => {
  it('确认派单', () => {
    for (const text of ['确认派单', '确认', '通过', '同意', 'ok', 'approve']) {
      expect(isApprovalCommand(text)).toBe(true)
    }
    expect(isApprovalCommand('不用确认')).toBe(false)
    expect(isApprovalCommand('这段描述可以更详细一点')).toBe(false)
  })

  it('驳回', () => {
    for (const text of ['驳回', '拒绝', '不需要', 'reject']) {
      expect(isRejectionCommand(text)).toBe(true)
    }
    expect(isRejectionCommand('驳回之前先补充一下')).toBe(false)
  })

  it('发起人放弃', () => {
    expect(isDismissCommand('不用了')).toBe(true)
    expect(isDismissCommand('算了')).toBe(true)
    expect(isDismissCommand('还需要继续排查')).toBe(false)
  })
})

describe('需求单渲染', () => {
  it('结构化正文包含全部字段，缺失项标未收集到', () => {
    const report = { ...intake().report!, steps: '' }
    const text = formatIntakeReport(report)
    expect(text).toContain('**标题**：登录报错')
    expect(text).toContain('**复现步骤**：未收集到')
    expect(text).toContain('**影响范围**：全员无法登录')
  })

  it('终审消息 @管理员并给出操作口令', () => {
    const text = formatReviewMessage(intake(), ['ou_admin'])
    expect(text).toContain('<at id="ou_admin"></at>')
    expect(text).toContain('确认派单')
    expect(text).toContain('驳回')
    expect(text).toContain('it_t1')
  })

  it('工单标题与 scope 来自需求单，且去掉 Markdown 强调符', () => {
    const ticket = ticketFromIntake(intake())
    expect(ticket?.title).toBe('登录报错')
    expect(ticket?.scope).toContain('问题描述：点击登录后提示 500')
    expect(ticket?.scope).not.toContain('**')
    expect(ticketFromIntake(intake({ report: undefined }))).toBeNull()
  })
})
