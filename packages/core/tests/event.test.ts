import { describe, expect, it } from 'vitest'
import {
  EVENT_TRIAGE_SPEC,
  budgetState,
  eventKey,
  eventRulesOf,
  eventSubjectValid,
  mergeTriage,
  tierOfPriority,
  windowAllows,
  type EventModelAnswers,
  type EventRuleContext,
} from '@router-agent/core/event.js'

const baseContext: EventRuleContext = {
  text: '导出功能偶发失败，帮忙看看',
  priorityHint: 70,
  hasProject: true,
  hasScope: true,
}

describe('事件规则层', () => {
  it('机器人消息不进流程', () => {
    const verdict = eventRulesOf({ ...baseContext, isBot: true })
    expect(verdict.outcome).toBe('drop')
    expect(verdict.reason).toBe('event:bot-ignored')
  })

  it('重复事件被幂等丢弃', () => {
    const verdict = eventRulesOf({ ...baseContext, duplicate: true })
    expect(verdict.outcome).toBe('drop')
    expect(verdict.reason).toBe('event:duplicate')
  })

  it('寒暄不进流程', () => {
    const verdict = eventRulesOf({ ...baseContext, text: '你好' })
    expect(verdict.outcome).toBe('drop')
    expect(verdict.reason).toBe('event:noise')
  })

  it('admins 群里普通成员的消息不进流程', () => {
    const verdict = eventRulesOf({ ...baseContext, chatScope: 'admins', isAdmin: false })
    expect(verdict.outcome).toBe('drop')
    expect(verdict.reason).toBe('event:scope-admins')
  })

  it('mention 群里普通成员未寻址时不进流程', () => {
    const verdict = eventRulesOf({ ...baseContext, chatScope: 'mention', isAdmin: false, addressed: false })
    expect(verdict.outcome).toBe('drop')
    expect(verdict.reason).toBe('event:scope-mention')
  })

  it('mention 群里普通成员寻址后进入判定', () => {
    const verdict = eventRulesOf({ ...baseContext, chatScope: 'mention', isAdmin: false, addressed: true })
    expect(verdict.outcome).toBe('triage')
  })

  it('管理员消息提高基线优先级', () => {
    const verdict = eventRulesOf({ ...baseContext, isAdmin: true })
    expect(verdict.outcome).toBe('triage')
    expect(verdict.priority).toBeGreaterThanOrEqual(90)
  })

  it('生产告警关键词把基线优先级拉到最高档', () => {
    const verdict = eventRulesOf({ ...baseContext, text: '线上支付回调大面积 5xx，需要立刻处理' })
    expect(verdict.priority).toBeGreaterThanOrEqual(95)
  })

  it('项目未绑定的事件标记为需要人介入', () => {
    const verdict = eventRulesOf({ ...baseContext, hasProject: false })
    expect(verdict.needsHuman).toBe(true)
    expect(verdict.reason).toBe('event:project-unbound')
  })

  it('授权范围不可落地时标记为需要人介入', () => {
    const verdict = eventRulesOf({ ...baseContext, hasScope: false })
    expect(verdict.needsHuman).toBe(true)
    expect(verdict.reason).toBe('event:scope-undecidable')
  })

  it('预算耗尽时延后而不是丢弃', () => {
    const verdict = eventRulesOf({ ...baseContext, budgetExceeded: true })
    expect(verdict.outcome).toBe('defer')
    expect(verdict.reason).toBe('event:budget-exceeded')
  })

  it('时间窗关闭时延后', () => {
    const verdict = eventRulesOf({ ...baseContext, windowClosed: true })
    expect(verdict.outcome).toBe('defer')
    expect(verdict.reason).toBe('event:window-closed')
  })
})

