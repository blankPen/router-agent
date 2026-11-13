/**
 * 配置页各模块共用的数据形状与校验。
 *
 * 单独成文件，避免「渠道面板 → app.tsx → 渠道注册表」形成循环依赖：
 * 渠道描述（channels.ts）与飞书专属面板（feishu-channel.tsx）都要用这里的类型。
 */
import { ORCA_RUNTIME_ID } from '#runtime/runtimes/catalog.js'
import { isProjectRepoPath } from '#runtime/runtimes/repo-path.js'
import type { ConfigDoc } from './api.js'
import { chatIntakeIssue, type ChatIntakeDraft } from './chat-intake.js'

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
  /** 群级「需求分析助手」配置；未配置时按默认值处理。 */
  intake?: ChatIntakeDraft
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

/** 项目清单校验：repo 必填，且所有 runtime 统一是本地仓库绝对路径。 */
export function projectIssue(projects: ProjectDraft[]): string | null {
  for (const project of projects) {
    if (!String(project.repo || '').trim()) return '每个项目都需要填写 repo'
    if (!isProjectRepoPath(project.repo)) {
      return 'repo 必须是本地仓库绝对路径（例如 /Users/me/project）；Orca 的 name:/id: 选择器不再支持'
    }
  }
  return null
}

export function chatsIssue(chats: unknown): string | null {
  if (!Array.isArray(chats)) return null
  for (const chat of chats as ChatDraft[]) {
    if (!String(chat.chat || '').trim()) return '每行都需要填写 chat_id'
    const intakeMessage = chatIntakeIssue(chat.intake)
    if (intakeMessage) return `${chat.chat || '群'}：${intakeMessage}`
  }
  return null
}
