/**
 * 一键上报 GitHub issue。
 *
 * 助手判定「这是缺陷 / 体验问题」后，用户点一下就能把
 * 「问题描述 + 结论 + 证据日志」贴成一条 issue 发到仓库里，
 * 不用自己去 GitHub 上复制粘贴。
 *
 * 走 `gh` CLI：跟 PR 跟踪用同一套凭据与登录态，用户不用额外配置。
 */
import type { CommandRunner } from '#infra/process.js'
import { noopLogger, errorMessage, type Logger } from '#infra/logger.js'
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
        throw new Error(`issue:create-failed: ${explainFailure(result.code, reason)}`)
      }
      const url = result.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
      const number = Number(url.match(/\/(\d+)\s*$/)?.[1] ?? 0)
      logger.info('issue:created', { repo, number, title: input.title })
      return { number, url }
    },
  }
}

/**
 * 把 `gh` 的失败翻译成人能直接照做的中文提示。
 *
 * 裸的英文报错（`spawn gh ENOENT` / `HTTP 401: Bad credentials`）用户看不懂，
 * 也不知道下一步该干什么。这里按失败类型给出具体动作，
 * 认不出来的就把原始报错带出来，不吞信息。
 */
export function explainFailure(code: number, reason: string): string {
  const text = reason.trim()
  // 没装 gh：spawn 直接 ENOENT，退出码 127。
  if (code === 127 || /ENOENT|command not found|not found/i.test(text)) {
    return `未找到 gh 命令，请先安装 GitHub CLI（brew install gh）后重试${text ? `：${text}` : ''}`
  }
  // 凭据无效要先判：它的提示里也带 gh auth login，混进「未登录」会看不出是 token 过期。
  if (/HTTP 401|Bad credentials/i.test(text)) {
    return `GitHub 凭据无效，请重新执行 gh auth login 登录${text ? `：${text}` : ''}`
  }
  if (/not logged in|gh auth login/i.test(text)) {
    return `gh 未登录，请先执行 gh auth login 登录 GitHub${text ? `：${text}` : ''}`
  }
  if (/HTTP 403|Resource not accessible|Permission denied/i.test(text)) {
    return `当前账号没有该仓库的创建权限，请换用有权限的账号或改 RA_ISSUE_REPO 指向可用仓库${text ? `：${text}` : ''}`
  }
  if (/Could not resolve to a Repository|not found/i.test(text)) {
    return `仓库不存在或无权访问，请检查 RA_ISSUE_REPO 配置${text ? `：${text}` : ''}`
  }
  return text || `gh 退出码 ${code}`
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
    // 错误日志单独提到最前面：用户上报 issue 就是冲着错误来的，
    // 混在几十条 info 里等于没有。
    const errors = diagnosis.evidence.filter(item => item.level === 'error')
    if (errors.length > 0) {
      lines.push('### 错误日志')
      lines.push('')
      lines.push('```text')
      for (const item of errors) lines.push(formatEvidenceLine(item))
      lines.push('```')
      lines.push('')
    }
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
