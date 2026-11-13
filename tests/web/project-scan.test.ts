import { describe, expect, it } from 'vitest'
import { defaultSelectedPaths, mergeImportedProjects, type ScanCandidate } from '../../src/web/client/project-scan.js'

function candidate(overrides: Partial<ScanCandidate> = {}): ScanCandidate {
  return {
    path: '/Users/me/project',
    name: 'project',
    sources: ['claude'],
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('扫描本地项目', () => {
  it('默认勾选最近活跃的 5 个 Git 项目', () => {
    const candidates = Array.from({ length: 8 }, (_, index) => candidate({
      path: `/Users/me/p${index}`,
      lastActiveAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    }))

    expect(defaultSelectedPaths(candidates)).toEqual([
      '/Users/me/p7',
      '/Users/me/p6',
      '/Users/me/p5',
      '/Users/me/p4',
      '/Users/me/p3',
    ])
  })

  it('Git 项目不足 5 个时全部勾选', () => {
    const candidates = [candidate({ path: '/Users/me/a' }), candidate({ path: '/Users/me/b' })]

    expect(defaultSelectedPaths(candidates)).toEqual(['/Users/me/a', '/Users/me/b'])
  })

  it('导入时跳过路径重复的项目', () => {
    const existing = [{ name: 'a', repo: '/Users/me/a', defaultBranch: 'main' }]

    const merged = mergeImportedProjects(existing, [{ name: 'a', repo: '/Users/me/a', defaultBranch: 'main' }])

    expect(merged).toHaveLength(1)
  })

  it('项目名撞了自动加序号', () => {
    const existing = [{ name: 'alpha', repo: '/Users/me/alpha', defaultBranch: 'main' }]

    const merged = mergeImportedProjects(existing, [{ name: 'alpha', repo: '/Users/me/other/alpha', defaultBranch: '' }])

    expect(merged[1]).toEqual({ name: 'alpha-2', repo: '/Users/me/other/alpha', defaultBranch: '' })
  })

  it('导入不会改动原数组', () => {
    const existing = [{ name: 'a', repo: '/Users/me/a', defaultBranch: 'main' }]

    mergeImportedProjects(existing, [{ name: 'b', repo: '/Users/me/b', defaultBranch: '' }])

    expect(existing).toHaveLength(1)
  })
})
