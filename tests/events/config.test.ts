import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyConfigPatch, defaultConfig, loadConfig, writeConfig } from '../../src/config.js'

describe('事件配置', () => {
  it('默认配置带事件段，且内置来源都关着', () => {
    const config = defaultConfig()
    expect(config.events.enabled).toBe(false)
    // GitHub 仓库由面板「添加仓库」创建，默认配置里不留空壳来源。
    expect(config.events.sources.github).toBeUndefined()
    expect(config.events.decision.provider).toBe('rule')
    expect(config.events.rules).toEqual([])
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

  it('配置补丁允许改判定方式与来源字段', () => {
    const config = defaultConfig()
    config.events.sources['github-1'] = { enabled: true, kind: 'github', repo: 'a/b', events: [] }
    const result = applyConfigPatch(config, {
      'events.decision.provider': 'llm',
      'events.sources.github-1.enabled': true,
    })
    expect(result.errors).toEqual([])
    expect(config.events.decision.provider).toBe('llm')
    expect(config.events.sources['github-1']?.enabled).toBe(true)
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

  it('从 YAML 读取按 eventType 的规则集', () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-events-'))
    writeFileSync(join(home, 'config.yaml'), [
      'events:',
      '  rules:',
      '    - id: rule-ci',
      '      eventType: github.workflow_run.failure',
      '      intent: 修复 CI',
      '      workflowPrompt: 分析失败并提交 PR',
      '      thresholds:',
      '        isValid: 0.4',
      '        projectPick: 0.3',
      '',
    ].join('\n'), 'utf8')
    const config = loadConfig(home, {})
    expect(config.events.rules).toHaveLength(1)
    expect(config.events.rules[0]).toMatchObject({
      id: 'rule-ci',
      eventType: 'github.workflow_run.failure',
      workflowPrompt: '分析失败并提交 PR',
      thresholds: { isValid: 0.4, projectPick: 0.3 },
    })
    expect(config.events.rules[0]?.questions.is_valid.type).toBe('noul')
  })

  it('旧配置里的全局 prompt 被忽略，不再影响判定', () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-events-'))
    writeFileSync(join(home, 'config.yaml'), [
      'events:',
      '  decision:',
      '    provider: llm',
      '    prompt: 旧的全局判定规则',
      '    fallbackToPrompt: true',
      '',
    ].join('\n'), 'utf8')
    const config = loadConfig(home, {})
    expect(config.events.decision.provider).toBe('llm')
    expect(config.events.rules).toEqual([])
  })

  it('写回配置时旧版全局 prompt 与兜底开关被丢掉', () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-events-'))
    writeFileSync(join(home, 'config.yaml'), [
      'events:',
      '  decision:',
      '    provider: llm',
      '    prompt: 旧的全局判定规则',
      '    fallbackToPrompt: true',
      '',
    ].join('\n'), 'utf8')
    const config = loadConfig(home, {})
    writeConfig(home, config)
    const written = readFileSync(join(home, 'config.yaml'), 'utf8')
    expect(written).not.toContain('fallbackToPrompt')
    expect(written).not.toContain('旧的全局判定规则')
    expect(written).toContain('provider: llm')
  })

  it('规则整段写入做 eventType 前缀与重复校验', () => {
    const config = defaultConfig()
    const good = applyConfigPatch(config, {
      'events.rules': [{
        id: 'rule-ci',
        eventType: 'github.workflow_run.failure',
        intent: '修复 CI',
        workflowPrompt: '分析并修复',
      }],
    })
    expect(good.errors).toEqual([])
    expect(config.events.rules[0]?.id).toBe('rule-ci')

    const badPrefix = applyConfigPatch(config, {
      'events.rules': [{ id: 'bad', eventType: 'workflow_run.failure', intent: 'x' }],
    })
    expect(badPrefix.errors[0]?.message).toContain('来源前缀')

    const duplicate = applyConfigPatch(config, {
      'events.rules': [
        { id: 'a', eventType: 'github.issues.opened', intent: 'a' },
        { id: 'b', eventType: 'github.issues.opened', intent: 'b' },
      ],
    })
    expect(duplicate.errors[0]?.message).toContain('事件类型重复')
  })
})

describe('事件来源订阅 · 纯粹订阅', () => {
  it('订阅里不再有默认优先级、默认类型与每日配额', () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-events-'))
    writeFileSync(join(home, 'config.yaml'), [
      'events:',
      '  sources:',
      '    github-1:',
      '      enabled: true',
      '      kind: github',
      '      repo: blankPen/router-agent',
      '      events: [issues.opened]',
      '      defaultPriority: P1',
      '      defaultType: issue',
      '      dailyLimit: 10',
      '',
    ].join('\n'), 'utf8')
    const config = loadConfig(home, {})
    const source = config.events.sources['github-1']
    expect(source).not.toHaveProperty('defaultPriority')
    expect(source).not.toHaveProperty('defaultType')
    expect(source).not.toHaveProperty('dailyLimit')
  })

  it('订阅里写默认优先级这类参数会被拒绝', () => {
    const config = defaultConfig()
    config.events.sources['github-1'] = { enabled: true, kind: 'github', repo: 'a/b', events: [] }
    const result = applyConfigPatch(config, { 'events.sources.github-1.defaultPriority': 'P0' })
    expect(result.errors[0]?.message).toContain('不是可编辑的事件来源字段')
  })
})
