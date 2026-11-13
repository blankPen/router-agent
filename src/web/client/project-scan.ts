/**
 * 「扫描本地项目」的纯逻辑：默认勾选与导入合并。
 *
 * 单独成文件，好在没有 DOM 的情况下写单测。
 */
import type { ProjectDraft } from './config-shared.js'

/** 服务端扫出来的候选项目。 */
export interface ScanCandidate {
  path: string
  name: string
  sources: string[]
  lastActiveAt: string
  isGit: boolean
}

/** 默认勾选最近活跃的 N 个 Git 项目；非 Git 目录不能创建 worktree，不进默认勾选。 */
export function defaultSelectedPaths(candidates: ScanCandidate[], limit = 5): string[] {
  return [...candidates]
    .filter(candidate => candidate.isGit)
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
    .slice(0, limit)
    .map(candidate => candidate.path)
}

/**
 * 把导入的项目并进清单：跳过路径重复的，项目名撞了就加序号。
 * 返回新数组，不改原数组。
 */
export function mergeImportedProjects(existing: ProjectDraft[], imported: ProjectDraft[]): ProjectDraft[] {
  const result = [...existing]
  const names = new Set(result.map(project => project.name))
  const repos = new Set(result.map(project => project.repo))
  for (const project of imported) {
    if (repos.has(project.repo)) continue
    let name = project.name
    let index = 2
    while (names.has(name)) {
      name = `${project.name}-${index}`
      index += 1
    }
    names.add(name)
    repos.add(project.repo)
    result.push({ ...project, name })
  }
  return result
}
