/** 草稿的默认有效期：半小时内没补齐就当作新会话。 */
export const DRAFT_TTL_MS = 30 * 60_000;
/** 取当前会话里仍然有效、且属于同一个人的派工草稿。 */
export function activeDraft(source, chatId, actorId, now, ttlMs = DRAFT_TTL_MS) {
    const draft = source.getDispatchDraft(chatId);
    if (!draft || draft.actorId !== actorId)
        return null;
    const updated = Date.parse(draft.updatedAt);
    const current = Date.parse(now);
    if (Number.isFinite(updated) && Number.isFinite(current) && current - updated > ttlMs)
        return null;
    return draft;
}
/** 配置折算成派工设置：群绑定直接来自 feishu.chats 里带 repo 的条目。 */
export function dispatchSettingsOf(config) {
    return {
        projects: config.projects,
        bindings: config.feishu.chats
            .filter(chat => chat.repo)
            .map(chat => ({ chat: chat.chat, repo: chat.repo, branch: chat.branch })),
    };
}
/**
 * 解析一次派工所需的 repo 与 branch。
 * 优先级：本条消息明确说的 > 群绑定 > 会话草稿 > 唯一的项目默认值。
 */
export function resolveDispatch(input) {
    const { settings, chatId, draft } = input;
    const binding = settings.bindings.find(item => item.chat === chatId);
    const providedRepo = input.repo?.trim() ?? '';
    const providedBranch = input.branch?.trim() ?? '';
    let project;
    let repo = '';
    let rejectedRepo = '';
    if (providedRepo) {
        project = matchProject(settings.projects, providedRepo);
        if (project)
            repo = project.repo;
        else if (settings.projects.length === 0)
            repo = providedRepo;
        else
            rejectedRepo = providedRepo;
    }
    if (!repo && !rejectedRepo && binding?.repo) {
        project = matchProject(settings.projects, binding.repo);
        repo = project?.repo ?? binding.repo;
    }
    if (!repo && !rejectedRepo && draft?.repo) {
        project = matchProject(settings.projects, draft.repo);
        repo = project?.repo ?? draft.repo;
    }
    if (!repo && !rejectedRepo && settings.projects.length === 1) {
        project = settings.projects[0];
        repo = project.repo;
    }
    let branch = '';
    let rejectedBranch = '';
    if (providedBranch) {
        if (project && project.branches.length > 0 && !project.branches.includes(providedBranch))
            rejectedBranch = providedBranch;
        else
            branch = providedBranch;
    }
    if (!branch && !rejectedBranch && binding?.branch && (!binding.repo || sameRepo(binding.repo, repo, project)))
        branch = binding.branch;
    if (!branch && !rejectedBranch && draft?.branch && (!draft.repo || sameRepo(draft.repo, repo, project)))
        branch = draft.branch;
    if (!branch && !rejectedBranch && project?.defaultBranch)
        branch = project.defaultBranch;
    const missing = [];
    if (!repo)
        missing.push('repo');
    if (!branch)
        missing.push('branch');
    return {
        repo,
        branch,
        ...(project ? { project } : {}),
        missing,
        ...(rejectedRepo ? { rejectedRepo } : {}),
        ...(rejectedBranch ? { rejectedBranch } : {}),
        ...(binding ? { binding } : {}),
    };
}
/** 在项目清单里找匹配项：项目名、完整选择器、或选择器最后一段。 */
export function matchProject(projects, value) {
    const want = normalizeRepo(value);
    if (!want)
        return undefined;
    const exact = projects.find(project => normalizeRepo(project.name) === want || normalizeRepo(project.repo) === want);
    if (exact)
        return exact;
    return projects.find(project => {
        const repo = normalizeRepo(project.repo);
        const name = normalizeRepo(project.name);
        return repo.split('/').at(-1) === want || name.split('/').at(-1) === want;
    });
}
function sameRepo(value, repo, project) {
    if (!value || !repo)
        return false;
    const left = normalizeRepo(value);
    return left === normalizeRepo(repo) || Boolean(project && left === normalizeRepo(project.name));
}
function normalizeRepo(value) {
    return value.trim().replace(/^(id|name|path):/, '').replace(/\/+$/, '').toLowerCase();
}
//# sourceMappingURL=dispatch.js.map