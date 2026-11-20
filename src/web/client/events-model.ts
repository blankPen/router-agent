/**
 * 收件箱（事件队列）的判定逻辑：哪些操作可以直接做，哪些要先补信息。
 *
 * 单独放在 .ts 里，方便直接测这些规则，不必拉起整棵 React 树。
 */

/** 面板上能选的归属项目。 */
export interface ProjectOption {
  name: string
  repo: string
}

/** 事件行里跟「批准」有关的字段。 */
export interface ApprovableEvent {
  project?: string
  status: string
}

/**
 * 批准前要不要先选归属项目。
 *
 * 没判定出项目的事件，批准开不出单（工单必须绑定项目），
 * 这时面板要先让用户选项目，而不是点一下没反应。
 */
export function needsProjectForApprove(event: ApprovableEvent): boolean {
  return event.status === 'review' && !event.project?.trim()
}

/** 批准要提交的动作参数；没有项目时带上用户选的项目。 */
export function approvePayload(project: string): { action: 'approve'; project?: string } {
  const name = project.trim()
  return name ? { action: 'approve', project: name } : { action: 'approve' }
}

/** 项目下拉框的选项：项目名 + 仓库，仓库相同的按名字排。 */
export function projectOptions(projects: ProjectOption[]): ProjectOption[] {
  return [...projects].sort((a, b) => a.name.localeCompare(b.name))
}
