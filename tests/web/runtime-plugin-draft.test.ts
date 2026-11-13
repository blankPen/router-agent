import { describe, expect, it } from 'vitest'
import { applyRuntimePluginDraft } from '../../src/web/client/fields.js'

describe('运行时插件草稿写入', () => {
  it('npm 包入口按包名写入 runtime.plugins.<id> 并去掉首尾空白', () => {
    const draft = applyRuntimePluginDraft({ runtime: { default: 'orca' } }, ' @acme/runtime-x ')
    expect(draft).toEqual({ runtime: { default: 'orca', plugins: { x: '@acme/runtime-x' } } })
  })

  it('本地路径按目录名推导 id 后写入', () => {
    const draft = applyRuntimePluginDraft({}, './path/to/demo-runtime')
    expect(draft).toEqual({ runtime: { plugins: { 'demo-runtime': './path/to/demo-runtime' } } })
  })

  it('入口为空或无法推导 id 时不写入，返回原草稿', () => {
    const source = { runtime: { plugins: { demo: './x' } } }
    expect(applyRuntimePluginDraft(source, '   ')).toBe(source)
    expect(applyRuntimePluginDraft(source, '---')).toBe(source)
  })

  it('已有插件保持不变，只新增推导出的 id', () => {
    const draft = applyRuntimePluginDraft({ runtime: { plugins: { demo: './x' } } }, '@scope/runtime-new')
    expect(draft).toEqual({ runtime: { plugins: { demo: './x', new: '@scope/runtime-new' } } })
  })
})
