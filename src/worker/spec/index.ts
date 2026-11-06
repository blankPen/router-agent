import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Ticket } from '../../core/model.js'

export type WorkerSpecMode = 'prompt' | 'agent'

export interface WorkerPromptInput {
  mode: WorkerSpecMode
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
}

/** 注入给 worker 的完整手册（prompt 模式）或简短指令（agent 模式）。 */
export function buildWorkerPrompt(input: WorkerPromptInput): string {
  const file = input.mode === 'agent' ? 'agent-mode.md' : 'prompt-mode.md'
  const template = readSpec(file)
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
  })
}

function readSpec(file: string): string {
  return readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8')
}

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? '')
}

/** agent 模式的全局规范文件内容，供 `ra init` 写入 ~/.claude/agents/。 */
export function agentSpecDocument(): string {
  return `---
name: router-agent-worker
description: router-agent 派出的工单 worker；按 router-agent 的状态上报协议工作
tools: Read, Write, Edit, Bash, Glob, Grep
---

${readSpec('prompt-mode.md')}
`
}
