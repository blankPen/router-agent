import { describe, expect, it } from 'vitest'
import { Value } from 'typebox/value'
import { DECISION_TOOL_NAMES, ROUTER_TOOL_SPECS, toOpenAiTool, toolSpec } from '../../src/router/tool-spec.js'
import { ROUTER_TOOLS } from '../../src/router/tools.js'

describe('统一工具契约（TypeBox + OpenAI JSON Schema）', () => {
  it('ROUTER_TOOLS 与 tool-spec 同源，名称/描述/参数完全一致', () => {
    expect(ROUTER_TOOLS.map(tool => tool.function.name)).toEqual(ROUTER_TOOL_SPECS.map(spec => spec.name))
    for (const spec of ROUTER_TOOL_SPECS) {
      const openai = toOpenAiTool(spec)
      expect(openai.function.description).toBe(spec.description)
      expect(openai.function.parameters).toEqual(spec.parameters)
      expect((openai.function.parameters as { type?: string }).type).toBe('object')
    }
  })

  it('router_decide 的必填字段与枚举可用于校验', () => {
    const spec = toolSpec('router_decide')
    expect(Value.Check(spec.parameters, { trigger_id: 't1', decision: 'accept', reason: 'ok' })).toBe(true)
    expect(Value.Check(spec.parameters, { trigger_id: 't1', decision: 'accept' })).toBe(false)
    expect(Value.Check(spec.parameters, { trigger_id: 't1', decision: 'nope', reason: 'ok' })).toBe(false)
    expect(Value.Check(spec.parameters, { trigger_id: 't1', decision: 'accept', reason: 'ok', rules: ['r1'] })).toBe(true)
  })

  it('研判层只暴露三个工具（read / ticket / decide）', () => {
    expect([...DECISION_TOOL_NAMES].sort()).toEqual(['router_decide', 'router_read', 'router_ticket'])
    // 写类工具不进 Pi 白名单。
    expect(DECISION_TOOL_NAMES).not.toContain('router_subscribe')
    expect(DECISION_TOOL_NAMES).not.toContain('router_reply')
  })
})