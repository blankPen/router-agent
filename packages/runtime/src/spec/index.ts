import type { Attachment, Ticket } from '@router-agent/core/model.js'
import { readWorkerSpec, workerSkillDir } from './reader.js'

/** 用户原始请求在首轮引导里的字数上限；超出时只给开头并指向落盘全文。 */
const REQUEST_MAX_CHARS = 2000
const BRIEF_MAX_LINES = 25

export interface WorkerPromptInput {
  ticket: Ticket
  mandateScope: string
  statePath: string
  eventsPath: string
  repo: string
  /** worktree 的起始分支（base branch）。 */
  branch?: string
  /** worktree 自己的工作分支（语义化命名）。 */
  workBranch?: string
  workdir?: string
  /** 发起人随消息发来的原始附件；默认取工单上的 attachments。 */
  attachments?: Attachment[]
  /** 状态目录；传入后优先读 `<home>/specs/worker/` 下的覆盖文件。 */
  home?: string
}

/** 注入给 worker 的完整首轮引导。 */
export function buildWorkerPrompt(input: WorkerPromptInput): string {
  return renderWorkerPrompt(input)
}

function renderWorkerPrompt(input: WorkerPromptInput): string {
  const template = readWorkerSpec(input.home, 'prompt-mode.md')
  return render(template, {
    ticketId: input.ticket.id,
    title: input.ticket.title,
    scope: input.mandateScope,
    statePath: input.statePath,
    eventsPath: input.eventsPath,
    repo: input.repo,
    branch: input.branch ?? input.ticket.branch ?? '(仓库默认分支)',
    workBranch: input.workBranch ?? `ra/${input.ticket.id}`,
    workdir: input.workdir ?? '(由 Orca 决定)',
    attachments: attachmentsSection(input.attachments ?? input.ticket.attachments ?? []),
  })
}

/** 运行时中立的工单契约：Claude CLI / Codex 等非 Orca 运行时使用。 */
export interface WorkerContractInput {
  ticketId: string
  title: string
  scope: string
  repo: string
  branch?: string
  workBranch?: string
  workdir?: string
  statePath: string
  eventsPath: string
  attachments?: Attachment[]
  /** 状态目录；传入后优先读 `<home>/specs/worker/` 下的覆盖文件。 */
  home?: string
}

export function buildNeutralContract(input: WorkerContractInput): string {
  return renderNeutralContract(input)
}

function renderNeutralContract(input: WorkerContractInput): string {
  const template = readWorkerSpec(input.home, 'contract.md')
  return render(template, {
    ticketId: input.ticketId,
    title: input.title,
    scope: input.scope,
    repo: input.repo,
    branch: input.branch ?? '(仓库默认分支)',
    workBranch: input.workBranch ?? `ra/${input.ticketId}`,
    workdir: input.workdir ?? '(由运行时决定)',
    statePath: input.statePath,
    eventsPath: input.eventsPath,
    attachments: attachmentsSection(input.attachments ?? []),
  })
}

/**
 * 原始附件段：把 Router 落盘的本地路径交给 Worker，让它直接看原图。
 * 没有附件时返回空字符串，模板里对应位置自然留空。
 */
function attachmentsSection(attachments: Attachment[]): string {
  if (attachments.length === 0) return ''
  const lines = attachments.map(item => `- \`${item.path}\`${item.quoted ? '（引用消息里的图片）' : ''}`)
  return [
    '## 附件图片（原图）',
    '',
    '发起人随消息发来了原始图片，Router 已落盘到本机。请直接用你的读图工具查看原图，',
    '不要只依赖 Router 的文字转写；图片里的细节以原图为准。',
    '',
    ...lines,
  ].join('\n')
}

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? '')
}

/**
 * 短引导：首轮只发工单事实 + 研判结论 + 用户原话 + 技能入口。
 *
 * 原来的整本手册（170+ 行）挤在首轮消息里，把工单信息压成三行；
 * 现在手册拆进技能目录按需读取，首轮控制在 25 行以内。
 */
export interface WorkerBriefInput {
  ticketId: string
  title: string
  /** 研判结论（mandate.scope）：可直接执行的授权范围。 */
  scope: string
  /** 发起人原始请求；需求的唯一依据。 */
  request?: string
  requestActorName?: string
  requestAt?: string
  repo: string
  branch?: string
  workBranch?: string
  workdir?: string
  /** worker 状态与报告目录。 */
  workerDir?: string
  /** 技能文件所在目录（`<RA_HOME>/specs/worker`）。 */
  skillDir?: string
  /** 技能指纹；用于 assignment meta 与 launch:skill 日志。 */
  skill?: { name: string; version: string; sha256: string }
  /** 落盘的原话全文路径；原话超长时给出。 */
  requestPath?: string
  attachments?: Attachment[]
}

export function buildWorkerBrief(input: WorkerBriefInput): string {
  const skillDir = input.skillDir ?? '(由 Router 给出)'
  const head: string[] = [
    `# RA Worker｜工单 ${input.ticketId}｜${input.title}`,
    '',
    '开工前必须先读技能文件（交付形态、上报命令、截图规范都在里面）：',
    skillDir,
    '',
    '## 工单',
    `- 项目 / 起始分支 / 工作分支：${input.repo} / ${input.branch ?? '(仓库默认分支)'} / ${input.workBranch ?? `ra/${input.ticketId}`}`,
    `- 工作目录：${input.workdir ?? '(以当前 cwd 为准)'}`,
    `- 授权范围（研判结论，可直接执行）：${input.scope}`,
    ...(input.workerDir ? [`- 状态与报告目录：${input.workerDir}`] : []),
  ]
  const tail = [
    '',
    '只对上面的请求负责；超出范围用 blocked 上报。',
    '每轮结束必须 ra reply（用法见 reply-protocol）。',
  ]
  const remaining = BRIEF_MAX_LINES - head.length - tail.length
  const requestMaxBody = Math.max(1, remaining - 4)
  const request = requestSection(input, requestMaxBody)
  const usedByRequest = request.length > 0 ? request.length + 1 : 0
  const attachmentMax = Math.max(0, remaining - usedByRequest - 7)
  const attachments = attachmentsSection((input.attachments ?? []).slice(0, attachmentMax))
  const lines = [...head]
  if (request.length > 0) lines.push('', ...request)
  if (attachments.length > 0) lines.push('', ...attachments)
  lines.push(...tail)
  return lines.join('\n')
}

/** 用户原始请求段：原话优先，冲突时以原话为准。 */
function requestSection(input: WorkerBriefInput, maxBodyLines: number): string[] {
  const raw = (input.request ?? '').trim()
  if (!raw) return []
  const who = input.requestActorName ?? ''
  const when = input.requestAt ?? ''
  let body = raw.length > REQUEST_MAX_CHARS
    ? `${raw.slice(0, REQUEST_MAX_CHARS)}\n…（已截断，全文见 ${input.requestPath ?? 'request.md'}）`
    : raw
  const bodyLines = body.split('\n')
  if (bodyLines.length > maxBodyLines) {
    body = [
      ...bodyLines.slice(0, Math.max(0, maxBodyLines - 1)),
      `…（已截断，全文见 ${input.requestPath ?? 'request.md'}）`,
    ].join('\n')
  }
  return [
    `## 用户原始请求（${who}${when ? `，${when}` : ''}）`,
    body,
    '（原话要求超出授权范围时用 blocked 上报；授权范围内的细节以原话为准。）',
  ]
}

export { ensureWorkerSkillDir, workerSkillDir, workerSkillSnapshot, type WorkerSkillSnapshot } from './reader.js'
