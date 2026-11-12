import { describe, expect, it } from 'vitest'
import { GitHubTracker } from '../../src/sources/github.js'
import { GitLabTracker } from '../../src/sources/gitlab.js'
import { ForgeTracker } from '../../src/sources/forge-tracker.js'
import type { CommandRunner } from '#infra/process.js'

interface Call { argv: string[]; cwd?: string }

function fakeRunner(handle: (argv: string[], opts?: { cwd?: string }) => { code: number; stdout?: string }) {
  const calls: Call[] = []
  const runner: CommandRunner = {
    async run(argv, opts = {}) {
      calls.push({ argv, ...(opts.cwd ? { cwd: opts.cwd } : {}) })
      const result = handle(argv, opts)
      return { code: result.code, stdout: result.stdout ?? '', stderr: '' }
    },
  }
  return { runner, calls }
}

const gitlabMr = JSON.stringify({
  iid: 12,
  web_url: 'https://gitlab.example.com/group/repo/-/merge_requests/12',
  state: 'merged',
  title: 't',
  source_branch: 'ra/tk-12',
})

const githubPr = JSON.stringify({
  number: 7,
  url: 'https://github.com/o/r/pull/7',
  state: 'MERGED',
  title: 't',
  headRefName: 'ra/tk-7',
})

function build(opts: { remote?: string; gh?: (argv: string[], cwd?: string) => { code: number; stdout?: string }; glab?: (argv: string[], cwd?: string) => { code: number; stdout?: string } }) {
  const gh = fakeRunner((argv, o) => opts.gh?.(argv, o?.cwd) ?? { code: 1 })
  const glab = fakeRunner((argv, o) => opts.glab?.(argv, o?.cwd) ?? { code: 1 })
  const git = fakeRunner(() => opts.remote ? { code: 0, stdout: opts.remote } : { code: 1 })
  const tracker = new ForgeTracker({
    github: new GitHubTracker(gh.runner),
    gitlab: new GitLabTracker(glab.runner),
    git: git.runner,
  })
  return { tracker, gh, glab, git }
}

describe('ForgeTracker 分流', () => {
  it('GitLab MR 链接直接走 glab，不调用 gh', async () => {
    const { tracker, gh, glab } = build({
      remote: 'git@github.com:o/r.git',
      glab: () => ({ code: 0, stdout: gitlabMr }),
    })

    const info = await tracker.view('group/repo', 12, {
      url: 'https://gitlab.example.com/group/repo/-/merge_requests/12',
      cwd: '/tmp/wt',
    })

    expect(info?.state).toBe('merged')
    expect(gh.calls).toHaveLength(0)
    expect(glab.calls[0]?.argv).toEqual(['mr', 'view', '12', '--output', 'json'])
  })

  it('GitHub PR 链接走 gh', async () => {
    const { tracker, gh, glab } = build({ gh: () => ({ code: 0, stdout: githubPr }) })

    const info = await tracker.view('o/r', 7, { url: 'https://github.com/o/r/pull/7' })

    expect(info?.state).toBe('merged')
    expect(gh.calls).toHaveLength(1)
    expect(glab.calls).toHaveLength(0)
  })

  it('GitLab remote 的本地仓库走 glab，不用 group/repo 去查 GitHub', async () => {
    const { tracker, gh, glab } = build({
      remote: 'git@gitlab.example.com:group/repo.git',
      glab: () => ({ code: 0, stdout: gitlabMr }),
    })

    const info = await tracker.view('path:/tmp/wt', 12, { cwd: '/tmp/wt' })

    expect(info?.number).toBe(12)
    expect(gh.calls).toHaveLength(0)
    expect(glab.calls[0]?.cwd).toBe('/tmp/wt')
  })

  it('GitHub remote 的本地仓库把 remote 路径交给 gh', async () => {
    const { tracker, gh } = build({
      remote: 'https://github.com/o/r.git',
      gh: () => ({ code: 0, stdout: githubPr }),
    })

    const info = await tracker.view('path:/tmp/wt', 7, { cwd: '/tmp/wt' })

    expect(info?.number).toBe(7)
    expect(gh.calls[0]?.argv).toContain('o/r')
  })

  it('本地路径但读不到 remote 时直接放弃，不猜 owner/repo', async () => {
    const { tracker, gh, glab } = build({})

    expect(await tracker.view('path:/tmp/wt', 12, { cwd: '/tmp/wt' })).toBeNull()
    expect(await tracker.findByBranch('/', 'ra/tk1', { cwd: '/tmp/wt' })).toBeNull()
    expect(gh.calls).toHaveLength(0)
    expect(glab.calls).toHaveLength(0)
  })

  it('按分支反查时把 cwd 传给 glab', async () => {
    const { tracker, glab } = build({
      remote: 'git@gitlab.example.com:group/repo.git',
      glab: () => ({ code: 0, stdout: JSON.stringify([JSON.parse(gitlabMr)]) }),
    })

    const info = await tracker.findByBranch('path:/tmp/wt', 'ra/tk-12', { cwd: '/tmp/wt' })

    expect(info?.number).toBe(12)
    expect(glab.calls[0]?.argv).toContain('--source-branch')
    expect(glab.calls[0]?.cwd).toBe('/tmp/wt')
  })
})
