/**
 * 面板侧「需求分析助手」的群级配置。
 *
 * 需求分析助手是群级能力：开关、追问轮数、终审管理员、是否读代码都跟着群走，
 * 一个群开了不影响别的群。这里只放面板草稿的形态与校验，
 * 真正的落盘校验在服务端（src/config.ts 的 validateChats）。
 */

/** 需求分析助手的群级配置（面板草稿形态）。 */
export interface ChatIntakeDraft {
  /** 是否在这个群开启需求分析助手。 */
  enabled: boolean
  /** 终审管理员：邮箱（推荐）或 open_id。 */
  approvers: string[]
  /** 最大对话轮次，默认 10。 */
  maxQuestions: number
  /** 是否允许助手只读项目代码。 */
  codeAccess: boolean
}

/** 默认配置：关闭、最多 10 轮、允许只读项目代码。 */
export const DEFAULT_CHAT_INTAKE: ChatIntakeDraft = {
  enabled: false,
  approvers: [],
  maxQuestions: 10,
  codeAccess: true,
}

/** 最大对话轮次上限：再大就会一直追问下去，反而收不敛。 */
export const MAX_INTAKE_QUESTIONS = 50

/** 配置校验：轮次必须是 0–50 的整数。 */
export function chatIntakeIssue(intake: ChatIntakeDraft | undefined): string | null {
  if (!intake) return null
  const rounds = Number(intake.maxQuestions)
  if (!Number.isInteger(rounds) || rounds < 0 || rounds > MAX_INTAKE_QUESTIONS) {
    return `最大对话轮次必须是 0–${MAX_INTAKE_QUESTIONS} 的整数`
  }
  return null
}

/** 归一成提交用的配置：去空白、丢空项。 */
export function normalizeChatIntake(intake: ChatIntakeDraft): ChatIntakeDraft {
  return {
    enabled: Boolean(intake.enabled),
    approvers: (intake.approvers ?? []).map(item => String(item).trim()).filter(Boolean),
    maxQuestions: Number(intake.maxQuestions),
    codeAccess: Boolean(intake.codeAccess),
  }
}
