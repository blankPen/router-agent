import { describe, expect, it } from 'vitest'
import { buildIssueBody, createIssueReporter, explainFailure, DEFAULT_ISSUE_REPO } from '../../src/router/issue-report.js'
import type { CommandRunner } from '../../src/infra/process.js'
import type { Logger } from '../../src/infra/logger.js'
import type { LogDiagnosis } from '../../src/router/log-assistant.js'

function captureLogger(): { logger: Logger; events: { level: string; message: string; extra: Record<string, unknown> }[] } {
  const events: { level: string; message: string; extra: Record<string, unknown> }[] = []
  const push = (level: string) => (message: string, extra: Record<string, unknown> = {}) => {
    events.push({ level, message, extra })
  }
  return { events, logger: { info: push('info'), warn: push('warn'), error: push('error') } }
}

const diagnosis: LogDiagnosis = {
  summary: '消息被允许名单挡掉了',
  causes: [{ title: '允许名单没解析出来', detail: 'trigger:dropped reason=not-allowed', events: ['trigger:dropped'] }],
  actions: ['检查允许名单里的邮箱'],
  evidence: [{ at: '2026-11-09T10:01:00.000Z', level: 'warn', message: 'trigger:dropped', detail: 'reason=not-allowed' }],
  source: 'rules',
}

function runner(result: { code: number; stdout: string; stderr: string }): {
  run: CommandRunner
  calls: { argv: string[]; input?: string }[]
} {
  const calls: { argv: string[]; input?: string }[] = []
  return {
    calls,
    run: {
      async run(argv, opts) {
        calls.push({ argv, ...(opts?.input !== undefined ? { input: opts.input } : {}) })
        return result
      },
    },
  }
}

describe('buildIssueBody', () => {
  it('带上问题、结论、原因、建议与证据日志', () => {
    const body = buildIssueBody({ question: '机器人没反应', diagnosis, version: '0.3.17' })
    expect(body).toContain('## 问题描述')
    expect(body).toContain('机器人没反应')
    expect(body).toContain('消息被允许名单挡掉了')
    expect(body).toContain('允许名单没解析出来')
    expect(body).toContain('检查允许名单里的邮箱')
    expect(body).toContain('## 证据日志')
    expect(body).toContain('trigger:dropped')
    expect(body).toContain('v0.3.17')
  })

  it('没有证据时如实说明', () => {
    const body = buildIssueBody({
      question: '',
      diagnosis: { ...diagnosis, evidence: [] },
    })
    expect(body).toContain('（没有匹配到日志条目）')
    expect(body).toContain('由 router-agent Web 面板')
  })

  it('错误日志单独提到证据最前面', () => {
    const body = buildIssueBody({
      question: 'worker 卡住了',
      diagnosis: {
        ...diagnosis,
        evidence: [
          { at: '2026-11-09T10:00:00.000Z', level: 'info', message: 'launch', detail: 'ticketId=tk-1' },
          { at: '2026-11-09T10:00:01.000Z', level: 'error', message: 'effect:failed', detail: 'error=boom' },
        ],
      },
    })
    expect(body).toContain('### 错误日志')
    // 错误段落里先出现 effect:failed，再出现完整证据里的 launch。
    expect(body.indexOf('### 错误日志')).toBeLessThan(body.indexOf('effect:failed'))
    expect(body.indexOf('effect:failed')).toBeLessThan(body.indexOf('## 证据日志') + 200)
  })
})

