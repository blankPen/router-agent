import { describe, expect, it } from 'vitest'
import { GithubEventSource, parseGithubIssues } from '../../src/events/sources/github.js'
import type { CommandRunner } from '#infra/process.js'

const ISSUE_JSON = JSON.stringify([
  { number: 12, title: '登录失败', body: '偶发 500', labels: [{ name: 'bug' }], url: 'https://github.com/a/b/issues/12', createdAt: '2026-11-13T09:00:00Z' },
  { number: 13, title: '文档更新', body: '', labels: [{ name: 'docs' }], url: 'https://github.com/a/b/issues/13', createdAt: '2026-11-13T09:05:00Z' },
])

describe('事件来源', () => {
  it('GitHub 拉取按标签白名单过滤，并带上仓库线索', async () => {
    const runner: CommandRunner = {
      run: async () => ({ code: 0, stdout: ISSUE_JSON, stderr: '' }),
    }
    const source = new GithubEventSource('github', { enabled: true, kind: 'github', repo: 'a/b', labels: ['bug'], project: 'router-agent' }, { runner })
    const events = await source.poll()
    expect(events).toHaveLength(1)
    expect(events[0]?.externalId).toBe('issue:a/b#12')
    expect(events[0]?.context?.project).toBe('router-agent')
  })

  it('GitHub 拉取失败只返回空数组，不抛异常', async () => {
    const runner: CommandRunner = {
      run: async () => ({ code: 1, stdout: '', stderr: 'not found' }),
    }
    const source = new GithubEventSource('github', { enabled: true, kind: 'github', repo: 'a/b' }, { runner })
    await expect(source.poll()).resolves.toEqual([])
  })

  it('GitHub 结论回写用 issue comment', async () => {
    const calls: string[][] = []
    const runner: CommandRunner = {
      run: async argv => {
        calls.push(argv)
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const source = new GithubEventSource('github', { enabled: true, kind: 'github', repo: 'a/b' }, { runner })
    await source.publish({ externalId: 'issue:a/b#12' }, '处理完成')
    expect(calls[0]?.[0]).toBe('issue')
    expect(calls[0]?.[1]).toBe('comment')
    expect(calls[0]).toContain('12')
  })

  it('解析 GitHub 输出时忽略没有序号的条目', () => {
    const events = parseGithubIssues(JSON.stringify([{ title: '没有序号' }]), 'a/b', { enabled: true, kind: 'github' })
    expect(events).toHaveLength(0)
  })
})
