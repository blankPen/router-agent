/**
 * 面板侧「处理普通成员消息」的群级配置。
 *
 * 只有群级开关这一个入口：Router 要不要处理本群非授权用户的消息。
 * 追问轮数、终审管理员、是否读代码都跟着群走，一个群开了不影响别的群。
 * 这里只放面板草稿的形态与校验，
 * 真正的落盘校验在服务端（src/config.ts 的 validateChats）。
 */

/** 群级「处理普通成员消息」配置（面板草稿形态）。 */
export interface ChatMembersDraft {
  /** 是否在这个群处理普通成员的消息。 */
  enabled: boolean
  /** 终审管理员：邮箱（推荐）或 open_id。 */
  approvers: string[]
  /** 最大对话轮次，默认 10。 */
  maxQuestions: number
  /** 是否允许普通成员分析时只读项目代码。 */
  codeAccess: boolean
}

/** 默认配置：关闭、最多 10 轮、允许只读项目代码。 */
export const DEFAULT_CHAT_MEMBERS: ChatMembersDraft = {
  enabled: false,
  approvers: [],
  maxQuestions: 10,
  codeAccess: true,
}

/** 最大对话轮次上限：再大就会一直追问下去，反而收不敛。 */
export const MAX_MEMBER_QUESTIONS = 50

/** 配置校验：轮次必须是 0–50 的整数。 */
export function chatMembersIssue(members: ChatMembersDraft | undefined): string | null {
  if (!members) return null
  const rounds = Number(members.maxQuestions)
  if (!Number.isInteger(rounds) || rounds < 0 || rounds > MAX_MEMBER_QUESTIONS) {
    return `最大对话轮次必须是 0–${MAX_MEMBER_QUESTIONS} 的整数`
  }
  return null
}

/** 归一成提交用的配置：去空白、丢空项。 */
export function normalizeChatMembers(members: ChatMembersDraft): ChatMembersDraft {
  return {
    enabled: Boolean(members.enabled),
    approvers: (members.approvers ?? []).map(item => String(item).trim()).filter(Boolean),
    maxQuestions: Number(members.maxQuestions),
    codeAccess: Boolean(members.codeAccess),
  }
}
