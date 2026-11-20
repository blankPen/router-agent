import { describe, expect, it } from 'vitest'
import { compileEventRule } from '../../src/events/rule-compile.js'

describe('规则提炼', () => {
  it('没有模型时返回可直接编辑的内置模板', async () => {
    const rule = await compileEventRule({
      id: 'rule-ci',
      eventType: 'github.workflow_run.failure',
      intent: '修复 CI 并提交 PR',
    })
    expect(rule.questions.is_valid.type).toBe('noul')
    expect(rule.workflowPrompt).toBe('修复 CI 并提交 PR')
  })

  it('模型输出只补 instructions 与执行流程，不改变固定骨架', async () => {
    const rule = await compileEventRule({
      id: 'rule-ci',
      eventType: 'github.workflow_run.failure',
      intent: '所有 CI 失败都处理并自动执行',
    }, {
      client: {
        complete: async () => ({
          content: JSON.stringify({
            workflowPrompt: '先定位失败步骤，再修复并提交 PR',
            is_valid: '明确属于 Action 失败事件才有效',
            autorun: '安全范围内可以自动执行',
            auto: '只改本仓库代码',
            review: '涉及发布或生产时转人工',
            priority: '按影响范围评估',
          }),
          toolCalls: [],
        }),
      },
    })
    expect(rule.questions.is_valid.type).toBe('noul')
    expect(rule.questions.autorun.type).toBe('choice')
    expect(rule.workflowPrompt).toContain('定位失败步骤')
    expect(rule.questions.autorun.criteria).toMatchObject({ auto: '只改本仓库代码' })
  })
})
