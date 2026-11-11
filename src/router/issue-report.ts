/**
 * 一键上报 GitHub issue。
 *
 * 助手判定「这是缺陷 / 体验问题」后，用户点一下就能把
 * 「问题描述 + 结论 + 证据日志」贴成一条 issue 发到仓库里，
 * 不用自己去 GitHub 上复制粘贴。
 *
 * 走 `gh` CLI：跟 PR 跟踪用同一套凭据与登录态，用户不用额外配置。
 */
import type { CommandRunner } from '../infra/process.js'
import { noopLogger, errorMessage, type Logger } from '../infra/logger.js'
import type { LogDiagnosis, LogEvidence } from './log-assistant.js'

/** 默认反馈仓库；可用 RA_ISSUE_REPO 覆盖。 */
export const DEFAULT_ISSUE_REPO = 'blankPen/router-agent'

export interface IssueResult {
  number: number
  url: string
}

export interface IssueReporter {
  /** 创建一条 issue；失败时抛错，由调用方转成 500。 */
  create(input: { title: string; body: string }): Promise<IssueResult>
}

export interface IssueReporterOptions {
  /** 已绑定 `gh` 的 runner。 */
  runner: CommandRunner
  /** owner/name 形式的仓库。 */
  repo?: string
  logger?: Logger
  /** 命令超时，默认 60s。 */
  timeoutMs?: number
}

export function createIssueReporter(opts: IssueReporterOptions): IssueReporter {
  const logger = opts.logger ?? noopLogger
  const repo = opts.repo ?? process.env.RA_ISSUE_REPO ?? DEFAULT_ISSUE_REPO
  const timeoutMs = opts.timeoutMs ?? 60_000

  return {
    async create(input: { title: string; body: string }): Promise<IssueResult> {
      const result = await opts.runner.run(
        ['issue', 'create', '--repo', repo, '--title', input.title, '--body-file', '-'],
        { input: input.body, timeoutMs },
      )
      if (result.code !== 0) {
        const reason = (result.stderr || result.stdout || '').trim().slice(0, 300)
        logger.error('issue:create-failed', { repo, code: result.code, detail: reason })
        throw new Error(`issue:create-failed: ${reason || `gh 退出码 ${result.code}`}`)
      }
      const url = result.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
      const number = Number(url.match(/\/(\d+)\s*$/)?.[1] ?? 0)
      logger.info('issue:created', { repo, number, title: input.title })
      return { number, url }
    },
  }
}

/**
 * 把一次排查结论拼成 issue 正文。
 *
 * 用户明确要求「把问题、日志直接反馈到 issue 里」，所以这里带上原始问题、
 * 结论、可能原因与证据日志；日志本身不含密钥（服务日志规范禁止记录密钥）。
 */
export function buildIssueBody(input: {
  question: string
  diagnosis: LogDiagnosis
  version?: string
}): string {
  const { question, diagnosis } = input
  const lines: string[] = []
  lines.push('## 问题描述')
  lines.push('')
  lines.push(question.trim() || '（用户没有填写问题描述，由 Web 面板的智能排查助手发起）')
  lines.push('')
  lines.push('## 排查结论')
  lines.push('')
  lines.push(diagnosis.summary)
  lines.push('')
  if (diagnosis.causes.length > 0) {
    lines.push('### 可能原因')
    lines.push('')
    for (const cause of diagnosis.causes) {
      lines.push(`- **${cause.title}**${cause.detail ? `：${cause.detail}` : ''}`)
      if (cause.events.length > 0) lines.push(`  - 相关事件：${cause.events.map(item => `\`${item}\``).join('、')}`)
    }
    lines.push('')
  }
  if (diagnosis.actions.length > 0) {
    lines.push('### 建议的下一步')
    lines.push('')
    for (const action of diagnosis.actions) lines.push(`- ${action}`)
    lines.push('')
  }
  lines.push('## 证据日志')
  lines.push('')
  if (diagnosis.evidence.length > 0) {
    lines.push('```text')
    for (const item of diagnosis.evidence) lines.push(formatEvidenceLine(item))
    lines.push('```')
  } else {
    lines.push('（没有匹配到日志条目）')
  }
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(`由 router-agent Web 面板的智能排查助手生成${input.version ? `；版本 v${input.version}` : ''}。`)
  return lines.join('\n')
}

function formatEvidenceLine(item: LogEvidence): string {
  const fields = item.detail ?? ''
  return `${item.at || '-'} ${item.level.toUpperCase()} ${item.message}${fields ? ` ${fields}` : ''}`
}

/** 从错误信息里兜出可读原因；给 API 层用。 */
export function issueErrorMessage(error: unknown): string {
  return errorMessage(error)
}
