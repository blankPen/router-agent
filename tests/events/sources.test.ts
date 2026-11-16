import { describe, expect, it } from 'vitest'
import { GithubEventSource, parseGithubEvents, parseGithubRuns } from '../../src/events/sources/github.js'
import type { CommandRunner } from '#infra/process.js'

const EVENTS_JSON = JSON.stringify([
  {
    id: '20192883122',
    type: 'PullRequestEvent',
    actor: { login: 'blankPen' },
    created_at: '2026-11-15T17:30:13Z',
    payload: {
      action: 'opened',
      // 真实 GitHub 的 PR 事件载荷里没有标题，要另外查一次 pr view。
      pull_request: { number: 110, title: null, body: null, html_url: 'https://github.com/a/b/pull/110', state: 'open', merged: false, user: { login: 'blankPen' } },
    },
  },
  {
    id: '20192901502',
    type: 'IssueCommentEvent',
    actor: { login: 'coderabbitai[bot]' },
    created_at: '2026-11-15T17:30:33Z',
    payload: {
      action: 'created',
      issue: { number: 110, title: '实现事件总线', body: '正文', html_url: 'https://github.com/a/b/issues/110', state: 'open', user: { login: 'blankPen' }, labels: [{ name: 'bug' }] },
      comment: { body: '这条评论很啰嗦' },
    },
  },
])

const RUNS_JSON = JSON.stringify({
  workflow_runs: [
    {
      id: 43609924128,
      name: '发布 npm 包',
      event: 'push',
      status: 'completed',
      conclusion: 'failure',
      created_at: '2026-11-14T15:23:26Z',
      updated_at: '2026-11-14T15:25:43Z',
      html_url: 'https://github.com/a/b/actions/runs/43609924128',
      head_branch: 'main',
      display_title: '发布 npm 包',
    },
  ],
})

/** 按 argv 的第一个词分派出固定的返回值。 */
function runnerOf(responses: Record<string, { code: number; stdout: string; stderr?: string }>): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = []
  const runner: CommandRunner = {
    run: async argv => {
      calls.push(argv)
      const key = argv[0] === 'api'
        ? (argv[1] ?? '').split('?')[0]!
        : argv[0] === 'pr' ? `pr ${argv[1] ?? ''}` : argv[0]!
      const hit = responses[key] ?? responses[argv[0] ?? ''] ?? { code: 1, stdout: '', stderr: 'not found' }
      return { code: hit.code, stdout: hit.stdout, stderr: hit.stderr ?? '' }
    },
  }
  return { runner, calls }
}

