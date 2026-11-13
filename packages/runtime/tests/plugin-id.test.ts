import { describe, expect, it } from 'vitest'
import { runtimeIdFromPluginSource } from '../src/plugins/id.js'

describe('按包名 / 路径推导运行时 id', () => {
  it('去掉 npm scope 与 runtime- 前缀', () => {
    expect(runtimeIdFromPluginSource('@acme/runtime-x')).toBe('x')
    expect(runtimeIdFromPluginSource('runtime-agent')).toBe('agent')
  })

  it('scoped 包名保留业务名，不额外裁掉 router-agent 前缀', () => {
    expect(runtimeIdFromPluginSource('@acme/router-agent-runtime')).toBe('router-agent-runtime')
  })

  it('本地路径取目录名并按同一规则推导', () => {
    expect(runtimeIdFromPluginSource('./plugins/my-runtime')).toBe('my-runtime')
    expect(runtimeIdFromPluginSource('/abs/path/runtime-y/')).toBe('y')
    expect(runtimeIdFromPluginSource('file:/abs/path/Runtime_Z')).toBe('z')
  })

  it('空值与无法形成合法 id 的来源返回 undefined', () => {
    expect(runtimeIdFromPluginSource('   ')).toBeUndefined()
    expect(runtimeIdFromPluginSource('@scope/')).toBeUndefined()
    expect(runtimeIdFromPluginSource('---')).toBeUndefined()
  })
})
