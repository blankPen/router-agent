import type { AppConfig, ChatBinding, ProjectConfig } from '../config.js'
import { projectsForRuntime } from '../config.js'
import type { DispatchDraft } from '#core/model.js'

/** 草稿的默认有效期：半小时内没补齐就当作新会话。 */
export const DRAFT_TTL_MS = 30 * 60_000

export interface DraftSource {
  getDispatchDraft(chatId: string, actorId: string): DispatchDraft | null
}

/** 取当前会话里仍然有效、且属于同一个人的派工草稿。 */
export function activeDraft(
  source: DraftSource,
  chatId: string,
  actorId: string,
  now: string,
  ttlMs: number = DRAFT_TTL_MS,
): DispatchDraft | null {
  const draft = source.getDispatchDraft(chatId, actorId)
  if (!draft || draft.actorId !== actorId) return null
  const updated = Date.parse(draft.updatedAt)
  const current = Date.parse(now)
  if (Number.isFinite(updated) && Number.isFinite(current) && current - updated > ttlMs) return null
  return draft
}

/** 派工需要的信息：项目（repo）与起始分支（branch）。 */
export interface DispatchSettings {
  projects: ProjectConfig[]
  bindings: ChatBinding[]
}

export type DispatchMissing = 'repo' | 'branch'

export interface ResolveDispatchInput {
  settings: DispatchSettings
  chatId: string
  /** 当前会话里未补齐的草稿（同一个人、同一次请求）。 */
  draft?: DispatchDraft | null
  /** 本条消息里明确说出的项目 / 分支（模型抽取）。 */
  repo?: string
  branch?: string
}

export interface DispatchResolution {
  /** 交给 Orca 的规范化 repo 选择器；缺失时为空字符串。 */
  repo: string
  branch: string
  project?: ProjectConfig
  missing: DispatchMissing[]
  /** 用户给了不在清单里的项目名，追问时要原样提示。 */
  rejectedRepo?: string
  /** 该群配置的绑定（追问时用来解释“为什么不问”）。 */
  binding?: ChatBinding
}

/** 配置折算成派工设置：项目清单按当前默认后端隔离；群绑定直接来自 feishu.chats 里带 repo 的条目。 */
export function dispatchSettingsOf(config: AppConfig): DispatchSettings {
  return {
    projects: projectsForRuntime(config),
    bindings: config.feishu.chats
      .filter(chat => chat.repo)
      .map(chat => ({ chat: chat.chat, repo: chat.repo, branch: chat.branch })),
  }
}

/**
 * 解析一次派工所需的 repo 与 branch。
 * 优先级：本条消息明确说的 > 群绑定 > 会话草稿 > 唯一的项目默认值。
 */
export function resolveDispatch(input: ResolveDispatchInput): DispatchResolution {
  const { settings, chatId, draft } = input
  const binding = settings.bindings.find(item => item.chat === chatId)
  const providedRepo = input.repo?.trim() ?? ''
  const providedBranch = input.branch?.trim() ?? ''

  let project: ProjectConfig | undefined
  let repo = ''
  let rejectedRepo = ''

  if (providedRepo) {
    project = matchProject(settings.projects, providedRepo)
    if (project) repo = project.repo
    else if (settings.projects.length === 0) repo = providedRepo
    else rejectedRepo = providedRepo
  }
  if (!repo && !rejectedRepo && binding?.repo) {
    project = matchProject(settings.projects, binding.repo)
    // 项目清单非空时，绑定名必须能在「当前后端」的清单里找到；
    // 否则宁可追问，也不要把 orca 的选择器直接交给 claude-code 当路径用。
    if (project) repo = project.repo
    else if (settings.projects.length === 0) repo = binding.repo
    else rejectedRepo = binding.repo
  }
  if (!repo && !rejectedRepo && draft?.repo) {
    project = matchProject(settings.projects, draft.repo)
    if (project) repo = project.repo
    else if (settings.projects.length === 0) repo = draft.repo
    else rejectedRepo = draft.repo
  }
  if (!repo && !rejectedRepo && settings.projects.length === 1) {
    project = settings.projects[0]
    repo = project!.repo
  }

  let branch = ''
  // 项目清单不再限制起始分支：用户指定什么就用什么，由 git 在创建 worktree 时校验。
  if (providedBranch) branch = providedBranch
  if (!branch && binding?.branch && (!binding.repo || sameRepo(binding.repo, repo, project))) branch = binding.branch
  if (!branch && draft?.branch && (!draft.repo || sameRepo(draft.repo, repo, project))) branch = draft.branch
  if (!branch && project?.defaultBranch) branch = project.defaultBranch

  const missing: DispatchMissing[] = []
  if (!repo) missing.push('repo')
  if (!branch) missing.push('branch')

  return {
    repo,
    branch,
    ...(project ? { project } : {}),
    missing,
    ...(rejectedRepo ? { rejectedRepo } : {}),
    ...(binding ? { binding } : {}),
  }
}

/** 在项目清单里找匹配项：项目名、完整选择器、或选择器最后一段。 */
export function matchProject(projects: ProjectConfig[], value: string): ProjectConfig | undefined {
  const want = normalizeRepo(value)
  if (!want) return undefined
  const exact = projects.find(project => normalizeRepo(project.name) === want || normalizeRepo(project.repo) === want)
  if (exact) return exact
  return projects.find(project => {
    const repo = normalizeRepo(project.repo)
    const name = normalizeRepo(project.name)
    return repo.split('/').at(-1) === want || name.split('/').at(-1) === want
  })
}

function sameRepo(value: string, repo: string, project?: ProjectConfig): boolean {
  if (!value || !repo) return false
  const left = normalizeRepo(value)
  return left === normalizeRepo(repo) || Boolean(project && left === normalizeRepo(project.name))
}

function normalizeRepo(value: string): string {
  return value.trim().replace(/^(id|name|path):/, '').replace(/\/+$/, '').toLowerCase()
}
