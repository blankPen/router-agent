import { describe, expect, it } from 'vitest'
import { CONFIG_GROUPS, blockPaths } from '../../src/web/client/fields.js'
import {
  eventSourceFields,
  eventSourcePaths,
  eventSourcePathsIn,
  sourceFieldDefs,
} from '../../src/web/client/event-sources.js'
import {
  githubSourceId,
  githubRepoIssue,
  nextGithubSourceId,
  toggleEventType,
  withGithubRepo,
} from '../../src/web/client/github-subscriptions.js'

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

describe('GitHub 仓库订阅', () => {
  it('来源 id 按序号递增，不跟已有的重号', () => {
    expect(githubSourceId(1)).toBe('github-1')
    expect(nextGithubSourceId([])).toBe('github-1')
    expect(nextGithubSourceId(['github-1', 'github-2'])).toBe('github-3')
    // 非 GitHub 的来源 id 不占号
    expect(nextGithubSourceId(['feishu', 'github-1'])).toBe('github-2')
  })

  it('新增仓库订阅时默认启用并订阅全部事件类型', () => {
    const source = withGithubRepo('github-1', 'blankPen/router-agent')
    expect(source).not.toBeNull()
    expect(source?.enabled).toBe(true)
    expect(source?.kind).toBe('github')
    expect(source?.repo).toBe('blankPen/router-agent')
    expect(source?.events).toEqual([])
  })

  it('仓库地址为空时不生成订阅', () => {
    expect(withGithubRepo('github-1', '  ')).toBeNull()
  })

  it('仓库地址格式不对时给出提示', () => {
    expect(githubRepoIssue('')).toContain('请填写仓库地址')
    expect(githubRepoIssue('router-agent')).toContain('owner/repo')
    expect(githubRepoIssue('blankPen/router-agent')).toBeNull()
  })

  it('勾选事件类型时按目录顺序排列', () => {
    expect(toggleEventType(['workflow_run.failure'], 'issues.opened', true)).toEqual([
      'issues.opened',
      'workflow_run.failure',
    ])
    expect(toggleEventType(['issues.opened', 'issues.closed'], 'issues.opened', false)).toEqual(['issues.closed'])
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
