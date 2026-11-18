import { describe, expect, it } from 'vitest'
import {
  blankRule,
  eventTypeOptions,
  nextRuleEventType,
  nextRuleId,
  preparedRule,
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

  it('添加第二条规则不会覆盖第一条', () => {
    const first = blankRule('rule-github-issues-opened', 'github.issues.opened')
    const second = blankRule('rule-github-issues-opened', 'github.workflow_run.failure')
    const list = upsertRule([first], preparedRule([first], second, true).value)
    expect(list.map(rule => rule.id)).toEqual(['rule-github-issues-opened', 'rule-github-workflow-run-failure'])
    expect(list.map(rule => rule.eventType)).toEqual(['github.issues.opened', 'github.workflow_run.failure'])
  })

  it('新规则 id 与已有规则冲突时自动加序号', () => {
    const existing = blankRule('rule-github-workflow-run-failure', 'github.issues.opened')
    const next = preparedRule([existing], blankRule('rule-github-workflow-run-failure', 'github.workflow_run.failure'), true).value
    expect(next.id).toBe('rule-github-workflow-run-failure-2')
  })

  it('同一事件类型不能再加一条规则，且不替换已有规则', () => {
    const first = blankRule('rule-a', 'github.issues.opened')
    const result = preparedRule([first], blankRule('rule-b', 'github.issues.opened'), true)
    expect(result.error).toContain('只能有一条规则')
    expect(result.value.id).toBe('rule-b')
  })

  it('新建规则的默认事件类型避开已配置的类型', () => {
    const groups = [{
      group: 'GitHub',
      options: [
        { value: 'github.issues.opened', label: 'Issue 打开', group: 'GitHub' },
        { value: 'github.workflow_run.failure', label: 'Action 失败', group: 'GitHub' },
      ],
    }]
    const configured = [blankRule('rule-a', 'github.issues.opened')]
    expect(nextRuleEventType(groups, configured)).toBe('github.workflow_run.failure')
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
