import { describe, expect, it } from 'vitest'
import { GitHubTracker, ghPrViewCommand, ghRepoOf, isGithubPullRequestUrl, parsePrView, parsePrList } from '../../src/sources/github.js'
import type { CommandRunner } from '../../src/infra/process.js'

describe('GitHub PR 状态解析', () => {
  it('merged PR 归一化为 merged', () => {
    expect(parsePrView(JSON.stringify({ number: 12, url: 'https://github.com/o/r/pull/12', state: 'MERGED', title: '修复登录超时', headRefName: 'ra/tk1' })))
      .toEqual({ number: 12, url: 'https://github.com/o/r/pull/12', state: 'merged', title: '修复登录超时', branch: 'ra/tk1' })
  })

  it('关闭但未合并归一化为 closed', () => {
    expect(parsePrView(JSON.stringify({ number: 3, url: "u", state: "CLOSED", title: "t", headRefName: "b" }))!.state).toBe('closed')
  })

  it('打开归一化为 open', () => {
    expect(parsePrView(JSON.stringify({ number: 3, url: "u", state: "OPEN", title: "t", headRefName: "b" }))!.state).toBe('open')
  })

  it('列表只取第一条（按 head 分支查 PR）', () => {
    const list = parsePrList(JSON.stringify([{ number: 5, url: 'u5', state: 'OPEN', title: 't5', headRefName: 'ra/tk1' }]))
    expect(list?.number).toBe(5)
    expect(parsePrList('[]')).toBeNull()
  })

  it('空输出或非法 JSON 返回 null 而不是抛出', () => {
    expect(parsePrView('')).toBeNull()
    expect(parsePrView('not json')).toBeNull()
  })
})

describe('仓库选择器归一化', () => {
  it('gh 只认 owner/name：剥掉 name:/id: 前缀，path 取最后两段', () => {
    expect(ghRepoOf('name:dsh/router-agent')).toBe('dsh/router-agent')
    expect(ghRepoOf('id:abc-123')).toBe('abc-123')
    expect(ghRepoOf('path:/Users/me/work/dsh/router-agent')).toBe('dsh/router-agent')
    expect(ghRepoOf('dsh/router-agent')).toBe('dsh/router-agent')
    expect(ghPrViewCommand('name:dsh/router-agent', 7)[4]).toBe('dsh/router-agent')
  })
})

describe('PR 状态查询的仓库兜底', () => {
  function fakeRunner(handle: (argv: string[], opts?: { cwd?: string }) => { code: number; stdout?: string } | null) {
    const calls: { argv: string[]; cwd?: string }[] = []
    const runner: CommandRunner = {
      async run(argv, opts = {}) {
        calls.push({ argv, ...(opts.cwd ? { cwd: opts.cwd } : {}) })
        const result = handle(argv, opts)
        return { code: result?.code ?? 1, stdout: result?.stdout ?? '', stderr: '' }
      },
    }
    return { runner, calls }
  }

  const merged = (number: number, url: string) =>
    JSON.stringify({ number, url, state: 'MERGED', title: 't', headRefName: 'b' })

  it('有 PR 链接时直接用链接查，不拿项目名去拼 --repo', async () => {
    const { runner, calls } = fakeRunner(argv =>
      argv.includes('https://github.com/blankPen/router-agent/pull/7')
        ? { code: 0, stdout: merged(7, 'https://github.com/blankPen/router-agent/pull/7') }
        : null,
    )
    const info = await new GitHubTracker(runner).view('router-agent', 7, {
      url: 'https://github.com/blankPen/router-agent/pull/7',
      cwd: '/Users/me/orca/workspaces/router-agent/ra-tk-7',
    })

    expect(info?.state).toBe('merged')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.argv[2]).toBe('https://github.com/blankPen/router-agent/pull/7')
  })

  it('没有 PR 链接且 repo 是裸项目名：在 workdir 里让 gh 从 git remote 推断仓库', async () => {
    const { runner, calls } = fakeRunner((_argv, opts) =>
      opts?.cwd === '/Users/me/orca/workspaces/router-agent/ra-tk-7'
        ? { code: 0, stdout: merged(7, 'https://github.com/blankPen/router-agent/pull/7') }
        : null,
    )
    const info = await new GitHubTracker(runner).view('router-agent', 7, {
      cwd: '/Users/me/orca/workspaces/router-agent/ra-tk-7',
    })

    expect(info?.state).toBe('merged')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.argv).toEqual(['pr', 'view', '7', '--json', 'number,url,state,title,headRefName,body'])
    expect(calls[0]!.cwd).toBe('/Users/me/orca/workspaces/router-agent/ra-tk-7')
  })

  it('path 选择器按最后两段猜错仓库时回退到 workdir', async () => {
    const { runner, calls } = fakeRunner((_argv, opts) =>
      opts?.cwd
        ? { code: 0, stdout: merged(7, 'https://github.com/blankPen/router-agent/pull/7') }
        : null,
    )
    const info = await new GitHubTracker(runner).view('path:/Users/me/orca/workspaces/router-agent/ra-tk-7', 7, {
      cwd: '/Users/me/orca/workspaces/router-agent/ra-tk-7',
    })

    expect(info?.state).toBe('merged')
    expect(calls).toHaveLength(2)
    // 第一次按 path 最后两段（会解析成 router-agent/ra-tk-7）查失败，第二次带 workdir 兜底。
    expect(calls[0]!.argv).toContain('--repo')
    expect(calls[1]!.cwd).toBe('/Users/me/orca/workspaces/router-agent/ra-tk-7')
  })

  it('GitLab MR 链接不交给 gh，继续走 repo/workdir', async () => {
    const { runner, calls } = fakeRunner((_argv, opts) =>
      opts?.cwd
        ? { code: 0, stdout: merged(12, 'https://gitlab.example.com/g/r/-/merge_requests/12') }
        : null,
    )
    const info = await new GitHubTracker(runner).view('g/r', 12, {
      url: 'https://gitlab.example.com/g/r/-/merge_requests/12',
      cwd: '/tmp/wt',
    })

    expect(info?.state).toBe('merged')
    expect(calls[0]!.argv).toContain('--repo')
    expect(calls[0]!.argv.join(' ')).not.toContain('merge_requests')
  })

  it('识别常见 PR 链接形态', () => {
    expect(isGithubPullRequestUrl('https://github.com/o/r/pull/7')).toBe(true)
    expect(isGithubPullRequestUrl('https://github.com/o/r/pull/7/files')).toBe(false)
    expect(isGithubPullRequestUrl('https://gitlab.com/o/r/-/merge_requests/7')).toBe(false)
    expect(isGithubPullRequestUrl('router-agent')).toBe(false)
  })
})
