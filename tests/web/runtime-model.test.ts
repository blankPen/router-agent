import { describe, expect, it } from 'vitest'
import {
  isDeprecatedRuntime,
  isRuntimeSelectable,
  mergeRuntimeChoices,
  runtimeDisplayName,
  runtimeOptionLabel,
  runtimeSourceLabel,
  type RuntimeChoiceView,
} from '../../src/web/client/runtime-model.js'

function choice(over: Partial<RuntimeChoiceView>): RuntimeChoiceView {
  return { id: 'acp-opencode', label: 'OpenCode', hint: 'h', status: 'pending', ...over }
}

describe('运行时卡片纯逻辑', () => {
  it('没有探测结果时补 pending，不伪造 ready', () => {
    const merged = mergeRuntimeChoices()
    const byId = new Map(merged.map(item => [item.id, item]))
    expect(byId.get('orca')?.status).toBe('pending')
    expect(byId.get('claude-code')?.status).toBe('pending')
    expect(byId.get('acp')?.status).toBe('pending')
    expect(byId.get('acp-codex')?.status).toBe('pending')
    expect(byId.get('acp-codex')?.installable).toBe(true)
  })

  it('服务端快照覆盖静态项，未知 id 追加在末尾', () => {
    const merged = mergeRuntimeChoices([
      choice({ id: 'orca', label: 'orca', status: 'ready', version: '1.2.3', source: 'path' }),
      choice({ id: 'legacy-runtime', label: 'Legacy', status: 'incompatible' }),
    ])
    const orca = merged.find(item => item.id === 'orca')
    expect(orca).toMatchObject({ status: 'ready', version: '1.2.3', source: 'path' })
    expect(merged.at(-1)?.id).toBe('legacy-runtime')
  })

  it('只有 ready / unverified / pending 可选', () => {
    expect(isRuntimeSelectable(choice({ status: 'ready' }))).toBe(true)
    expect(isRuntimeSelectable(choice({ status: 'unverified' }))).toBe(true)
    expect(isRuntimeSelectable(choice({ status: 'pending' }))).toBe(true)
    expect(isRuntimeSelectable(choice({ status: 'not-installed' }))).toBe(false)
    expect(isRuntimeSelectable(choice({ status: 'needs-auth' }))).toBe(false)
    expect(isRuntimeSelectable(undefined)).toBe(false)
  })

  it('标题与来源文案', () => {
    expect(runtimeSourceLabel('managed')).toBe('ra 安装')
    expect(runtimeSourceLabel('config')).toBe('配置指定')
    expect(runtimeSourceLabel('path')).toBe('PATH')
    expect(runtimeSourceLabel(undefined)).toBe('')
  })

  it('运行时名统一大写：内置用 name，ACP 用 label', () => {
    expect(runtimeDisplayName({ id: 'orca', label: 'orca · Orca worktree + 终端', hint: 'h', status: 'ready' })).toBe('ORCA')
    expect(runtimeDisplayName({ id: 'claude-code', name: 'Claude Code', label: 'claude-code · git worktree', hint: 'h', status: 'ready' })).toBe('CLAUDE CODE')
    expect(runtimeDisplayName({ id: 'codex-app', name: 'Codex App', label: 'codex-app · Codex App Server', hint: 'h', status: 'ready' })).toBe('CODEX APP')
    expect(runtimeDisplayName({ id: 'acp-opencode', label: 'OpenCode', hint: 'h', status: 'ready' })).toBe('OPENCODE')
    expect(runtimeDisplayName({ id: 'acp-gemini', label: 'Gemini CLI', hint: 'h', status: 'ready' })).toBe('GEMINI CLI')
  })

  it('下拉文案带内置运行时的说明段', () => {
    expect(runtimeOptionLabel({ id: 'orca', name: 'Orca', label: 'orca · Orca worktree + 终端', hint: 'h', status: 'ready' })).toBe('ORCA · Orca worktree + 终端')
    expect(runtimeOptionLabel({ id: 'acp-opencode', label: 'OpenCode', hint: 'h', status: 'ready' })).toBe('OPENCODE')
  })

  it('Claude Code / Codex 的 ACP 版本标记为 deprecated', () => {
    const merged = mergeRuntimeChoices()
    const byId = new Map(merged.map(item => [item.id, item]))
    expect(isDeprecatedRuntime(byId.get('acp-claude')!)).toBe(true)
    expect(isDeprecatedRuntime(byId.get('acp-codex')!)).toBe(true)
    expect(isDeprecatedRuntime(byId.get('acp-opencode')!)).toBe(false)
    expect(isDeprecatedRuntime(byId.get('claude-code')!)).toBe(false)
    expect(isDeprecatedRuntime(byId.get('codex-app')!)).toBe(false)
  })

  it('静态目录带出 name 与 deprecated，服务端快照缺字段时补齐', () => {
    const merged = mergeRuntimeChoices([
      // 老服务端只回传 label：name / deprecated 由静态目录补上。
      { id: 'acp-claude', label: 'Claude Code (ACP)', hint: 'h', status: 'ready' } as RuntimeChoiceView,
    ])
    const claude = merged.find(item => item.id === 'acp-claude')
    expect(claude?.name).toBe('Claude Code')
    expect(claude?.deprecated).toBe(true)
    const orca = merged.find(item => item.id === 'orca')
    expect(orca?.name).toBe('Orca')
  })
})
