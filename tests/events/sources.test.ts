import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GithubEventSource, parseGithubEvents, parseGithubRuns } from '../../src/events/sources/github.js'
import type { CommandRunner } from '#infra/process.js'
import type { Logger } from '#infra/logger.js'
import { subscription } from './fixtures.js'
import type { ResolvedSubscription } from '../../src/events/subscriptions.js'
/** 造一条 GitHub 订阅：仓库 + 事件类型（不带前缀的写法会被补上）。 */
function githubSub(repo: string, types: string[]): ResolvedSubscription {
  return subscription({
    id: 'auto_test',
    source: 'github',
    types: types.map(type => (type.startsWith('github.') ? type : `github.${type}`)),
    params: { repo },
  })
}


/** 固定时钟：窗口过滤只应该由注入时间决定，不能依赖跑测试的真实日期。 */
const NOW = '2026-11-16T12:00:00Z'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
})

afterEach(() => {
  vi.useRealTimers()
})

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
        ? (argv[1] ?? '')
        : argv[0] === 'pr' ? `pr ${argv[1] ?? ''}` : argv[0]!
      // 先按带 query 的完整 URL 精确匹配，再退回不带 query 的路径。
      const hit = responses[key]
        ?? responses[key.split('?')[0]!]
        ?? responses[argv[0] ?? '']
        // 没配的 GitHub 分页当作空页：真实 API 翻过最后一页就是空数组。
        ?? { code: 0, stdout: '[]' }
      return { code: hit.code, stdout: hit.stdout, stderr: hit.stderr ?? '' }
    },
  }
  return { runner, calls }
}

