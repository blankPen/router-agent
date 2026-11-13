import { describe, expect, it } from 'vitest'
import { projectIssue, projectPatchPath } from '../../src/web/client/config-shared.js'

describe('项目清单校验', () => {
  it('所有 runtime 统一要求本地仓库绝对路径', () => {
    expect(projectIssue([{ name: 'a', repo: '/Users/me/a', defaultBranch: 'main' }])).toBeNull()
    expect(projectIssue([{ name: 'a', repo: 'path:/Users/me/a', defaultBranch: 'main' }])).toBeNull()
    // Orca 的 name:/id: 选择器不再接受：项目路径统一成本地绝对路径。
    expect(projectIssue([{ name: 'a', repo: 'name:dsh/a', defaultBranch: 'main' }])).toContain('本地仓库绝对路径')
    expect(projectIssue([{ name: 'a', repo: 'id:abc', defaultBranch: 'main' }])).toContain('本地仓库绝对路径')
  })

  it('repo 必填', () => {
    expect(projectIssue([{ name: 'a', repo: '', defaultBranch: 'main' }])).toContain('repo')
  })

  it('orca 的清单仍写在顶层 projects，其它运行时写 runtime.projects', () => {
    expect(projectPatchPath('orca')).toBe('projects')
    expect(projectPatchPath('claude-code')).toBe('runtime.projects.claude-code')
  })
})