describe('规则与决策模型融合', () => {
  const model = (over: Partial<EventModelAnswers> = {}): EventModelAnswers => ({
    needsHandling: 0.9,
    eventType: 0.6,
    priority: 0.75,
    needsHuman: 0.1,
    projectRelated: 0.9,
    ...over,
  })

  it('需要处理且不需人介入时直派', () => {
    const merged = mergeTriage({ priority: 70, needsHuman: false, confidence: 1 }, model())
    expect(merged.tier).toBe('t0')
  })

  it('判定不需要处理时丢弃', () => {
    const merged = mergeTriage({ priority: 70, needsHuman: false, confidence: 1 }, model({ needsHandling: 0.2 }))
    expect(merged.tier).toBe('t3')
    expect(merged.reason).toBe('event:not-handled')
  })

  it('与项目无关时归档', () => {
    const merged = mergeTriage({ priority: 70, needsHuman: false, confidence: 1 }, model({ projectRelated: 0.2 }))
    expect(merged.tier).toBe('t2')
    expect(merged.reason).toBe('event:unrelated')
  })

  it('模型要求人介入时进审核队列', () => {
    const merged = mergeTriage({ priority: 70, needsHuman: false, confidence: 1 }, model({ needsHuman: 0.8 }))
    expect(merged.tier).toBe('t1')
    expect(merged.reason).toBe('event:needs-human')
  })

  it('置信度不足时进审核队列', () => {
    const merged = mergeTriage({ priority: 70, needsHuman: false, confidence: 0.3 }, model())
    expect(merged.tier).toBe('t1')
    expect(merged.reason).toBe('event:low-confidence')
  })

  it('规则要求人介入时即使模型说不用也进审核', () => {
    const merged = mergeTriage({ priority: 70, needsHuman: true, confidence: 1 }, model())
    expect(merged.tier).toBe('t1')
    expect(merged.reason).toBe('event:rule-needs-human')
  })

  it('优先级取规则与模型的较高者', () => {
    const merged = mergeTriage({ priority: 70, needsHuman: false, confidence: 1 }, model({ priority: 0.9 }))
    expect(merged.priority).toBe(90)
  })
})

describe('优先级分档', () => {
  it('高分进 t0', () => expect(tierOfPriority(90)).toBe('t0'))
  it('中分进 t1', () => expect(tierOfPriority(70)).toBe('t1'))
  it('低分进 t2', () => expect(tierOfPriority(40)).toBe('t2'))
  it('极低分进 t3', () => expect(tierOfPriority(10)).toBe('t3'))
})

describe('时间窗', () => {
  const windows = [
    { id: 'night', from: '00:00', to: '06:00', allow: ['t0', 't1', 't2', 't3'] as const },
    { id: 'peak', from: '09:00', to: '20:00', allow: ['t0', 't1'] as const },
  ]

  it('窗口为空时一直放行', () => {
    expect(windowAllows([], 't3', '12:00').allowed).toBe(true)
  })

  it('窗口允许该优先级时放行', () => {
    expect(windowAllows(windows, 't0', '10:00').allowed).toBe(true)
  })

  it('窗口不允许该优先级时不放行并给出下次开始时间', () => {
    const result = windowAllows(windows, 't3', '10:00')
    expect(result.allowed).toBe(false)
    expect(result.nextStart).toBe('00:00')
  })

  it('跨零点的窗口按时间判断', () => {
    const night = [{ id: 'n', from: '22:00', to: '06:00', allow: ['t0'] as const }]
    expect(windowAllows(night, 't0', '23:30').allowed).toBe(true)
    expect(windowAllows(night, 't0', '12:00').allowed).toBe(false)
  })
})

describe('预算', () => {
  it('未配置预算时不限制', () => {
    expect(budgetState({}, { tokens: 10, events: 10 }).exceeded).toBe(false)
  })

  it('预算为 0 表示不限制', () => {
    expect(budgetState({ dailyTokens: 0, dailyEvents: 0 }, { tokens: 999, events: 999 }).exceeded).toBe(false)
  })

  it('token 超额时判定为耗尽', () => {
    const state = budgetState({ dailyTokens: 100 }, { tokens: 101, events: 0 })
    expect(state.exceeded).toBe(true)
    expect(state.reason).toBe('tokens')
  })

  it('事件数超额时判定为耗尽', () => {
    const state = budgetState({ dailyEvents: 1 }, { tokens: 0, events: 2 })
    expect(state.exceeded).toBe(true)
    expect(state.reason).toBe('events')
  })
})

describe('事件契约杂项', () => {
  it('subject 只允许标识符字符', () => {
    expect(eventSubjectValid('blankPen/router-agent#12')).toBe(true)
    expect(eventSubjectValid('含中文')).toBe(false)
    expect(eventSubjectValid('has space')).toBe(false)
  })

  it('幂等键由来源与外部 ID 组成', () => {
    expect(eventKey('github-issue', 'a/b#1@2026')).toBe('github-issue:a/b#1@2026')
  })

  it('判定 spec 带版本号且问题固定', () => {
    expect(EVENT_TRIAGE_SPEC.specId).toBe('event.triage.v1')
    expect(EVENT_TRIAGE_SPEC.specVersion).toBe(1)
    expect(Object.keys(EVENT_TRIAGE_SPEC.questions).sort()).toEqual([
      'eventType',
      'needsHandling',
      'needsHuman',
      'priority',
      'projectRelated',
    ])
  })
})