describe('GitHub 事件来源', () => {
  it('Issue 与 PR 事件按订阅类型过滤后入队', async () => {
    const { runner } = runnerOf({
      'repos/a/b/events?per_page=100&page=1': { code: 0, stdout: EVENTS_JSON },
      'pr view': { code: 0, stdout: JSON.stringify({ number: 110, title: '实现事件总线', body: 'PR 正文' }) },
    })
    const source = new GithubEventSource({ runner })
    const sub = githubSub('a/b', ['pull_request.opened', 'issues.commented'])
    const events = await source.poll(sub)
    expect(events.map(event => event.externalId)).toEqual([
      'github:pull_request:a/b#110:20192883122',
      'github:issues:a/b#110:20192901502',
    ])
    // 事件类型带来源前缀：不同来源的同名类型不会混淆。
    expect(events.map(event => event.eventType)).toEqual([
      'github.pull_request.opened',
      'github.issues.commented',
    ])
    expect(events[0]?.title).toBe('PR 新建 · 实现事件总线')
    expect(events[0]?.eventType).toBe('github.pull_request.opened')
    expect(events[0]?.url).toBe('https://github.com/a/b/pull/110')
  })

  it('没订阅的类型不进队列', async () => {
    const { runner } = runnerOf({
      'repos/a/b/events?per_page=100&page=1': { code: 0, stdout: EVENTS_JSON },
      'pr view': { code: 0, stdout: '{}' },
    })
    const source = new GithubEventSource({ runner })
    const sub = githubSub('a/b', ['issues.opened'])
    const events = await source.poll(sub)
    expect(events).toEqual([])
  })

  it('Action 执行失败也算一条事件', async () => {
    const { runner } = runnerOf({
      'repos/a/b/events': { code: 0, stdout: '[]' },
      'repos/a/b/actions/runs?per_page=100&page=1': { code: 0, stdout: RUNS_JSON },
    })
    const source = new GithubEventSource({ runner })
    const sub = githubSub('a/b', ['workflow_run.failure'])
    const events = await source.poll(sub)
    expect(events).toHaveLength(1)
    expect(events[0]?.externalId).toBe('github:workflow_run:a/b#43609924128:failure')
    expect(events[0]?.title).toContain('发布 npm 包')
  })

  it('Action 订阅里含「执行结束」时，成功与失败都算', async () => {
    const { runner } = runnerOf({
      'repos/a/b/events': { code: 0, stdout: '[]' },
      'repos/a/b/actions/runs?per_page=100&page=1': { code: 0, stdout: RUNS_JSON },
    })
    const source = new GithubEventSource({ runner })
    const sub = githubSub('a/b', ['workflow_run.completed'])
    const events = await source.poll(sub)
    expect(events.map(event => event.eventType)).toEqual(['github.workflow_run.completed'])
  })

  it('拉取失败只返回空数组，不抛异常', async () => {
    const { runner } = runnerOf({})
    const source = new GithubEventSource({ runner })
    const sub = githubSub('a/b', [])
    await expect(source.poll(sub)).resolves.toEqual([])
  })

  it('没填仓库时不拉取', async () => {
    const { runner, calls } = runnerOf({})
    const source = new GithubEventSource({ runner })
    const sub = githubSub('', [])
    await expect(source.poll(sub)).resolves.toEqual([])
    expect(calls).toEqual([])
  })

  it('只处理上次之后的新事件，不重复入队', async () => {
    const { runner } = runnerOf({
      'repos/a/b/events?per_page=100&page=1': { code: 0, stdout: EVENTS_JSON },
      'pr view': { code: 0, stdout: JSON.stringify({ number: 110, title: '实现事件总线', body: 'PR 正文' }) },
    })
    const cursor = new Map<string, string>()
    const source = new GithubEventSource({
      runner,
      cursor: {
        get: key => cursor.get(key) ?? null,
        set: (key, value) => { cursor.set(key, value) },
      },
    })
    const sub = githubSub('a/b', ['pull_request.opened', 'issues.commented'])
    // 第一次轮询是建基线：这批历史不入队，只记水位。
    expect(await source.poll(sub)).toEqual([])
    // 第二次拉到同样一批数据，已经是旧事件，不再入队。
    const second = await source.poll(sub)
    expect(second).toEqual([])
  })

  it('有游标时只取比游标更新的事件', async () => {
    const { runner } = runnerOf({
      'repos/a/b/events?per_page=100&page=1': { code: 0, stdout: EVENTS_JSON },
      'pr view': { code: 0, stdout: JSON.stringify({ number: 110, title: '实现事件总线', body: 'PR 正文' }) },
    })
    const source = new GithubEventSource({
      runner,
      cursor: {
        get: () => '20192883122',
        set: () => undefined,
      },
    })
    const sub = githubSub('a/b', ['pull_request.opened', 'issues.commented'])
    const events = await source.poll(sub)
    expect(events.map(event => event.externalId)).toEqual(['github:issues:a/b#110:20192901502'])
  })

  it('PR 事件缺标题时用 pr view 补上', async () => {
    const { runner, calls } = runnerOf({
      'repos/a/b/events?per_page=100&page=1': { code: 0, stdout: EVENTS_JSON },
      'pr view': { code: 0, stdout: JSON.stringify({ number: 110, title: '实现事件总线', body: 'PR 正文' }) },
    })
    const source = new GithubEventSource({ runner })
    const sub = githubSub('a/b', ['pull_request.opened'])
    const events = await source.poll(sub)
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

/** 一页 Issue/PR 事件（真实 GitHub 每页 100 条，page4 起为空）。 */
function pageJson(items: unknown[]): string {
  return JSON.stringify(items)
}

const PR_EVENT = (id: string, number: number, createdAt = '2026-11-16T09:00:00Z') => ({
  id,
  type: 'PullRequestEvent',
  actor: { login: 'blankPen' },
  created_at: createdAt,
  payload: {
    action: 'opened',
    pull_request: { number, title: `PR ${number}`, body: null, html_url: `https://github.com/a/b/pull/${number}`, state: 'open', merged: false },
  },
})

describe('GitHub 事件来源 · 分页', () => {
  it('事件流只拉一页时，第 2 页里的事件永远收不到', async () => {
    // 第 1 页 100 条（全是无关的 PushEvent），第 2 页才有订阅的 PR 事件。
    const page1 = Array.from({ length: 100 }, (_, index) => ({
      id: String(90000000000 + index),
      type: 'PushEvent',
      actor: { login: 'x' },
      created_at: '2026-11-16T10:00:00Z',
      payload: { action: null },
    }))
    const page2 = [PR_EVENT('20254670660', 111)]
    const { runner, calls } = runnerOf({
      'repos/a/b/events?per_page=100&page=1': { code: 0, stdout: pageJson(page1) },
      'repos/a/b/events?per_page=100&page=2': { code: 0, stdout: pageJson(page2) },
      'pr view': { code: 0, stdout: JSON.stringify({ title: 'PR 111', body: '' }) },
    })
    const source = new GithubEventSource({ runner })
    const sub = githubSub('a/b', ['pull_request.opened'])
    const events = await source.poll(sub)
    expect(calls.some(argv => argv[1]?.includes('page=2'))).toBe(true)
    expect(events.map(event => event.eventType)).toEqual(['github.pull_request.opened'])
  })
})

describe('GitHub 事件来源 · Action 事件类型', () => {
  it('工作流被触发（还没结论）时记一条「触发」事件', async () => {
    const { runner } = runnerOf({
      'repos/a/b/events?per_page=100&page=1': { code: 0, stdout: '[]' },
      'repos/a/b/actions/runs?per_page=100&page=1': {
        code: 0,
        stdout: JSON.stringify({
          workflow_runs: [{
            id: 99,
            name: '发布 npm 包',
            status: 'in_progress',
            conclusion: null,
            created_at: '2026-11-16T10:00:00Z',
            updated_at: '2026-11-16T10:00:05Z',
            html_url: 'https://github.com/a/b/actions/runs/99',
            head_branch: 'main',
            display_title: '发布 npm 包',
          }],
        }),
      },
    })
    const source = new GithubEventSource({ runner })
    const sub = githubSub('a/b', ['workflow_run.requested'])
    const events = await source.poll(sub)
    expect(events.map(event => event.eventType)).toEqual(['github.workflow_run.requested'])
  })

  it('订阅「执行结束」时，skipped 与 action_required 也算结束', async () => {
    const { runner } = runnerOf({
      'repos/a/b/events?per_page=100&page=1': { code: 0, stdout: '[]' },
      'repos/a/b/actions/runs?per_page=100&page=1': {
        code: 0,
        stdout: JSON.stringify({
          workflow_runs: [
            { id: 1, name: 'a', status: 'completed', conclusion: 'skipped', created_at: '2026-11-16T10:00:00Z', updated_at: '2026-11-16T10:01:00Z', html_url: 'u1', head_branch: 'main', display_title: 'a' },
            { id: 2, name: 'b', status: 'completed', conclusion: 'action_required', created_at: '2026-11-16T10:00:00Z', updated_at: '2026-11-16T10:01:00Z', html_url: 'u2', head_branch: 'main', display_title: 'b' },
          ],
        }),
      },
    })
    const source = new GithubEventSource({ runner })
    const sub = githubSub('a/b', ['workflow_run.completed'])
    const events = await source.poll(sub)
    expect(events.map(event => event.eventType)).toEqual(['github.workflow_run.completed', 'github.workflow_run.completed'])
  })
})

/**
 * GitHub 事件流同一族里的 id 是严格降序的，所以「第 1 页的 id 比第 2 页大」。
 * 若每页各自推进游标，第 1 页就把游标推过头，第 2 页的事件全被当成旧事件丢掉。
 */
describe('GitHub 事件来源 · 多页游标', () => {
  it('第 2 页的事件 id 比第 1 页小，不会被第 1 页推进的游标挡掉', async () => {
    const page1 = [PR_EVENT('20254670660', 111)]
    const page2 = [PR_EVENT('20254670000', 112)]
    const { runner } = runnerOf({
      'repos/a/b/events?per_page=100&page=1': { code: 0, stdout: JSON.stringify(page1) },
      'repos/a/b/events?per_page=100&page=2': { code: 0, stdout: JSON.stringify(page2) },
      'pr view': { code: 0, stdout: JSON.stringify({ title: 'x', body: '' }) },
    })
    // 已经有基线（水位 0），这轮是增量拉取。
    const cursor = new Map<string, string>([['github:auto_test:a/b:v2', '0']])
    const source = new GithubEventSource({
      runner,
      cursor: {
        get: key => cursor.get(key) ?? null,
        set: (key, value) => { cursor.set(key, value) },
      },
    })
    const sub = githubSub('a/b', ['pull_request.opened'])
    const events = await source.poll(sub)
    expect(events.map(event => event.externalId)).toEqual([
      'github:pull_request:a/b#111:20254670660',
      'github:pull_request:a/b#112:20254670000',
    ])
  })
})

describe('GitHub 事件来源 · 最近 3 天窗口', () => {
  it('只入队最近 3 天的事件，窗口外的旧 PR 不查详情', async () => {
    const old = PR_EVENT('20299999999', 120, '2026-11-13T11:59:59Z')
    const edge = PR_EVENT('20200000001', 121, '2026-11-13T12:00:00Z')
    const recent = PR_EVENT('20200000002', 122, '2026-11-16T10:00:00Z')
    const { runner, calls } = runnerOf({
      'repos/a/b/events?per_page=100&page=1': { code: 0, stdout: pageJson([old, edge, recent]) },
      'pr view': { code: 0, stdout: JSON.stringify({ title: '实现事件总线', body: '' }) },
    })
    const cursor = new Map<string, string>([['github:auto_test:a/b:v2', '0']])
    const logs: Array<{ message: string; extra?: Record<string, unknown> }> = []
    const logger: Logger = {
      info: (message, extra) => { logs.push({ message, extra }) },
      warn: () => {},
      error: () => {},
    }
    const source = new GithubEventSource({
      runner,
      logger,
      cursor: {
        get: key => cursor.get(key) ?? null,
        set: (key, value) => { cursor.set(key, value) },
      },
    })
    const sub = githubSub('a/b', ['pull_request.opened'])
    const events = await source.poll(sub)
    expect(events.map(event => event.externalId)).toEqual([
      'github:pull_request:a/b#121:20200000001',
      'github:pull_request:a/b#122:20200000002',
    ])
    // 窗口外的 PR 不查详情，避免恢复订阅时对陈年 PR 批量调 gh。
    expect(calls.filter(argv => argv[0] === 'pr')).toHaveLength(2)
    // 游标记「见过的最新 id」，时间窗口只决定要不要入队。
    expect(cursor.get('github:auto_test:a/b:v2')).toBe('20299999999')
    expect(logs.find(log => log.message === 'event:github-window-skipped')?.extra).toMatchObject({
      skipped: 1,
      since: '2026-11-13T12:00:00.000Z',
    })
  })

  it('Action 也只入队最近 3 天的工作流', async () => {
    const { runner } = runnerOf({
      'repos/a/b/actions/runs?per_page=100&page=1': {
        code: 0,
        stdout: JSON.stringify({
          workflow_runs: [
            { id: 10, name: '旧工作流', status: 'completed', conclusion: 'failure', created_at: '2026-11-13T11:59:59Z', updated_at: '2026-11-13T12:00:00Z', html_url: 'u10', head_branch: 'main', display_title: '' },
            { id: 11, name: '新工作流', status: 'completed', conclusion: 'failure', created_at: '2026-11-16T10:00:00Z', updated_at: '2026-11-16T10:01:00Z', html_url: 'u11', head_branch: 'main', display_title: '' },
          ],
        }),
      },
    })
    const source = new GithubEventSource({ runner })
    const sub = githubSub('a/b', ['workflow_run.failure'])
    const events = await source.poll(sub)
    expect(events.map(event => event.externalId)).toEqual(['github:workflow_run:a/b#11:failure'])
  })
})

/**
 * 新订阅一开就会把 GitHub 上积攒的历史全当成「刚发生的事」灌进队列，
 * 一夜之间开出几十张工单。第一次轮询必须只建基线，不入队任何事件。
 */
describe('GitHub 事件来源 · 首次订阅建基线', () => {
  it('第一次轮询只记水位，不把存量历史入队', async () => {
    const { runner } = runnerOf({
      'repos/a/b/events?per_page=100&page=1': { code: 0, stdout: EVENTS_JSON },
      'pr view': { code: 0, stdout: JSON.stringify({ title: 'x', body: '' }) },
    })
    const cursor = new Map<string, string>()
    const source = new GithubEventSource({
      runner,
      cursor: {
        get: key => cursor.get(key) ?? null,
        set: (key, value) => { cursor.set(key, value) },
      },
    })
    const sub = githubSub('a/b', ['pull_request.opened', 'issues.commented'])
    expect(await source.poll(sub)).toEqual([])
    // 水位记到本页最大 id（20192901502），下次只取比它新的。
    expect(cursor.get('github:auto_test:a/b:v2')).toBe('20192901502')
  })

  it('基线之后新发生的事件照常入队', async () => {
    const { runner } = runnerOf({
      'repos/a/b/events?per_page=100&page=1': { code: 0, stdout: EVENTS_JSON },
      'pr view': { code: 0, stdout: JSON.stringify({ title: 'x', body: '' }) },
    })
    const cursor = new Map<string, string>()
    const source = new GithubEventSource({
      runner,
      cursor: {
        get: key => cursor.get(key) ?? null,
        set: (key, value) => { cursor.set(key, value) },
      },
    })
    const sub = githubSub('a/b', ['pull_request.opened', 'issues.commented'])
    await source.poll(sub)
    // 游标已经推到 20192901502，下次换一批更新的数据。
    const newer = JSON.stringify([
      {
        id: '20200000001',
        type: 'PullRequestEvent',
        actor: { login: 'blankPen' },
        created_at: '2026-11-16T10:00:00Z',
        payload: { action: 'opened', pull_request: { number: 200, title: '新 PR', body: null, html_url: 'u', state: 'open', merged: false } },
      },
    ])
    const { runner: runner2 } = runnerOf({
      'repos/a/b/events?per_page=100&page=1': { code: 0, stdout: newer },
      'pr view': { code: 0, stdout: JSON.stringify({ title: '新 PR', body: '' }) },
    })
    const source2 = new GithubEventSource({
      runner: runner2,
      cursor: {
        get: key => cursor.get(key) ?? null,
        set: (key, value) => { cursor.set(key, value) },
      },
    })
    const sub2 = githubSub('a/b', ['pull_request.opened'])
    const events = await source2.poll(sub2)
    expect(events.map(event => event.externalId)).toEqual(['github:pull_request:a/b#200:20200000001'])
  })

  it('基线轮拉取失败时不记水位，下次重新建基线', async () => {
    // 第 1 页成功、第 2 页失败：水位不完整，不能记。
    const { runner } = runnerOf({
      'repos/a/b/events?per_page=100&page=1': { code: 0, stdout: EVENTS_JSON },
      'repos/a/b/events?per_page=100&page=2': { code: 1, stdout: '', stderr: 'boom' },
      'pr view': { code: 0, stdout: JSON.stringify({ title: 'x', body: '' }) },
    })
    const cursor = new Map<string, string>()
    const source = new GithubEventSource({
      runner,
      cursor: {
        get: key => cursor.get(key) ?? null,
        set: (key, value) => { cursor.set(key, value) },
      },
    })
    const sub = githubSub('a/b', ['pull_request.opened'])
    expect(await source.poll(sub)).toEqual([])
    expect(cursor.has('github:auto_test:a/b:v2')).toBe(false)
  })

  it('两个订阅同一仓库时游标互不影响', async () => {
    const { runner } = runnerOf({
      'repos/a/b/events?per_page=100&page=1': { code: 0, stdout: EVENTS_JSON },
      'pr view': { code: 0, stdout: JSON.stringify({ title: 'x', body: '' }) },
    })
    const cursor = new Map<string, string>()
    const deps = {
      runner,
      cursor: {
        get: (key: string) => cursor.get(key) ?? null,
        set: (key: string, value: string) => { cursor.set(key, value) },
      },
    }
    // 两个任务订阅同一个仓库，但订阅 id 不同：游标各走各的，互不干扰。
    const sourceA = new GithubEventSource(deps)
    const sourceB = new GithubEventSource(deps)
    await sourceA.poll(githubSub('a/b', ['pull_request.opened']))
    await sourceB.poll(githubSub('a/b', ['pull_request.opened']))
    // 两个订阅各有各的水位；这个订阅只收 PR 事件，水位就停在 PR 的 id 上。
    expect(cursor.get('github:auto_test:a/b:v2')).toBe('20192883122')
  })
})

/**
 * GitHub 的事件 id 分属不同编号空间，跨空间不可比：
 * 仓库级事件（PushEvent / CreateEvent）的 id 比 Issue/PR 事件大几十亿。
 * 游标若按整页取 id 最大值，会被仓库级事件顶到别的空间，
 * 之后所有 Issue/PR 事件的 id 都小于游标，被永久挡在门外。
 */
describe('GitHub 事件来源 · 游标不跨 id 空间', () => {
  /** 仓库级事件：id 远大于 PR 事件，但进不了订阅队列。 */
  const PUSH_EVENT = (id: string, createdAt = '2026-11-16T10:00:00Z') => ({
    id,
    type: 'PushEvent',
    actor: { login: 'blankPen' },
    created_at: createdAt,
    payload: { action: null },
  })

  it('基线轮不让仓库级事件把游标顶到别的 id 空间', async () => {
    const { runner } = runnerOf({
      'repos/a/b/events?per_page=100&page=1': {
        code: 0,
        stdout: pageJson([PUSH_EVENT('27333071195'), PR_EVENT('20383717095', 112)]),
      },
      'pr view': { code: 0, stdout: JSON.stringify({ title: 'PR 112', body: '' }) },
    })
    const cursor = new Map<string, string>()
    const source = new GithubEventSource({
      runner,
      cursor: {
        get: key => cursor.get(key) ?? null,
        set: (key, value) => { cursor.set(key, value) },
      },
    })
    const sub = githubSub('a/b', ['pull_request.opened'])
    await source.poll(sub)
    // 游标只按能入队的 PR 事件推进，不能被 PushEvent 的 id 带偏。
    expect(cursor.get('github:auto_test:a/b:v2')).toBe('20383717095')
  })

  it('仓库级事件在场时，PR 事件仍能入队', async () => {
    const prId = '20383857679'
    const { runner } = runnerOf({
      'repos/a/b/events?per_page=100&page=1': {
        code: 0,
        stdout: pageJson([PUSH_EVENT('27333071195'), PR_EVENT(prId, 112)]),
      },
      'pr view': { code: 0, stdout: JSON.stringify({ title: 'PR 112', body: '' }) },
    })
    // 游标是上一次 PR 事件的 id，比本轮 PR 事件小。
    const cursor = new Map<string, string>([['github:auto_test:a/b:v2', '20383739442']])
    const source = new GithubEventSource({
      runner,
      cursor: {
        get: key => cursor.get(key) ?? null,
        set: (key, value) => { cursor.set(key, value) },
      },
    })
    const sub = githubSub('a/b', ['pull_request.opened'])
    const events = await source.poll(sub)
    expect(events.map(event => event.externalId)).toEqual([`github:pull_request:a/b#112:${prId}`])
  })

  it('未订阅的 Issue 事件不参与游标推进', async () => {
    const { runner } = runnerOf({
      'repos/a/b/events?per_page=100&page=1': {
        code: 0,
        stdout: pageJson([
          { id: '20390000000', type: 'IssuesEvent', actor: { login: 'x' }, created_at: '2026-11-16T10:00:00Z', payload: { action: 'opened', issue: { number: 500, title: '未订阅的 Issue', body: '', html_url: 'u' } } },
          PR_EVENT('20383717095', 112),
        ]),
      },
      'pr view': { code: 0, stdout: JSON.stringify({ title: 'PR 112', body: '' }) },
    })
    const cursor = new Map<string, string>()
    const source = new GithubEventSource({
      runner,
      cursor: {
        get: key => cursor.get(key) ?? null,
        set: (key, value) => { cursor.set(key, value) },
      },
    })
    const sub = githubSub('a/b', ['pull_request.opened'])
    await source.poll(sub)
    // 未订阅的 Issue 事件不进队列，也不该把游标推高。
    expect(cursor.get('github:auto_test:a/b:v2')).toBe('20383717095')
  })
})
