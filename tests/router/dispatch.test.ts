import { describe, expect, it } from 'vitest'
import { chatEntry, defaultConfig } from '../../src/config.js'
import { activeDraft, dispatchSettingsOf, matchProject, resolveDispatch, type DispatchSettings } from '../../src/router/dispatch.js'
import type { DispatchDraft } from '../../src/core/model.js'

const project = (over: Partial<DispatchSettings['projects'][number]> = {}) => ({
  name: 'router-agent',
  repo: 'name:dsh/router-agent',
  defaultBranch: 'main',
  ...over,
})

function settings(over: Partial<DispatchSettings> = {}): DispatchSettings {
  return { projects: [project()], bindings: [], ...over }
}

const draft = (over: Partial<DispatchDraft> = {}): DispatchDraft => ({
  chatId: 'oc_dev',
  threadId: 'feishu:oc_dev:om_1',
  actorId: 'ou_alice',
  task: '把登录超时改成 30 秒',
  repo: '',
  branch: '',
  updatedAt: '2026-11-06T10:00:00.000Z',
  ...over,
})

describe('多项目 / 多分支派工解析', () => {
  it('只有一个项目且配了默认分支时，无需追问即可派工', () => {
    const result = resolveDispatch({ settings: settings(), chatId: 'oc_dev' })
    expect(result).toMatchObject({ repo: 'name:dsh/router-agent', branch: 'main', missing: [] })
    expect(result.project?.name).toBe('router-agent')
  })

  it('群里绑定 repo/branch 后直接可派工，且不需要用户提项目', () => {
    const result = resolveDispatch({
      settings: settings({ bindings: [{ chat: 'oc_dev', repo: 'router-agent', branch: 'release' }] }),
      chatId: 'oc_dev',
    })
    expect(result.repo).toBe('name:dsh/router-agent')
    expect(result.branch).toBe('release')
    expect(result.missing).toEqual([])
    expect(result.binding?.branch).toBe('release')
  })

  it('用户只写仓库最后一段也能匹配到项目', () => {
    const result = resolveDispatch({ settings: settings({ projects: [] }), chatId: 'oc_dev', repo: 'dsh/router-agent', branch: 'main' })
    expect(result.repo).toBe('dsh/router-agent')
    expect(result.missing).toEqual([])
  })

  it('没有任何来源时，项目与分支都算缺失', () => {
    const result = resolveDispatch({ settings: { projects: [], bindings: [] }, chatId: 'oc_dev' })
    expect(result.missing).toEqual(['repo', 'branch'])
    expect(result.repo).toBe('')
    expect(result.branch).toBe('')
  })

  it('上一轮草稿里的项目/分支会被继承，用户只需补缺的那一项', () => {
    const result = resolveDispatch({ settings: settings({ projects: [project({ defaultBranch: '' })] }), chatId: 'oc_dev', draft: draft({ branch: 'release' }) })
    expect(result.repo).toBe('name:dsh/router-agent')
    expect(result.branch).toBe('release')
    expect(result.missing).toEqual([])
  })

  it('项目不在清单里时标记 rejectedRepo 并要求重选', () => {
    const result = resolveDispatch({ settings: settings(), chatId: 'oc_dev', repo: 'other-repo', branch: 'main' })
    expect(result.rejectedRepo).toBe('other-repo')
    expect(result.missing).toContain('repo')
  })

  it('用户指定的分支直接允许，不再做白名单校验', () => {
    const result = resolveDispatch({
      settings: settings(),
      chatId: 'oc_dev',
      branch: 'feature/x',
    })
    expect(result.branch).toBe('feature/x')
    expect(result.missing).toEqual([])
  })

  it('matchProject 支持项目名、选择器与 basename（大小写不敏感）', () => {
    const projects = [project(), project({ name: 'super-agent', repo: 'path:/Users/me/super-agent', defaultBranch: 'trunk' })]
    expect(matchProject(projects, 'router-agent')?.repo).toBe('name:dsh/router-agent')
    expect(matchProject(projects, 'name:dsh/router-agent')?.name).toBe('router-agent')
    expect(matchProject(projects, 'dsh/ROUTER-agent')?.name).toBe('router-agent')
    expect(matchProject(projects, '/Users/me/super-agent')?.name).toBe('super-agent')
  })

  it('activeDraft 只认同一个人、且不超过有效期', () => {
    const source = { getDispatchDraft: () => draft() }
    expect(activeDraft(source, 'oc_dev', 'ou_alice', '2026-11-06T10:10:00.000Z')?.task).toContain('登录超时')
    expect(activeDraft(source, 'oc_dev', 'ou_bob', '2026-11-06T10:10:00.000Z')).toBeNull()
    expect(activeDraft(source, 'oc_dev', 'ou_alice', '2026-11-06T11:00:00.000Z')).toBeNull()
  })

  it('dispatchSettingsOf 只认 projects，没有项目就是空清单', () => {
    expect(dispatchSettingsOf(defaultConfig()).projects).toEqual([])
    const base = defaultConfig()
    const config = {
      ...base,
      projects: [project()],
      feishu: { ...base.feishu, chats: [chatEntry('oc_dev', { repo: 'router-agent', branch: 'main' })] },
    }
    expect(dispatchSettingsOf(config).projects).toHaveLength(1)
    expect(dispatchSettingsOf(config).bindings).toHaveLength(1)
  })
})
describe('项目清单按后端隔离', () => {
  it('dispatchSettingsOf 跟随默认后端切换清单', () => {
    const base = defaultConfig()
    const orca = { ...base, projects: [project()] }
    expect(dispatchSettingsOf(orca).projects[0]?.repo).toBe('name:dsh/router-agent')

    const claude = {
      ...orca,
      backend: { default: 'claude-code', projects: { 'claude-code': [project({ repo: '/Users/me/router-agent' })] } },
    }
    expect(dispatchSettingsOf(claude).projects[0]?.repo).toBe('/Users/me/router-agent')
    // orca 清单没有被覆盖
    expect(claude.projects[0]?.repo).toBe('name:dsh/router-agent')
  })

  it('群绑定到其它后端的项目时要求重选，不把选择器当本地路径', () => {
    const result = resolveDispatch({
      settings: settings({
        projects: [project({ name: 'other', repo: '/Users/me/other' })],
        bindings: [{ chat: 'oc_dev', repo: 'router-agent', branch: 'main' }],
      }),
      chatId: 'oc_dev',
    })
    expect(result.rejectedRepo).toBe('router-agent')
    expect(result.missing).toContain('repo')
    expect(result.repo).toBe('')
  })
})
