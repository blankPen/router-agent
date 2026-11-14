import { describe, expect, it } from 'vitest'
import { Value } from 'typebox/value'
import { DECISION_TOOL_NAMES, ROUTER_TOOL_AUTHZ, ROUTER_TOOL_SPECS, toolSpec } from '../../src/router/tool-spec.js'
import { allowedTools } from '#core/tool-scope.js'

describe('Pi 工具契约（TypeBox）', () => {
  it('暴露读、查、清理与决定四类工具', () => {
    const expected = [
      'router_context',
      'router_decide',
      'router_read',
      'router_ticket',
      'router_ticket_close',
      'router_ticket_list',
      'router_ticket_progress',
      'router_update',
      'router_workspace_remove',
    ]
    expect(ROUTER_TOOL_SPECS.map(spec => spec.name).sort()).toEqual(expected)
    expect([...DECISION_TOOL_NAMES].sort()).toEqual(expected)
    expect(DECISION_TOOL_NAMES).not.toContain('router_subscribe')
    expect(DECISION_TOOL_NAMES).not.toContain('router_reply')
    expect(DECISION_TOOL_NAMES).not.toContain('router_shell')
    expect(DECISION_TOOL_NAMES).not.toContain('router_bash')
  })

  it('每个工具的 parameters 都是合法的 JSON Schema object', () => {
    for (const spec of ROUTER_TOOL_SPECS) {
      expect((spec.parameters as { type?: string }).type).toBe('object')
      expect(spec.description.length).toBeGreaterThan(0)
    }
  })

  it('普通成员只有只读上下文工具，管理员拿全套', () => {
    expect(allowedTools('member-analysis-read', ROUTER_TOOL_AUTHZ)).toEqual(['router_context'])
    expect(allowedTools('admin-full', ROUTER_TOOL_AUTHZ)).toEqual(ROUTER_TOOL_SPECS.map(spec => spec.name))
  })

  it('工单查看、历史开单、回收 workspace 都只给管理员', () => {
    const adminOnly = ROUTER_TOOL_SPECS
      .filter(spec => spec.requires === 'admin')
      .map(spec => spec.name)
      .sort()
    expect(adminOnly).toEqual([
      'router_decide',
      'router_read',
      'router_ticket',
      'router_ticket_close',
      'router_ticket_list',
      'router_ticket_progress',
      'router_update',
      'router_workspace_remove',
    ])
    for (const name of adminOnly) {
      expect(allowedTools('member-analysis-read', ROUTER_TOOL_AUTHZ)).not.toContain(name)
    }
  })

  it('router_decide 的必填字段与枚举可用于校验', () => {
    const spec = toolSpec('router_decide')
    expect(Value.Check(spec.parameters, { trigger_id: 't1', decision: 'accept', reason: 'ok' })).toBe(true)
    expect(Value.Check(spec.parameters, { trigger_id: 't1', decision: 'accept' })).toBe(false)
    expect(Value.Check(spec.parameters, { trigger_id: 't1', decision: 'nope', reason: 'ok' })).toBe(false)
    expect(Value.Check(spec.parameters, { trigger_id: 't1', decision: 'accept', reason: 'ok', rules: ['r1'] })).toBe(true)
  })

  it('查询与清理工具的参数可用于校验', () => {
    const close = toolSpec('router_ticket_close')
    expect(Value.Check(close.parameters, { ticket_id: 'tk-5', reason: '用户要求关闭' })).toBe(true)
    expect(Value.Check(close.parameters, { ticket_id: 'tk-5' })).toBe(false)
    expect(Value.Check(close.parameters, { ticket_id: 'tk-5', reason: 'r', force: true, remove_workspace: false })).toBe(true)

    const list = toolSpec('router_ticket_list')
    expect(Value.Check(list.parameters, {})).toBe(true)
    expect(Value.Check(list.parameters, { stage: 'running', keyword: 'tk-', limit: 10 })).toBe(true)
    expect(Value.Check(list.parameters, { stage: 'nope' })).toBe(false)

    const progress = toolSpec('router_ticket_progress')
    expect(Value.Check(progress.parameters, { ticket_id: 'tk-5' })).toBe(true)
    expect(Value.Check(progress.parameters, {})).toBe(false)

    const update = toolSpec('router_update')
    expect(Value.Check(update.parameters, {})).toBe(true)
    expect(Value.Check(update.parameters, { check: true })).toBe(true)
    expect(Value.Check(update.parameters, { check: 'yes' })).toBe(false)
  })
})
