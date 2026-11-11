import { describe, expect, it } from 'vitest'
import {
  applyConfigPatch,
  defaultConfig,
  setConfigValue,
} from '../../src/config.js'
import {
  optionFieldOf,
  optionSpecOf,
  parseRuntimeOptionPath,
  runtimeOptionPath,
  runtimeOptionPaths,
  runtimeOptionString,
  validateRuntimeOption,
} from '../../src/worker/runtimes/options.js'
import { allRuntimeOptionFields, runtimeOptionFields, sectionsFor } from '../../src/web/client/fields.js'

describe('运行时选项：通用声明与路径', () => {
  it('路径形状可解析，配置落点是 runtime.options.<runtimeId>.<key>', () => {
    expect(runtimeOptionPath('orca', 'agent')).toBe('runtime.options.orca.agent')
    expect(parseRuntimeOptionPath('runtime.options.orca.agent')).toEqual({ runtimeId: 'orca', key: 'agent' })
    expect(parseRuntimeOptionPath('runtime.options.orca')).toBeNull()
    expect(parseRuntimeOptionPath('runtime.projects.orca')).toBeNull()
  })

  it('每个运行时自己声明能配什么；没声明的运行时没有选项', () => {
    expect(optionSpecOf('orca')?.fields.map(field => field.key)).toEqual(['agent'])
    expect(optionSpecOf('claude-code')).toBeNull()
    expect(optionFieldOf('orca', 'agent')?.kind).toBe('select')
    expect(optionFieldOf('orca', 'nope')).toBeNull()
    expect(runtimeOptionPaths()).toContain('runtime.options.orca.agent')
  })

  it('取值按声明校验；select 只接受声明过的候选', () => {
    const field = optionFieldOf('orca', 'agent')!
    expect(validateRuntimeOption(field, 'codex')).toBeNull()
    expect(validateRuntimeOption(field, '')).toBeNull()
    expect(validateRuntimeOption(field, 'nope')).toContain('取值必须是')
  })

  it('从配置里读选项字符串', () => {
    expect(runtimeOptionString({ orca: { agent: ' codex ' } }, 'orca', 'agent')).toBe('codex')
    expect(runtimeOptionString({ orca: { agent: 'codex' } }, 'claude-code', 'agent')).toBe('')
    expect(runtimeOptionString(undefined, 'orca', 'agent')).toBe('')
  })
})

describe('运行时选项：配置读写', () => {
  it('面板补丁按声明校验后写进 runtime.options', () => {
    const config = defaultConfig()
    const result = applyConfigPatch(config, { 'runtime.options.orca.agent': 'codex' })
    expect(result.errors).toEqual([])
    expect(result.changed).toEqual(['runtime.options.orca.agent'])
    expect(config.runtime.options?.orca).toEqual({ agent: 'codex' })
  })

  it('未知运行时、未知选项与非法取值都被拒绝', () => {
    const config = defaultConfig()
    expect(applyConfigPatch(config, { 'runtime.options.nope.agent': 'codex' }).errors[0]?.message).toContain('未知 runtime')
    expect(applyConfigPatch(config, { 'runtime.options.orca.nope': 'x' }).errors[0]?.message).toContain('未知选项')
    expect(applyConfigPatch(config, { 'runtime.options.orca.agent': 'nope' }).errors[0]?.message).toContain('取值必须是')
  })

  it('留空表示不覆盖：把键删掉而不是写空串', () => {
    const config = defaultConfig()
    applyConfigPatch(config, { 'runtime.options.orca.agent': 'codex' })
    applyConfigPatch(config, { 'runtime.options.orca.agent': '' })
    expect(config.runtime.options?.orca).toBeUndefined()
  })

  it('命令行同样能改运行时选项', () => {
    const config = defaultConfig()
    expect(setConfigValue(config, 'runtime.options.orca.agent', 'codex')).toBe(true)
    expect(config.runtime.options?.orca).toEqual({ agent: 'codex' })
    expect(setConfigValue(config, 'runtime.options.orca.agent', 'nope')).toBe(false)
    expect(setConfigValue(config, 'runtime.options.orca.nope', 'x')).toBe(false)
  })
})

describe('运行时选项：面板渲染', () => {
  it('面板按运行时声明生成字段，不写死运行时', () => {
    const fields = runtimeOptionFields('orca')
    expect(fields).toHaveLength(1)
    expect(fields[0]?.path).toBe('runtime.options.orca.agent')
    expect(fields[0]?.kind).toBe('select')
    expect(fields[0]?.options?.map(option => option.value)).toContain('')
    expect(runtimeOptionFields('claude-code')).toEqual([])
  })

  it('选项不在页面上平铺：走卡片上的「设置」弹窗', () => {
    const sections = sectionsFor(undefined, 'orca')
    const paths = sections.flatMap(section => section.fields.map(field => field.path))
    expect(paths).not.toContain('runtime.options.orca.agent')
  })

  it('保存前校验覆盖所有已声明运行时的选项', () => {
    const fields = allRuntimeOptionFields()
    expect(fields.map(field => field.path)).toEqual(['runtime.options.orca.agent'])
  })
})
