/**
 * 配置页各模块共用的数据形状与校验。
 *
 * 单独成文件，避免「渠道面板 → app.tsx → 渠道注册表」形成循环依赖：
 * 渠道描述（channels.ts）与飞书专属面板（feishu-channel.tsx）都要用这里的类型。
 */
import { ORCA_RUNTIME_ID } from '#runtime/runtimes/catalog.js'
import { isProjectRepoPath } from '#runtime/runtimes/repo-path.js'
import type { ConfigDoc } from './api.js'
import { chatMembersIssue, type ChatMembersDraft } from './chat-members.js'

export interface ProjectDraft {
  name: string
  repo: string
  defaultBranch: string
}

export interface ChatDraft {
  chat: string
  /** 消息处理范围：仅接受管理员消息 / 接受普通用户@消息 / 接受所有消息。 */
  scope: 'admins' | 'mention' | 'all'
  repo: string
  branch: string
  /** 本群的管理员扩充：在全局默认管理员之外再加这些人。 */
  allowed: string[]
  /** 群级普通成员消息处理配置；未配置时按默认值处理。 */
  members?: ChatMembersDraft
}

/** 消息范围的中文标签，面板与文档共用一套说法。 */
export const CHAT_SCOPE_LABELS: Record<ChatDraft['scope'], string> = {
  admins: '仅接受管理员消息',
  mention: '接受普通用户@消息',
  all: '接受所有消息',
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
    const membersMessage = chatMembersIssue(chat.members)
    if (membersMessage) return `${chat.chat || '群'}：${membersMessage}`
  }
  return null
}
