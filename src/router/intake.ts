import type { Intake, IntakeKind, IntakeReport, Trigger } from '#core/model.js'
import { extractJsonObject } from './model-config.js'

/** 初筛结果。 */
export interface ScreenerVerdict {
  kind: IntakeKind
  reason: string
}

/** 分析 Agent 的三种输出。 */
export type AnalystOutcome =
  | { action: 'reply'; reply: string }
  | { action: 'answer'; reply: string }
  | { action: 'report'; reply: string; report: IntakeReport }

const KINDS: IntakeKind[] = ['chat', 'question', 'issue']

/** 解析初筛 JSON；格式不对时返回 null，由调用方按「不打扰用户」处理。 */
export function parseScreenerVerdict(text: string): ScreenerVerdict | null {
  const json = extractJsonObject(text)
  if (!json) return null
  const kind = String(json.kind ?? '') as IntakeKind
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
 * 终审关键词：管理员在需求单话题里回复这些词即视为通过。
 *
 * 不收「ok」「好」这类通用应答：一句「好」很容易是随口附和，
 * 把它当成派单确认等于让需求单在没人真正拍板的时候进了排期。
 */
export function isApprovalCommand(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, '')
  if (!normalized || normalized.length > 20) return false
  if (/不(用|需要|要)(派单|开单|处理|确认)|别(派单|开单)|驳回|拒绝|不用了|算了/.test(normalized)) return false
  return /^(确认派单|确认开单|确认|通过|同意|可以派单|派单|开工|开单|approve)$/i.test(normalized)
}

/** 驳回关键词；只认短句，避免把管理员的一段解释误判成驳回。 */
export function isRejectionCommand(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, '')
  if (!normalized || normalized.length > 30) return false
  return /^(驳回|拒绝|不需要|不用处理|不用派单|不派单|关闭|reject|close)$/i.test(normalized)
}

/** 发起人主动放弃澄清。 */
export function isDismissCommand(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, '')
  if (!normalized || normalized.length > 20) return false
  return /^(不用了|算了|没事了|不用管了|不问了|取消|cancel|nevermind|never mind)$/i.test(normalized)
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
