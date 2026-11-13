import { describe, expect, it } from 'vitest'
import { applyRuntimePluginDraft } from '../../src/web/client/fields.js'

describe('运行时插件草稿写入', () => {
  it('npm 包入口写入 runtime.plugins.<id> 并去掉首尾空白', () => {
    const draft = applyRuntimePluginDraft({ runtime: { default: 'orca' } }, ' my-runtime ', ' @acme/runtime-x ')
    expect(draft).toEqual({ runtime: { default: 'orca', plugins: { 'my-runtime': '@acme/runtime-x' } } })
  })

  it('本地路径同样可以写入', () => {
    const draft = applyRuntimePluginDraft({}, 'demo', './path/to/runtime')
    expect(draft).toEqual({ runtime: { plugins: { demo: './path/to/runtime' } } })
  })

  it('id 或入口为空时不写入，返回原草稿', () => {
    const source = { runtime: { plugins: { demo: './x' } } }
    expect(applyRuntimePluginDraft(source, '   ', 'pkg')).toBe(source)
    expect(applyRuntimePluginDraft(source, 'demo', '   ')).toBe(source)
  })

  it('已有插件保持不变，只新增目标 id', () => {
    const draft = applyRuntimePluginDraft({ runtime: { plugins: { demo: './x' } } }, 'new', '@scope/rt')
    expect(draft).toEqual({ runtime: { plugins: { demo: './x', new: '@scope/rt' } } })
  })
})
