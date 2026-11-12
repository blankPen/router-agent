import { describe, expect, it } from 'vitest'
import { mergeRuntimeChoices } from '../../src/web/client/runtime-model.js'
import type { PluginView } from '../../src/web/client/api.js'

function plugin(over: Partial<PluginView> = {}): PluginView {
  return {
    id: 'my-runtime',
    kind: 'runtime',
    name: 'My Runtime',
    label: 'my-runtime · 自定义运行时',
    hint: '测试插件',
    status: 'loaded',
    ...over,
  }
}

describe('运行时插件合并', () => {
  it('服务端插件元数据会补进运行时目录，并保留 loaded 状态', () => {
    const choices = mergeRuntimeChoices(undefined, [plugin()])
    const choice = choices.find(item => item.id === 'my-runtime')
    expect(choice).toMatchObject({
      id: 'my-runtime',
      name: 'My Runtime',
      status: 'pending',
      plugin: { id: 'my-runtime', kind: 'runtime', status: 'loaded' },
    })
  })

  it('插件加载失败变成不可选，并把错误作为 reason', () => {
    const choices = mergeRuntimeChoices(undefined, [
      plugin({ status: 'failed', error: 'Cannot find package' }),
    ])
    const choice = choices.find(item => item.id === 'my-runtime')
    expect(choice?.status).toBe('incompatible')
    expect(choice?.reason).toBe('Cannot find package')
  })

  it('内置运行时的探测结果仍然覆盖静态占位', () => {
    const choices = mergeRuntimeChoices([{
      id: 'orca',
      label: 'orca · Orca worktree + 终端',
      hint: 'orca',
      status: 'ready',
      version: '1.2.3',
    }], [plugin({ id: 'orca', name: '自定义 Orca' })])
    const orca = choices.find(item => item.id === 'orca')
    expect(orca).toMatchObject({ status: 'ready', version: '1.2.3' })
  })
})
