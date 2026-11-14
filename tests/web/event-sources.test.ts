import { describe, expect, it } from 'vitest'
import { CONFIG_GROUPS, blockPaths } from '../../src/web/client/fields.js'
import {
  eventSourceFields,
  eventSourcePaths,
  eventSourcePathsIn,
  sourceFieldDefs,
} from '../../src/web/client/event-sources.js'

describe('事件来源字段映射', () => {
  it('来源字段写成 events.sources.<id>.<key> 路径，类型按声明换算', () => {
    const defs = sourceFieldDefs('github', [
      { key: 'repo', label: '仓库', kind: 'text' },
      { key: 'intervalMs', label: '轮询间隔（毫秒）', kind: 'number' },
      { key: 'labels', label: '标签白名单', kind: 'list' },
      { key: 'defaultPriority', label: '默认优先级', kind: 'select', options: ['P0', 'P1'] },
    ])
    expect(defs.map(def => def.path)).toEqual([
      'events.sources.github.repo',
      'events.sources.github.intervalMs',
      'events.sources.github.labels',
      'events.sources.github.defaultPriority',
    ])
    expect(defs.map(def => def.kind)).toEqual(['text', 'number', 'list', 'select'])
    expect(defs[3]?.options).toEqual([{ value: 'P0', label: 'P0' }, { value: 'P1', label: 'P1' }])
  })

  it('验签密钥按密码字段渲染，不在页面上明文显示', () => {
    const [secret] = sourceFieldDefs('http', [{ key: 'secret', label: '验签密钥', kind: 'text' }])
    expect(secret?.kind).toBe('password')
  })
})

describe('配置页的事件总线分组', () => {
  const group = CONFIG_GROUPS.find(item => item.id === 'events')

  it('事件配置挂在「配置」页的独立分组里', () => {
    expect(group?.title).toBe('事件总线')
    const ids = group?.blocks.map(block => block.id)
    expect(ids).toContain('events-sources')
    expect(ids).toContain('events-decision')
  })

  it('来源块由专属渲染器处理，判定与成本项走普通字段', () => {
    const sources = group?.blocks.find(block => block.id === 'events-sources')
    expect(sources?.render).toBe('events')
    const paths = group?.blocks.flatMap(block => blockPaths(block)) ?? []
    expect(paths).toContain('events.enabled')
    expect(paths).toContain('events.decision.prompt')
    expect(paths).toContain('events.policy.dailyEventLimit')
  })
})

describe('插件来源的字段', () => {
  it('插件自己声明的选项落在 options 下，路径拼到来源里', () => {
    const defs = sourceFieldDefs('demo-source', [
      { key: 'options.target', label: '巡检目标', kind: 'text' },
      { key: 'options.verbose', label: '输出详情', kind: 'boolean' },
    ])
    expect(defs.map(def => def.path)).toEqual([
      'events.sources.demo-source.options.target',
      'events.sources.demo-source.options.verbose',
    ])
    expect(defs.map(def => def.kind)).toEqual(['text', 'switch'])
  })
})

describe('事件来源的改动追踪', () => {
  const sources = [
    {
      id: 'github',
      kind: 'github',
      enabled: true,
      builtin: true,
      status: 'ok',
      fields: [{ key: 'repo', label: '仓库', kind: 'text' }],
    },
  ]

  it('启用开关与各字段都在追踪路径里，改了才能进保存补丁', () => {
    expect(eventSourcePaths(sources)).toEqual([
      'events.sources.github.enabled',
      'events.sources.github.repo',
    ])
    expect(eventSourceFields(sources).map(field => field.path)).toEqual(['events.sources.github.repo'])
  })

  it('草稿里刚加的来源也算进去，改了才能进保存补丁', () => {
    const paths = eventSourcePathsIn(sources, { 'demo-source': { plugin: '@scope/demo' } })
    expect(paths).toContain('events.sources.demo-source.plugin')
    expect(paths).toContain('events.sources.demo-source.enabled')
  })
})
