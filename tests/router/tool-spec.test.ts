import { describe, expect, it } from 'vitest'
import { Value } from 'typebox/value'
import { DECISION_TOOL_NAMES, ROUTER_TOOL_SPECS, toolSpec } from '../../src/router/tool-spec.js'

describe('Pi 工具契约（TypeBox）', () => {
  it('只暴露三个工具：read / ticket / decide', () => {
    expect(ROUTER_TOOL_SPECS.map(spec => spec.name).sort()).toEqual(['router_decide', 'router_read', 'router_ticket'])
    expect([...DECISION_TOOL_NAMES].sort()).toEqual(['router_decide', 'router_read', 'router_ticket'])
    expect(DECISION_TOOL_NAMES).not.toContain('router_subscribe')
    expect(DECISION_TOOL_NAMES).not.toContain('router_reply')
  })

  it('每个工具的 parameters 都是合法的 JSON Schema object', () => {
    for (const spec of ROUTER_TOOL_SPECS) {
      expect((spec.parameters as { type?: string }).type).toBe('object')
      expect(spec.description.length).toBeGreaterThan(0)
    }
  })

  it('router_decide 的必填字段与枚举可用于校验', () => {
    const spec = toolSpec('router_decide')
    expect(Value.Check(spec.parameters, { trigger_id: 't1', decision: 'accept', reason: 'ok' })).toBe(true)
    expect(Value.Check(spec.parameters, { trigger_id: 't1', decision: 'accept' })).toBe(false)
    expect(Value.Check(spec.parameters, { trigger_id: 't1', decision: 'nope', reason: 'ok' })).toBe(false)
    expect(Value.Check(spec.parameters, { trigger_id: 't1', decision: 'accept', reason: 'ok', rules: ['r1'] })).toBe(true)
  })
})