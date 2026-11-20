import { describe, expect, it } from 'vitest'
import { applyConfigPatch, defaultConfig, HOT_CONFIG_PREFIXES, validateAutomationTask } from '../../src/config.js'

function task(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'auto_1',
    name: '依赖巡检',
    description: '',
    type: 'ai',
    prompt: '检查依赖更新',
    schedule: { kind: 'cron', cron: '0 9 * * 1' },
    runtimeId: '',
    project: 'demo',
    repo: '/tmp/demo',
    branch: 'main',
    enabled: true,
    createdBy: '',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  }
}

describe('自动化配置', () => {
  it('任务清单通过补丁写入，Web 保存能收集到', () => {
    const config = defaultConfig()
    const result = applyConfigPatch(config, { 'automation.tasks': [task()] })

    expect(result.errors).toEqual([])
    expect(config.automation.tasks).toHaveLength(1)
    expect(config.automation.tasks[0]!.schedule.kind).toBe('cron')
    expect(HOT_CONFIG_PREFIXES).toContain('automation.')
  })

  it('非法 Cron 被拒绝且不写入', () => {
    const config = defaultConfig()
    const result = applyConfigPatch(config, {
      'automation.tasks': [task({ schedule: { kind: 'cron', cron: '0 25 * * *' } })],
    })

    expect(result.errors[0]!.path).toBe('automation.tasks')
    expect(result.errors[0]!.message).toContain('触发计划不合法')
    expect(config.automation.tasks).toHaveLength(0)
  })

  it('重复 id 被拒绝', () => {
    const config = defaultConfig()
    const result = applyConfigPatch(config, {
      'automation.tasks': [task(), task({ name: '另一个' })],
    })

    expect(result.errors[0]!.message).toContain('重复')
  })

  it('脚本自动化可以持久化脚本正文', () => {
    const result = validateAutomationTask(task({ type: 'script', script: 'echo ok' }))
    expect(result.error).toBeNull()
    expect(result.value.script).toBe('echo ok')
  })

  it('缺少目标项目时拒绝保存', () => {
    const result = validateAutomationTask(task({ project: '', repo: '' }))
    expect(result.error).toContain('目标项目')
  })
})
