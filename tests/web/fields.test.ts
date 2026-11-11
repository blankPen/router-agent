import { describe, expect, it } from 'vitest'
import { runtimeOptions, sectionsFor } from '../../src/web/client/fields.js'
import type { RuntimeChoiceView } from '../../src/web/client/runtime-model.js'

describe('运行时下拉选项', () => {
  it('没有探测结果时也列出内置运行时，名称首字母大写', () => {
    const options = runtimeOptions()
    const byId = new Map(options.map(option => [option.value, option]))
    expect(byId.get('orca')?.label).toBe('Orca · Orca worktree + 终端 · 待检测')
    expect(byId.get('claude-code')?.label).toBe('Claude Code · git worktree + claude --bg · 待检测')
    expect(byId.get('codex-app')?.label).toBe('Codex App · Codex App Server · 待检测')
    expect(byId.get('acp-opencode')?.label).toBe('OpenCode · 待检测')
  })

  it('默认不列出 Claude Code / Codex 的 ACP 版本', () => {
    const ids = runtimeOptions().map(option => option.value)
    expect(ids).not.toContain('acp-claude')
    expect(ids).not.toContain('acp-codex')
    expect(ids).toContain('acp-opencode')
    expect(ids).toContain('acp-goose')
  })

  it('当前正选中的 deprecated 运行时仍然保留在选项里', () => {
    const options = runtimeOptions(undefined, 'acp-claude')
    const claude = options.find(option => option.value === 'acp-claude')
    expect(claude?.label).toContain('Claude Code')
    expect(options.find(option => option.value === 'acp-codex')).toBeUndefined()
  })

  it('探测结果里标了 deprecated 的也隐藏', () => {
    const choices: RuntimeChoiceView[] = [
      { id: 'acp-codex', name: 'Codex', label: 'Codex (ACP)', hint: 'h', status: 'ready', deprecated: true },
    ]
    const options = runtimeOptions(choices)
    expect(options.find(option => option.value === 'acp-codex')).toBeUndefined()
  })

  it('sectionsFor 只替换 runtime.default 的选项', () => {
    const sections = sectionsFor()
    const delivery = sections.find(section => section.id === 'delivery')
    const field = delivery?.fields.find(item => item.path === 'runtime.default')
    expect(field?.kind).toBe('select')
    expect(field?.options?.some(option => option.value === 'orca')).toBe(true)
  })
})
