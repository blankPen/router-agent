import { describe, expect, it } from 'vitest'
import {
  isRuntimeSelectable,
  mergeRuntimeChoices,
  runtimeDisplayName,
  runtimeSourceLabel,
  type RuntimeChoiceView,
} from '../../src/web/client/runtime-model.js'

function choice(over: Partial<RuntimeChoiceView>): RuntimeChoiceView {
  return { id: 'acp-claude', label: 'Claude Code (ACP)', hint: 'h', status: 'pending', ...over }
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
    expect(runtimeDisplayName({ id: 'orca', label: 'orca · Orca worktree + 终端', hint: 'h', status: 'ready' })).toBe('orca')
    expect(runtimeSourceLabel('managed')).toBe('ra 安装')
    expect(runtimeSourceLabel('config')).toBe('配置指定')
    expect(runtimeSourceLabel('path')).toBe('PATH')
    expect(runtimeSourceLabel(undefined)).toBe('')
  })
})
