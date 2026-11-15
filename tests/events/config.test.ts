import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyConfigPatch, defaultConfig, loadConfig } from '../../src/config.js'

describe('事件配置', () => {
  it('默认配置带事件段，且内置来源都关着', () => {
    const config = defaultConfig()
    expect(config.events.enabled).toBe(false)
    expect(config.events.sources.github?.enabled).toBe(false)
    expect(config.events.sources.http?.enabled).toBe(false)
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

  it('配置补丁允许改决策 prompt 与来源字段', () => {
    const config = defaultConfig()
    const result = applyConfigPatch(config, {
      'events.decision.prompt': '# 新规则',
      'events.sources.github.enabled': true,
      'events.sources.github.defaultPriority': 'P0',
    })
    expect(result.errors).toEqual([])
    expect(config.events.decision.prompt).toBe('# 新规则')
    expect(config.events.sources.github?.enabled).toBe(true)
    expect(config.events.sources.github?.defaultPriority).toBe('P0')
  })

  it('未知来源与未知字段被拒绝', () => {
    const config = defaultConfig()
    const unknownSource = applyConfigPatch(config, { 'events.sources.nope.enabled': true })
    expect(unknownSource.errors[0]?.message).toContain('未知事件来源')
    const unknownField = applyConfigPatch(config, { 'events.sources.github.whatever': 'x' })
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
