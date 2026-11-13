/**
 * 面板侧普通成员消息处理的群级配置。
 *
 * 要不要处理普通成员的消息由群的消息范围决定（仅接受管理员消息 = 不处理），
 * 这里只管处理细节：追问轮数、终审管理员、是否读代码，都跟着群走。
 * 这里只放面板草稿的形态与校验，
 * 真正的落盘校验在服务端（src/config.ts 的 validateChats）。
 */

/** 群级普通成员消息处理配置（面板草稿形态）。 */
export interface ChatMembersDraft {
  /** 终审管理员：邮箱（推荐）或 open_id。 */
  approvers: string[]
  /** 最大对话轮次，默认 10。 */
  maxQuestions: number
  /** 是否允许普通成员分析时只读项目代码。 */
  codeAccess: boolean
}

/** 默认配置：最多 10 轮、允许只读项目代码。 */
export const DEFAULT_CHAT_MEMBERS: ChatMembersDraft = {
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
    approvers: (members.approvers ?? []).map(item => String(item).trim()).filter(Boolean),
    maxQuestions: Number(members.maxQuestions),
    codeAccess: Boolean(members.codeAccess),
  }
}