describe('GitHub 事件来源', () => {
  it('Issue 与 PR 事件按订阅类型过滤后入队', async () => {
    const { runner } = runnerOf({
      'repos/a/b/events': { code: 0, stdout: EVENTS_JSON },
      'pr view': { code: 0, stdout: JSON.stringify({ number: 110, title: '实现事件总线', body: 'PR 正文' }) },
    })
    const source = new GithubEventSource('github-1', {
      enabled: true,
      kind: 'github',
      repo: 'a/b',
      events: ['pull_request.opened', 'issues.commented'],
    }, { runner })
    const events = await source.poll()
    expect(events.map(event => event.externalId)).toEqual([
      'pull_request:a/b#110:20192883122',
      'issues:a/b#110:20192901502',
    ])
    expect(events[0]?.title).toBe('PR 新建 · 实现事件总线')
    expect(events[0]?.eventType).toBe('pull_request.opened')
    expect(events[0]?.url).toBe('https://github.com/a/b/pull/110')
  })

  it('没订阅的类型不进队列', async () => {
    const { runner } = runnerOf({
      'repos/a/b/events': { code: 0, stdout: EVENTS_JSON },
      'pr view': { code: 0, stdout: '{}' },
    })
    const source = new GithubEventSource('github-1', {
      enabled: true,
      kind: 'github',
      repo: 'a/b',
      events: ['issues.opened'],
    }, { runner })
    const events = await source.poll()
    expect(events).toEqual([])
  })

  it('Action 执行失败也算一条事件', async () => {
    const { runner } = runnerOf({
      'repos/a/b/events': { code: 0, stdout: '[]' },
      'repos/a/b/actions/runs': { code: 0, stdout: RUNS_JSON },
    })
    const source = new GithubEventSource('github-1', {
      enabled: true,
      kind: 'github',
      repo: 'a/b',
      events: ['workflow_run.failure'],
    }, { runner })
    const events = await source.poll()
    expect(events).toHaveLength(1)
    expect(events[0]?.externalId).toBe('workflow_run:a/b#43609924128:failure')
    expect(events[0]?.title).toContain('发布 npm 包')
  })

  it('Action 订阅里含「执行结束」时，成功与失败都算', async () => {
    const { runner } = runnerOf({
      'repos/a/b/events': { code: 0, stdout: '[]' },
      'repos/a/b/actions/runs': { code: 0, stdout: RUNS_JSON },
    })
    const source = new GithubEventSource('github-1', {
      enabled: true,
      kind: 'github',
      repo: 'a/b',
      events: ['workflow_run.completed'],
    }, { runner })
    const events = await source.poll()
    expect(events.map(event => event.eventType)).toEqual(['workflow_run.completed'])
  })

  it('拉取失败只返回空数组，不抛异常', async () => {
    const { runner } = runnerOf({})
    const source = new GithubEventSource('github-1', { enabled: true, kind: 'github', repo: 'a/b' }, { runner })
    await expect(source.poll()).resolves.toEqual([])
  })

  it('没填仓库时不拉取', async () => {
    const { runner, calls } = runnerOf({})
    const source = new GithubEventSource('github-1', { enabled: true, kind: 'github', repo: '' }, { runner })
    await expect(source.poll()).resolves.toEqual([])
    expect(calls).toEqual([])
  })

  it('只处理上次之后的新事件，不重复入队', async () => {
    const { runner } = runnerOf({
      'repos/a/b/events': { code: 0, stdout: EVENTS_JSON },
      'pr view': { code: 0, stdout: JSON.stringify({ number: 110, title: '实现事件总线', body: 'PR 正文' }) },
    })
    const cursor = new Map<string, string>()
    const source = new GithubEventSource('github-1', {
      enabled: true,
      kind: 'github',
      repo: 'a/b',
      events: ['pull_request.opened', 'issues.commented'],
    }, {
      runner,
      cursor: {
        get: key => cursor.get(key) ?? null,
        set: (key, value) => { cursor.set(key, value) },
      },
    })
    const first = await source.poll()
    expect(first).toHaveLength(2)
    // 第二次拉到同样一批数据，已经是旧事件，不再入队。
    const second = await source.poll()
    expect(second).toEqual([])
  })

  it('有游标时只取比游标更新的事件', async () => {
    const { runner } = runnerOf({
      'repos/a/b/events': { code: 0, stdout: EVENTS_JSON },
      'pr view': { code: 0, stdout: JSON.stringify({ number: 110, title: '实现事件总线', body: 'PR 正文' }) },
    })
    const source = new GithubEventSource('github-1', {
      enabled: true,
      kind: 'github',
      repo: 'a/b',
      events: ['pull_request.opened', 'issues.commented'],
    }, {
      runner,
      cursor: {
        get: () => '20192883122',
        set: () => undefined,
      },
    })
    const events = await source.poll()
    expect(events.map(event => event.externalId)).toEqual(['issues:a/b#110:20192901502'])
  })

  it('PR 事件缺标题时用 pr view 补上', async () => {
    const { runner, calls } = runnerOf({
      'repos/a/b/events': { code: 0, stdout: EVENTS_JSON },
      'pr view': { code: 0, stdout: JSON.stringify({ number: 110, title: '实现事件总线', body: 'PR 正文' }) },
    })
    const source = new GithubEventSource('github-1', {
      enabled: true,
      kind: 'github',
      repo: 'a/b',
      events: ['pull_request.opened'],
    }, { runner })
    const events = await source.poll()
    expect(events[0]?.title).toBe('PR 新建 · 实现事件总线')
    expect(events[0]?.body).toContain('PR 正文')
    expect(calls.some(argv => argv[0] === 'pr' && argv[1] === 'view')).toBe(true)
  })

  it('解析事件时忽略没有编号的条目', () => {
    const events = parseGithubEvents(JSON.stringify([
      { id: '1', type: 'IssuesEvent', created_at: '2026-11-15T00:00:00Z', payload: { action: 'opened', issue: { title: '没有编号' } } },
    ]), 'a/b', ['issues.opened'])
    expect(events).toHaveLength(0)
  })

  it('解析 Action 时忽略没有结论的条目', () => {
    const events = parseGithubRuns(JSON.stringify({
      workflow_runs: [{ id: 1, name: 'x', status: 'in_progress', created_at: '2026-11-15T00:00:00Z' }],
    }), 'a/b', ['workflow_run.completed'])
    expect(events).toHaveLength(0)
  })
})