describe('explainFailure', () => {
  it('没装 gh 时给出安装指引', () => {
    expect(explainFailure(127, 'spawn gh ENOENT')).toContain('未找到 gh 命令')
    expect(explainFailure(127, 'spawn gh ENOENT')).toContain('brew install gh')
  })

  it('没登录时给出登录指引', () => {
    const message = explainFailure(1, 'You are not logged into any GitHub hosts. To log in, run: gh auth login')
    expect(message).toContain('gh 未登录')
    expect(message).toContain('gh auth login')
  })

  it('凭据无效时提示重新登录', () => {
    expect(explainFailure(1, 'HTTP 401: Bad credentials')).toContain('凭据无效')
    // 401 的提示里也带 gh auth login，不能被归到「未登录」那一档。
    expect(explainFailure(1, 'HTTP 401: Bad credentials\nTry authenticating with: gh auth login -h github.com'))
      .toContain('凭据无效')
  })

  it('权限不足时提示换账号或改仓库', () => {
    expect(explainFailure(1, 'HTTP 403: Resource not accessible by integration'))
      .toContain('没有该仓库的创建权限')
  })

  it('仓库不存在时提示检查 RA_ISSUE_REPO', () => {
    expect(explainFailure(1, "Could not resolve to a Repository with the name 'a/b'"))
      .toContain('RA_ISSUE_REPO')
  })

  it('认不出来的失败保留原始报错，不吞信息', () => {
    expect(explainFailure(1, 'something unexpected happened')).toContain('something unexpected happened')
    expect(explainFailure(2, '')).toContain('gh 退出码 2')
  })
})

describe('createIssueReporter', () => {
  it('用 gh issue create 把正文从标准输入送进去', async () => {
    const gh = runner({ code: 0, stdout: 'https://github.com/blankPen/router-agent/issues/42\n', stderr: '' })
    const reporter = createIssueReporter({ runner: gh.run })

    const issue = await reporter.create({ title: '标题', body: '正文内容' })

    expect(gh.calls[0]?.argv).toEqual([
      'issue', 'create', '--repo', DEFAULT_ISSUE_REPO, '--title', '标题', '--body-file', '-',
    ])
    expect(gh.calls[0]?.input).toBe('正文内容')
    expect(issue).toEqual({ number: 42, url: 'https://github.com/blankPen/router-agent/issues/42' })
  })

  it('gh 失败时抛出带原因的错误', async () => {
    const gh = runner({ code: 1, stdout: '', stderr: 'not authenticated' })
    const reporter = createIssueReporter({ runner: gh.run })

    await expect(reporter.create({ title: '标题', body: '正文' })).rejects.toThrow(/not authenticated/)
  })

  it('可以用 RA_ISSUE_REPO 换仓库', async () => {
    const gh = runner({ code: 0, stdout: 'https://github.com/other/repo/issues/1\n', stderr: '' })
    const reporter = createIssueReporter({ runner: gh.run, repo: 'other/repo' })

    await reporter.create({ title: '标题', body: '正文' })

    expect(gh.calls[0]?.argv).toContain('other/repo')
  })

  it('成功时记录 issue:created 事件', async () => {
    const gh = runner({ code: 0, stdout: 'https://github.com/blankPen/router-agent/issues/42\n', stderr: '' })
    const { logger, events } = captureLogger()
    const reporter = createIssueReporter({ runner: gh.run, logger })

    await reporter.create({ title: '标题', body: '正文' })

    const event = events.find(item => item.message === 'issue:created')
    expect(event?.level).toBe('info')
    expect(event?.extra.repo).toBe(DEFAULT_ISSUE_REPO)
    expect(event?.extra.number).toBe(42)
  })

  it('失败时记录 issue:create-failed 事件并带上原因', async () => {
    const gh = runner({ code: 1, stdout: '', stderr: 'not authenticated' })
    const { logger, events } = captureLogger()
    const reporter = createIssueReporter({ runner: gh.run, logger })

    await expect(reporter.create({ title: '标题', body: '正文' })).rejects.toThrow()

    const event = events.find(item => item.message === 'issue:create-failed')
    expect(event?.level).toBe('error')
    expect(event?.extra.repo).toBe(DEFAULT_ISSUE_REPO)
    expect(event?.extra.code).toBe(1)
    expect(String(event?.extra.detail)).toContain('not authenticated')
  })
})
