/**
 * 配置页各模块共用的数据形状与校验。
 *
 * 单独成文件，避免「渠道面板 → app.tsx → 渠道注册表」形成循环依赖：
 * 渠道描述（channels.ts）与飞书专属面板（feishu-channel.tsx）都要用这里的类型。
 */
import { ORCA_RUNTIME_ID } from '../../worker/runtimes/catalog.js'
import type { ConfigDoc } from './api.js'

export interface ProjectDraft {
  name: string
  repo: string
  defaultBranch: string
}

export interface ChatDraft {
  chat: string
  mode: string
  repo: string
  branch: string
  allowed: string[]
}

/** 项目清单按运行时隔离：orca 用顶层 projects，其它运行时用 runtime.projects.<id>。 */
export function projectPatchPath(runtimeId: string): string {
  return runtimeId === ORCA_RUNTIME_ID ? 'projects' : `runtime.projects.${runtimeId}`
}

export function projectsOf(doc: ConfigDoc, runtimeId: string): ProjectDraft[] {
  const list = runtimeId === ORCA_RUNTIME_ID
    ? doc.projects
    : doc.runtime?.projects?.[runtimeId]
  return Array.isArray(list) ? list as ProjectDraft[] : []
}

export function isLocalRepoPath(repo: string): boolean {
  return repo.trim().replace(/^path:/, '').startsWith('/')
}

/** 项目清单校验：repo 必填；非 orca 运行时必须是本地绝对路径。 */
export function projectIssue(runtimeId: string, projects: ProjectDraft[]): string | null {
  for (const project of projects) {
    if (!String(project.repo || '').trim()) return '每个项目都需要填写 repo'
    if (runtimeId !== ORCA_RUNTIME_ID && !isLocalRepoPath(project.repo)) {
      return 'repo 必须是本地仓库绝对路径（例如 /Users/me/project 或 path:/Users/me/project）'
    }
  }
  return null
}

export function chatsIssue(chats: unknown): string | null {
  if (!Array.isArray(chats)) return null
  for (const chat of chats as ChatDraft[]) {
    if (!String(chat.chat || '').trim()) return '每行都需要填写 chat_id'
  }
  return null
}
