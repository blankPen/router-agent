import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyConfigPatch, defaultConfig, loadConfig } from '../../src/config.js'

describe('事件配置', () => {
  it('默认配置带事件段，且内置来源都关着', () => {
    const config = defaultConfig()
    expect(config.events.enabled).toBe(false)
    // GitHub 仓库由面板「添加仓库」创建，默认配置里不留空壳来源。
    expect(config.events.sources.github).toBeUndefined()
    expect(config.events.decision.prompt.length).toBeGreaterThan(0)
  })

  it('从 YAML 读取事件配置', () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-events-'))
    writeFileSync(join(home, 'config.yaml'), [
      'events:',
      '  enabled: true',
      '  sources:',
      '    github:',
      '      enabled: true',
      '      kind: github',
      '      repo: blankPen/router-agent',
      '      labels: [bug]',
      '      defaultPriority: P1',
      '  decision:',
      '    provider: llm',
      '    confidenceThreshold: 0.8',
      '  policy:',
      '    peak:',
      '      start: "10:00"',
      '      end: "12:00"',
      '      priorities: [P0, P1]',
      '',
    ].join('\n'), 'utf8')
    const config = loadConfig(home, {})
    expect(config.events.enabled).toBe(true)
    expect(config.events.sources.github?.repo).toBe('blankPen/router-agent')
    expect(config.events.sources.github?.defaultPriority).toBe('P1')
    expect(config.events.decision.provider).toBe('llm')
    expect(config.events.decision.confidenceThreshold).toBe(0.8)
    expect(config.events.policy.peak.start).toBe('10:00')
    expect(config.events.policy.peak.priorities).toEqual(['P0', 'P1'])
  })

  it('旧配置里的 http 与 schedule 来源被丢弃', () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-events-'))
    writeFileSync(join(home, 'config.yaml'), [
      'events:',
      '  enabled: true',
      '  sources:',
      '    github:',
      '      enabled: true',
      '      kind: github',
      '      repo: a/b',
      '    http:',
      '      enabled: true',
      '      kind: http',
      '      path: /api/events/inject',
      '    schedule:',
      '      enabled: true',
      '      kind: schedule',
      '      title: 定时任务',
      '',
    ].join('\n'), 'utf8')
    const config = loadConfig(home, {})
    expect(config.events.sources.github?.enabled).toBe(true)
    expect(config.events.sources.http).toBeUndefined()
    expect(config.events.sources.schedule).toBeUndefined()
  })

  it('旧配置里没填仓库的 GitHub 空壳来源被丢弃', () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-events-'))
    writeFileSync(join(home, 'config.yaml'), [
      'events:',
      '  sources:',
      '    github:',
      '      enabled: false',
      '      kind: github',
      '      repo: ""',
      '',
    ].join('\n'), 'utf8')
    const config = loadConfig(home, {})
    expect(config.events.sources.github).toBeUndefined()
  })

  it('GitHub 来源按仓库与事件类型订阅，不再有项目线索等参数', () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-events-'))
    writeFileSync(join(home, 'config.yaml'), [
      'events:',
      '  enabled: true',
      '  sources:',
      '    github-1:',
      '      enabled: true',
      '      kind: github',
      '      repo: blankPen/router-agent',
      '      events: [issues.opened, pull_request.merged, workflow_run.failure]',
      '',
    ].join('\n'), 'utf8')
    const config = loadConfig(home, {})
    const source = config.events.sources['github-1']
    expect(source?.repo).toBe('blankPen/router-agent')
    expect(source?.events).toEqual(['issues.opened', 'pull_request.merged', 'workflow_run.failure'])
    // 旧的项目线索 / 起始分支 / 标签白名单参数不再进入配置。
    expect(source).not.toHaveProperty('project')
    expect(source).not.toHaveProperty('branch')
    expect(source).not.toHaveProperty('labels')
  })

  it('GitHub 来源没写事件类型时默认订阅全部类型', () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-events-'))
    writeFileSync(join(home, 'config.yaml'), [
      'events:',
      '  sources:',
      '    github-1:',
      '      kind: github',
      '      repo: a/b',
      '',
    ].join('\n'), 'utf8')
    const config = loadConfig(home, {})
    expect(config.events.sources['github-1']?.events?.length).toBeGreaterThan(0)
  })

  it('写 GitHub 事件类型时只认目录里的类型', () => {
    const config = defaultConfig()
    config.events.sources['github-1'] = { enabled: true, kind: 'github', repo: 'a/b', events: [] }
    const bad = applyConfigPatch(config, { 'events.sources.github-1.events': ['issues.exploded'] })
    expect(bad.errors[0]?.message).toContain('issues.exploded')
    const good = applyConfigPatch(config, { 'events.sources.github-1.events': ['issues.opened'] })
    expect(good.errors).toEqual([])
    expect(config.events.sources['github-1']?.events).toEqual(['issues.opened'])
  })

  it('整条写入 GitHub 仓库订阅', () => {
    const config = defaultConfig()
    const result = applyConfigPatch(config, {
      'events.sources.github-1': {
        enabled: true,
        kind: 'github',
        repo: 'blankPen/router-agent',
        events: ['issues.opened', 'workflow_run.failure'],
      },
    })
    expect(result.errors).toEqual([])
    expect(config.events.sources['github-1']).toEqual({
      enabled: true,
      kind: 'github',
      repo: 'blankPen/router-agent',
      events: ['issues.opened', 'workflow_run.failure'],
    })
  })

  it('整条写入时校验仓库地址与事件类型', () => {
    const config = defaultConfig()
    const noRepo = applyConfigPatch(config, { 'events.sources.github-1': { enabled: true, kind: 'github', events: [] } })
    expect(noRepo.errors[0]?.message).toContain('仓库')
    const badType = applyConfigPatch(config, {
      'events.sources.github-1': { enabled: true, kind: 'github', repo: 'a/b', events: ['issues.exploded'] },
    })
    expect(badType.errors[0]?.message).toContain('issues.exploded')
  })

  it('传空值删除整条仓库订阅', () => {
    const config = defaultConfig()
    config.events.sources['github-1'] = { enabled: true, kind: 'github', repo: 'a/b', events: [] }
    const result = applyConfigPatch(config, { 'events.sources.github-1': null })
    expect(result.errors).toEqual([])
    expect(config.events.sources['github-1']).toBeUndefined()
  })

  it('配置补丁允许改决策 prompt 与来源字段', () => {
    const config = defaultConfig()
    config.events.sources['github-1'] = { enabled: true, kind: 'github', repo: 'a/b', events: [] }
    const result = applyConfigPatch(config, {
      'events.decision.prompt': '# 新规则',
      'events.sources.github-1.enabled': true,
      'events.sources.github-1.defaultPriority': 'P0',
    })
    expect(result.errors).toEqual([])
    expect(config.events.decision.prompt).toBe('# 新规则')
    expect(config.events.sources['github-1']?.enabled).toBe(true)
    expect(config.events.sources['github-1']?.defaultPriority).toBe('P0')
  })

  it('未知来源与未知字段被拒绝', () => {
    const config = defaultConfig()
    const unknownSource = applyConfigPatch(config, { 'events.sources.nope.enabled': true })
    expect(unknownSource.errors[0]?.message).toContain('未知事件来源')
    config.events.sources['github-1'] = { enabled: true, kind: 'github', repo: 'a/b', events: [] }
    const unknownField = applyConfigPatch(config, { 'events.sources.github-1.whatever': 'x' })
    expect(unknownField.errors[0]?.message).toContain('不是可编辑的事件来源字段')
  })

  it('插件入口可以新建一个事件来源，默认启用', () => {
    const config = defaultConfig()
    const result = applyConfigPatch(config, {
      'events.sources.demo-source.plugin': '@scope/demo-source',
      'events.sources.demo-source.enabled': true,
    })
    expect(result.errors).toEqual([])
    expect(config.events.sources['demo-source']).toMatchObject({
      enabled: true,
      plugin: '@scope/demo-source',
    })
  })

  it('插件自己声明的选项可以逐项写入', () => {
    const config = defaultConfig()
    applyConfigPatch(config, { 'events.sources.demo-source.plugin': '@scope/demo-source' })
    const result = applyConfigPatch(config, {
      'events.sources.demo-source.options.target': 'checkout',
      'events.sources.demo-source.options.verbose': true,
    })
    expect(result.errors).toEqual([])
    expect(config.events.sources['demo-source']?.options).toEqual({ target: 'checkout', verbose: true })
  })

  it('事件配置改动不需要重启', () => {
    const config = defaultConfig()
    const result = applyConfigPatch(config, { 'events.enabled': true })
    expect(result.errors).toEqual([])
  })
})
