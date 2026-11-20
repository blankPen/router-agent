import type { Intake, IntakeReport, ScreenedKind, Trigger } from '#core/model.js'
import { extractJsonObject } from './model-config.js'

// 终审口令的实现在 commands.ts（与其它口令放在一起）；这里转出以保持既有 import 路径可用。
export { isApprovalCommand, isDismissCommand, isRejectionCommand } from './commands.js'

/**
 * 初筛结果。
 *
 * `kind` 是初筛模型能产出的类型，不含 `request`：管理员自己提的需求
 * 不经过初筛模型，由 Router 直接建会话（见 intake-flow.ts 的 startAdminRequest）。
 */
export interface ScreenerVerdict {
  kind: ScreenedKind
  reason: string
}

/** 分析 Agent 的三种输出。 */
export type AnalystOutcome =
  | { action: 'reply'; reply: string }
  | { action: 'answer'; reply: string }
  | { action: 'report'; reply: string; report: IntakeReport }

const KINDS: ScreenedKind[] = ['chat', 'question', 'issue']

/** 解析初筛 JSON；格式不对时返回 null，由调用方按「不打扰用户」处理。 */
export function parseScreenerVerdict(text: string): ScreenerVerdict | null {
  const json = extractJsonObject(text)
  if (!json) return null
  const kind = String(json.kind ?? '') as ScreenedKind
  if (!KINDS.includes(kind)) return null
  return { kind, reason: typeof json.reason === 'string' ? json.reason : '' }
}

/**
 * 解析分析 Agent 的 JSON。
 * 缺字段时按空字符串兜底，但 `action` 与 report 的 `title/problem` 必须存在，
 * 避免把半截报告当成正式需求单交给管理员。
 */
export function parseAnalystOutcome(text: string): AnalystOutcome | null {
  const json = extractJsonObject(text)
  if (!json) return null
  const reply = typeof json.reply === 'string' ? json.reply.trim() : ''
  const action = String(json.action ?? '')
  if (action === 'reply') return reply ? { action: 'reply', reply } : null
  // answer：用户问的是「怎么办」，直接给结论就结束，不产出需求单。
  if (action === 'answer') return reply ? { action: 'answer', reply } : null
  if (action !== 'report') return null
  const raw = json.report
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const field = (key: string): string => (typeof record[key] === 'string' ? String(record[key]).trim() : '')
  const title = field('title')
  const problem = field('problem')
  if (!title || !problem) return null
  return {
    action: 'report',
    reply,
    report: {
      title: title.slice(0, 60),
      problem,
      background: field('background'),
      steps: field('steps'),
      environment: field('environment'),
      impact: field('impact'),
      expected: field('expected'),
      assessment: field('assessment'),
    },
  }
}

/**
 * 结构化需求单的 Markdown 正文。
 * 既用于管理员终审消息，也作为终审通过后工单的授权范围（scope），
 * 保证 Worker 拿到的是同一份事实。
 */
export function formatIntakeReport(report: IntakeReport): string {
  const section = (label: string, value: string): string => `**${label}**：${value.trim() || '未收集到'}`
  return [
    `**标题**：${report.title}`,
    section('问题描述', report.problem),
    section('发生背景', report.background),
    section('复现步骤', report.steps),
    section('环境 / 账号', report.environment),
    section('影响范围', report.impact),
    section('预期效果', report.expected),
    section('初步判断', report.assessment),
  ].join('\n')
}

/** 管理员终审消息：带 @提醒、结构化需求单与操作口令。 */
export function formatReviewMessage(intake: Intake, mentions: string[]): string {
  const report = intake.report
  if (!report) return '需求单尚未整理完成。'
  const at = mentions.map(id => `<at id="${id}"></at>`).join(' ')
  return [
    at ? `${at} 有一条需求已澄清完毕，请确认是否派单。` : '有一条需求已澄清完毕，请确认是否派单。',
    '',
    formatIntakeReport(report),
    '',
    `需求单：${intake.id}　提出人：${intake.actorName || intake.actorId}`,
    `项目：${intake.project || '(未绑定)'}　起始分支：${intake.branch || '(未确定)'}`,
    '',
    '回复「确认派单」进入正式派单流程；回复「驳回」结束这条需求；也可以直接回复补充要求。',
  ].join('\n')
}

/** 给发起人的需求单收集完成提示：不承诺派单，等管理员确认。 */
export function formatSubmittedToUser(intake: Intake): string {
  return [
    '信息我这边整理好了，已经同步给管理员确认。',
    intake.report ? `需求单：${intake.report.title}` : '',
    '管理员确认后才会进入开发排期；如果有补充，直接在这里继续说即可。',
  ].filter(Boolean).join('\n')
}

/**
 * 分析 Agent 的输入：对话历史 + 本轮新消息 + 项目上下文。
 * 只放必要字段，代码由工具的 cwd 限定在项目目录里读取。
 */
export interface AnalystPromptInput {
  intake: Intake
  trigger: Trigger
  maxQuestions: number
  projectPath?: string
  readCode: boolean
}

export function buildAnalystUserPrompt(input: AnalystPromptInput): string {
  const { intake, trigger } = input
  return JSON.stringify({
    chat: { id: trigger.chatId, name: trigger.chatName },
    project: {
      name: intake.project,
      repo: intake.repo,
      branch: intake.branch,
      ...(input.projectPath ? { path: input.projectPath } : {}),
    },
    codeAccess: input.readCode && Boolean(input.projectPath),
    questionsAsked: intake.questions,
    maxQuestions: input.maxQuestions,
    // requester 决定收口方式：管理员自己的需求讨论完直接开单，
    // 普通成员的需求整理成需求单后交管理员终审。
    requester: intake.kind === 'request' ? 'admin' : 'member',
    reporter: { id: intake.actorId, name: intake.actorName },
    // 当前这条消息在分析前已经落进 turns，这里去掉重复的那条，只留更早的历史。
    history: intake.turns
      .filter(turn => !(turn.role === 'user' && turn.at === trigger.receivedAt && turn.text === trigger.text))
      .map(turn => ({ role: turn.role, text: turn.text, at: turn.at })),
    message: { text: trigger.text, addressed: trigger.addressed, at: trigger.receivedAt },
  }, null, 2)
}

/** 初筛输入：只给消息本身与少量上下文，控制成本。 */
export function buildScreenerUserPrompt(trigger: Trigger, recent: Array<{ role: string; text: string }> = []): string {
  return JSON.stringify({
    chat: { id: trigger.chatId, name: trigger.chatName },
    message: { text: trigger.text, addressed: trigger.addressed, at: trigger.receivedAt },
    recent: recent.slice(-4),
  }, null, 2)
}

/** 管理员终审通过后，工单标题与授权范围都来自同一份结构化需求单。 */
export function ticketFromIntake(intake: Intake): { title: string; scope: string } | null {
  const report = intake.report
  if (!report) return null
  return {
    title: report.title,
    scope: formatIntakeReport(report).replace(/\*\*/g, ''),
  }
}
