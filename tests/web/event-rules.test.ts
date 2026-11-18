import { describe, expect, it } from 'vitest'
import {
  blankRule,
  eventTypeOptions,
  nextRuleId,
  removeRule,
  ruleSummary,
  saveRuleDraft,
  upsertRule,
} from '../../src/web/client/event-rules-model.js'

describe('事件规则面板纯函数', () => {
  it('新建规则带固定四问骨架', () => {
    const rule = blankRule('rule-ci', 'github.workflow_run.failure')
    expect(rule.questions.is_valid.type).toBe('noul')
    expect(rule.questions.autorun.type).toBe('choice')
    expect(rule.questions.priority.type).toBe('score')
    expect(rule.questions.project.type).toBe('choice')
    expect(ruleSummary(rule)).toContain('优先级 4 档')
  })

  it('增删规则按 id 去重', () => {
    const first = blankRule('rule-a', 'github.issues.opened')
    const second = blankRule('rule-b', 'github.pull_request.opened')
    const list = upsertRule([first], second)
    expect(list.map(rule => rule.id)).toEqual(['rule-a', 'rule-b'])
    expect(removeRule(list, 'rule-a').map(rule => rule.id)).toEqual(['rule-b'])
  })

  it('id 由事件类型生成且可读', () => {
    expect(nextRuleId('github.workflow_run.failure')).toBe('rule-github-workflow-run-failure')
  })

  it('事件类型选项包含带前缀的 GitHub 目录与自定义来源', () => {
    const groups = eventTypeOptions({
      events: {
        sources: {
          feishu: { enabled: true, kind: 'feishu', events: ['message.received'] },
        },
      },
    })
    const github = groups.filter(group => group.group.startsWith('GitHub')).flatMap(group => group.options)
    expect(github.some(option => option.value === 'github.workflow_run.failure')).toBe(true)
    const feishu = groups.flatMap(group => group.options)
    expect(feishu.some(option => option.value === 'feishu.message.received')).toBe(true)
  })

  it('保存前拦截缺少来源前缀的事件类型', () => {
    const rule = blankRule('rule-bad', 'workflow_run.failure')
    expect(saveRuleDraft(rule).error).toContain('来源前缀')
  })
})
