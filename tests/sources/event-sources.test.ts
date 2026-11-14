import { describe, expect, it } from 'vitest'
import {
  ghIssueListCommand,
  parseIssueList,
  verifyGithubSignature,
  mapGithubWebhook,
} from '../../src/sources/event-github.js'
import { mapWebhookPayload } from '../../src/sources/event-webhook.js'
import { cronMatches, nextCronTime } from '../../src/sources/event-cron.js'

describe('GitHub Issue 轮询', () => {
  it('命令带上仓库白名单与增量游标', () => {
    const argv = ghIssueListCommand('blankPen/router-agent', 'open', 'updated:>2026-11-01T00:00:00Z', ['bug'], 50)
    expect(argv).toContain('issue')
    expect(argv).toContain('list')
    expect(argv).toContain('--repo')
    expect(argv).toContain('blankPen/router-agent')
    expect(argv).toContain('--state')
    expect(argv).toContain('open')
    expect(argv).toContain('--search')
    expect(argv).toContain('updated:>2026-11-01T00:00:00Z')
    expect(argv).toContain('--label')
    expect(argv).toContain('bug')
  })

  it('解析 issue 列表并保留更新时刻与作者', () => {
    const stdout = JSON.stringify([
      { number: 12, title: '导出失败', body: '正文', url: 'https://github.com/a/b/issues/12', updatedAt: '2026-11-10T00:00:00Z', author: { login: 'ghost' }, labels: [{ name: 'bug' }] },
    ])
    const issues = parseIssueList(stdout)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.number).toBe(12)
    expect(issues[0]?.updatedAt).toBe('2026-11-10T00:00:00Z')
    expect(issues[0]?.author).toBe('ghost')
  })

  it('输出不是合法 JSON 时返回空列表', () => {
    expect(parseIssueList('not json')).toEqual([])
  })
})

describe('GitHub webhook 验签与映射', () => {
  it('签名正确时验签通过', () => {
    const secret = 's3cret'
    const body = '{"action":"opened"}'
    const signature = `sha256=${hmac(secret, body)}`
    expect(verifyGithubSignature(secret, body, signature)).toBe(true)
  })

  it('签名不匹配时验签失败', () => {
    expect(verifyGithubSignature('s3cret', '{"action":"opened"}', 'sha256=deadbeef')).toBe(false)
  })

  it('issues 事件映射成 issue.opened 并带上投递 ID 做幂等键', () => {
    const body = JSON.stringify({ action: 'opened', issue: { number: 12, title: '导出失败', body: '正文', html_url: 'https://github.com/a/b/issues/12', updated_at: '2026-11-10T00:00:00Z', user: { login: 'ghost' } }, repository: { full_name: 'a/b' } })
    const event = mapGithubWebhook(body, 'delivery-1', 'issues')
    expect(event?.type).toBe('issue.opened')
    expect(event?.externalId).toBe('delivery-1')
    expect(event?.subject).toBe('a/b#12')
  })

  it('ping 事件不入队', () => {
    expect(mapGithubWebhook('{}', 'delivery-2', 'ping')).toBeNull()
  })
})

describe('通用 webhook 契约', () => {
  it('七字段齐备时映射成事件', () => {
    const event = mapWebhookPayload({
      id: 'evt-1',
      type: 'alert.fired',
      subject: 'svc/api',
      summary: '接口 5xx 突增',
      actor: { id: 'u1', name: '监控' },
      project: 'router-agent',
      link: 'https://example.com/evt-1',
    })
    expect(event?.externalId).toBe('evt-1')
    expect(event?.type).toBe('alert.fired')
    expect(event?.subject).toBe('svc/api')
    expect(event?.project).toBe('router-agent')
  })

  it('缺字段时不映射', () => {
    expect(mapWebhookPayload({ id: 'evt-1', type: 'alert.fired' })).toBeNull()
  })
})

describe('定时表达式', () => {
  it('命中分钟与小时时匹配', () => {
    expect(cronMatches('0 3 * * *', new Date('2026-11-14T03:00:00'))).toBe(true)
    expect(cronMatches('0 3 * * *', new Date('2026-11-14T03:01:00'))).toBe(false)
  })

  it('支持每 15 分钟与区间', () => {
    expect(cronMatches('*/15 * * * *', new Date('2026-11-14T03:30:00'))).toBe(true)
    expect(cronMatches('*/15 * * * *', new Date('2026-11-14T03:31:00'))).toBe(false)
    expect(cronMatches('0 9-11 * * *', new Date('2026-11-14T10:00:00'))).toBe(true)
  })

  it('算出下一个触发时刻', () => {
    const next = nextCronTime('0 3 * * *', new Date('2026-11-14T04:00:00'))
    expect(next.toISOString()).toBe(new Date('2026-11-15T03:00:00').toISOString())
  })
})

/** 测试用的 HMAC-SHA256；与生产实现一致，避免把断言写歪。 */
function hmac(secret: string, body: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHmac } = require('node:crypto') as typeof import('node:crypto')
  return createHmac('sha256', secret).update(body).digest('hex')
}
