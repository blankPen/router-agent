/**
 * 决策规则 → 自动化任务的迁移。
 *
 * 迁移是「删规则」的前置：规则承载的信息要落到任务上，迁不了的必须显式列出来，
 * 不能悄悄丢（§3.1.2）。
 */
import { describe, expect, it } from 'vitest'
import { migrateRules, MIGRATION_CREATED_BY, taskIdOf, type LegacyEventRule } from '../../src/events/migrate-rules.js'

const PROJECTS = [
  { name: 'router-agent', repo: '/Users/me/router-agent', defaultBranch: 'main' },
  { name: 'customer-service', repo: '/Users/me/customer-service', defaultBranch: 'main' },
]

function rule(over: Partial<LegacyEventRule> = {}): LegacyEventRule {
  return {
    id: 'rule-ci',
    eventType: 'github.workflow_run.failure',
    intent: '所有 GitHub Action 失败都处理并自动执行。',
    workflowPrompt: '分析失败步骤，修复并提交 PR。',
    questions: {
      is_valid: { instructions: '该事件是否属于「github.workflow_run.failure」且需要处理？' },
      autorun: { criteria: { auto: '可以自动执行。', review: '需要人工 review。' } },
      priority: { criteria: ['低', '中', '高', '紧急'] },
      project: { criteria: { 'router-agent': '本项目', unknown: '认不出来' } },
      skill: { criteria: { 'ci-fix': 'CI 修复' } },
    },
    thresholds: { isValid: 0.5 },
    ...over,
  }
}

describe('决策规则迁移', () => {
  it('规则迁成事件触发的自动化任务', () => {
    const result = migrateRules({ rules: [rule()], projects: PROJECTS, now: '2026-11-26T00:00:00.000Z' })
    expect(result.manual).toEqual([])
    expect(result.tasks).toHaveLength(1)
    const task = result.tasks[0]!
    expect(task.id).toBe('auto_ci')
    expect(task.createdBy).toBe(MIGRATION_CREATED_BY)
    expect(task.description).toContain('GitHub Action 失败')
    expect(task.prompt).toBe('分析失败步骤，修复并提交 PR。')
    expect(task.project).toBe('router-agent')
    expect(task.repo).toBe('/Users/me/router-agent')
    expect(task.skill).toBe('ci-fix')
    expect(task.trigger).toMatchObject({
      kind: 'event',
      source: 'github',
      types: ['github.workflow_run.failure'],
      mode: 'auto',
    })
  })

  it('有效性说明去掉「用户意图」尾巴后作为语义过滤条件', () => {
    const result = migrateRules({
      rules: [rule({ questions: {
        is_valid: { instructions: '该事件是否需要处理？\n用户意图：修 CI' },
        project: { criteria: { 'router-agent': '本项目' } },
      } })],
      projects: PROJECTS,
      now: '2026-11-26T00:00:00.000Z',
    })
    expect(result.tasks[0]!.trigger).toMatchObject({
      filter: { semantic: '该事件是否需要处理？' },
    })
  })

  it('autorun 里有 auto 就迁成自动执行', () => {
    const result = migrateRules({
      rules: [rule({ questions: {
        autorun: { criteria: { auto: '可以' } },
        project: { criteria: { 'router-agent': '本项目' } },
      } })],
      projects: PROJECTS,
      now: '2026-11-26T00:00:00.000Z',
    })
    expect(result.tasks[0]!.trigger).toMatchObject({ mode: 'auto' })
  })

  it('autorun 只有 review 就迁成待人审', () => {
    const result = migrateRules({
      rules: [rule({ questions: {
        autorun: { criteria: { review: '需要人工' } },
        project: { criteria: { 'router-agent': '本项目' } },
      } })],
      projects: PROJECTS,
      now: '2026-11-26T00:00:00.000Z',
    })
    expect(result.tasks[0]!.trigger).toMatchObject({ mode: 'review' })
  })

  it('事件类型没有可识别的来源前缀时进人工清单，不硬造任务', () => {
    const result = migrateRules({
      rules: [rule({ eventType: 'workflow_run.failure' })],
      projects: PROJECTS,
      now: '2026-11-26T00:00:00.000Z',
    })
    expect(result.tasks).toEqual([])
    expect(result.manual[0]).toMatchObject({ id: 'rule-ci', reason: '事件类型没有可识别的来源前缀' })
  })

  it('兜底通配规则进人工清单', () => {
    const result = migrateRules({
      rules: [rule({ eventType: 'github.*' })],
      projects: PROJECTS,
      now: '2026-11-26T00:00:00.000Z',
    })
    expect(result.tasks).toEqual([])
    expect(result.manual[0]?.reason).toContain('兜底规则')
  })

  it('归属项目有多个候选时进人工清单', () => {
    const result = migrateRules({
      rules: [rule({ questions: { project: { criteria: { 'router-agent': 'a', 'customer-service': 'b' } } } })],
      projects: PROJECTS,
      now: '2026-11-26T00:00:00.000Z',
    })
    expect(result.tasks).toEqual([])
    expect(result.manual[0]?.reason).toContain('归属项目')
  })

  it('重复执行不会重复建任务', () => {
    const first = migrateRules({ rules: [rule()], projects: PROJECTS, now: '2026-11-26T00:00:00.000Z' })
    const second = migrateRules({
      rules: [rule()],
      projects: PROJECTS,
      existingTasks: first.tasks,
      now: '2026-11-26T00:00:00.000Z',
    })
    expect(second.tasks).toEqual([])
    expect(second.skipped).toEqual(['rule-ci'])
  })

  it('任务 id 去掉 rule- 前缀后加 auto_ 前缀', () => {
    expect(taskIdOf('rule-github-action-error')).toBe('auto_github-action-error')
    expect(taskIdOf('custom')).toBe('auto_custom')
  })

  it('GitHub 来源带上来源配置里的仓库', () => {
    const result = migrateRules({
      rules: [rule()],
      projects: PROJECTS,
      sources: { github: { repo: 'blankPen/router-agent' } },
      now: '2026-11-26T00:00:00.000Z',
    })
    expect(result.tasks[0]!.trigger).toMatchObject({ params: { repo: 'blankPen/router-agent' } })
  })
})

