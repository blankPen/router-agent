/**
 * 工具范围：权限与工具是硬边界，从工具层强制。
 * 装配时按 toolScope 过滤工具，执行时校验发送人身份；模型与提示词都改不了这层。
 */

/** 管理员全量（含工单查看 / 管理、建单、派工）；普通成员只读分析。 */
export type ToolScope = 'admin-full' | 'member-analysis-read'

/** 工具定义里的角色要求；缺省按最保守（admin）处理。 */
export type ToolRequirement = 'admin' | 'member' | 'all'

export interface ToolAuthz {
  name: string
  requires: ToolRequirement
}

/** 身份 → 工具范围。 */
export function toolScopeFor(isAdmin: boolean): ToolScope {
  return isAdmin ? 'admin-full' : 'member-analysis-read'
}

/**
 * 普通成员只读工具；写操作与工单查看 / 管理工具一律不在列表里。
 * 普通成员看不到工单：需求由管理员终审后才成单，成员没有查看与操作工单的入口。
 */
export const MEMBER_READ_TOOLS = ['router_context'] as const

function requirementSatisfied(scope: ToolScope, requires: ToolRequirement): boolean {
  if (requires === 'all') return true
  if (scope === 'admin-full') return true
  return requires === 'member'
}

/** 按工具范围装配白名单。 */
export function allowedTools(scope: ToolScope, tools: ToolAuthz[]): string[] {
  return tools.filter(tool => requirementSatisfied(scope, tool.requires)).map(tool => tool.name)
}
