/**
 * GitHub 订阅的事件类型目录。
 *
 * 面板的「监听内容」多选、服务端的过滤规则、事件的类型标签共用这一份目录，
 * 避免三处各写一套导致对不上。
 */

/** GitHub 事件的来源前缀：事件类型与幂等键都带它，跨来源一眼能分清。 */
export const GITHUB_EVENT_PREFIX = 'github'

/** 事件类别：Issue、PR、Action（工作流）。 */
export type GithubEventKind = 'issues' | 'pull_request' | 'workflow_run'

/** 一个可订阅的 GitHub 事件类型。 */
export interface GithubEventType {
  /** 订阅用的 id：`类别.动作`，例如 `issues.opened`。 */
  id: string
  kind: GithubEventKind
  /** GitHub 事件里的动作名（opened / closed / completed …）。 */
  action: string
  /** 面板上显示的人话。 */
  label: string
}

/** 全部事件类别；顺序即面板里的分组顺序。 */
export const GITHUB_EVENT_KINDS: readonly GithubEventKind[] = ['issues', 'pull_request', 'workflow_run']

/** 全部可订阅事件类型。 */
export const GITHUB_EVENT_TYPES: readonly GithubEventType[] = [
  { id: 'issues.opened', kind: 'issues', action: 'opened', label: 'Issue 新建' },
  { id: 'issues.reopened', kind: 'issues', action: 'reopened', label: 'Issue 重新打开' },
  { id: 'issues.edited', kind: 'issues', action: 'edited', label: 'Issue 更新' },
  { id: 'issues.closed', kind: 'issues', action: 'closed', label: 'Issue 关闭' },
  { id: 'issues.labeled', kind: 'issues', action: 'labeled', label: 'Issue 加标签' },
  { id: 'issues.commented', kind: 'issues', action: 'commented', label: 'Issue 评论' },
  { id: 'pull_request.opened', kind: 'pull_request', action: 'opened', label: 'PR 新建' },
  { id: 'pull_request.reopened', kind: 'pull_request', action: 'reopened', label: 'PR 重新打开' },
  { id: 'pull_request.edited', kind: 'pull_request', action: 'edited', label: 'PR 更新' },
  { id: 'pull_request.closed', kind: 'pull_request', action: 'closed', label: 'PR 关闭' },
  { id: 'pull_request.synchronize', kind: 'pull_request', action: 'synchronize', label: 'PR 有新提交' },
  { id: 'pull_request.reviewed', kind: 'pull_request', action: 'reviewed', label: 'PR 收到评审' },
  { id: 'pull_request.merged', kind: 'pull_request', action: 'merged', label: 'PR 已合并' },
  { id: 'pull_request.commented', kind: 'pull_request', action: 'commented', label: 'PR 评论' },
  { id: 'workflow_run.requested', kind: 'workflow_run', action: 'requested', label: 'Action 触发' },
  { id: 'workflow_run.success', kind: 'workflow_run', action: 'success', label: 'Action 执行成功' },
  { id: 'workflow_run.completed', kind: 'workflow_run', action: 'completed', label: 'Action 执行结束' },
  { id: 'workflow_run.failure', kind: 'workflow_run', action: 'failure', label: 'Action 执行失败' },
  { id: 'workflow_run.cancelled', kind: 'workflow_run', action: 'cancelled', label: 'Action 被取消' },
  { id: 'workflow_run.skipped', kind: 'workflow_run', action: 'skipped', label: 'Action 被跳过' },
  { id: 'workflow_run.action_required', kind: 'workflow_run', action: 'action_required', label: 'Action 需要人工处理' },
]

const TYPE_BY_ID = new Map(GITHUB_EVENT_TYPES.map(type => [type.id, type]))

/** 事件类型 id 是否在目录里。 */
export function isGithubEventType(value: unknown): boolean {
  return typeof value === 'string' && TYPE_BY_ID.has(value)
}

/** 事件类型的人话标签；不在目录里就原样返回（不猜）。 */
export function githubEventLabel(value: string): string {
  return TYPE_BY_ID.get(value)?.label ?? value
}

/**
 * 给 GitHub 的事件类型加来源前缀：`issues.opened` → `github.issues.opened`。
 *
 * 订阅配置里的类型 id 不带前缀（面板多选、用户已有配置都不受影响），
 * 只有落到事件队列里的类型才加 —— 不同来源的同名类型才不会混淆。
 */
export function withGithubPrefix(eventType: string): string {
  return `${GITHUB_EVENT_PREFIX}.${eventType}`
}

/** 按类别分组的事件类型；面板按组渲染多选。 */
export function githubEventTypesByKind(): Array<{ kind: GithubEventKind; label: string; types: GithubEventType[] }> {
  const labels: Record<GithubEventKind, string> = {
    issues: 'Issue',
    pull_request: 'Pull Request',
    workflow_run: 'Action',
  }
  return GITHUB_EVENT_KINDS.map(kind => ({
    kind,
    label: labels[kind],
    types: GITHUB_EVENT_TYPES.filter(type => type.kind === kind),
  }))
}
