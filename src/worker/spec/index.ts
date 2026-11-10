import type { Attachment, Ticket } from '../../core/model.js'
import { readWorkerSpec } from '../../specs/index.js'

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

/** 注入给 worker 的完整手册。 */
export function buildWorkerPrompt(input: WorkerPromptInput): string {
  const template = readSpec('prompt-mode.md', input.home)
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
  const template = readSpec('contract.md', input.home)
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

function readSpec(file: string, home?: string): string {
  return readWorkerSpec(home, file)
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
    '发起人随消息发来了原始图片，Router 已落盘到本机。请直接用 Read 工具查看原图，',
    '不要只依赖 Router 的文字转写；图片里的细节以原图为准。',
    '',
    ...lines,
  ].join('\n')
}

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? '')
}
