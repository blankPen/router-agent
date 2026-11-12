import { describe, expect, it } from 'vitest'
import {
  GitLabTracker,
  glabMrListCommand,
  glabMrViewCommand,
  normalizeGitlabState,
  parseGlabMrList,
  parseGlabMrView,
} from '../../src/sources/gitlab.js'
import { isGitlabMergeRequestUrl, parseGitRemote, parseGitlabMergeRequestUrl } from '../../src/sources/forge.js'
import type { CommandRunner } from '#infra/process.js'

describe('GitLab MR 状态解析', () => {
  it('opened / locked 归一化为 open，不能误判为关闭', () => {
    expect(normalizeGitlabState('opened')).toBe('open')
    expect(normalizeGitlabState('locked')).toBe('open')
    expect(normalizeGitlabState('OPENED')).toBe('open')
    expect(normalizeGitlabState('merged')).toBe('merged')
    expect(normalizeGitlabState('closed')).toBe('closed')
  })

  it('解析 glab mr view 的 JSON', () => {
    const info = parseGlabMrView(JSON.stringify({
      iid: 12,
      web_url: 'https://gitlab.example.com/g/r/-/merge_requests/12',
      state: 'merged',
      title: '修复登录超时',
      source_branch: 'ra/tk-12',
    }))
    expect(info).toEqual({
      number: 12,
      url: 'https://gitlab.example.com/g/r/-/merge_requests/12',
      state: 'merged',
      title: '修复登录超时',
      branch: 'ra/tk-12',
    })
  })

  it('列表兼容裸数组与 merge_requests 包装，只取第一条', () => {
    const mr = { iid: 5, web_url: 'u5', state: 'opened', title: 't5', source_branch: 'ra/tk5' }
    expect(parseGlabMrList(JSON.stringify([mr]))?.number).toBe(5)
    expect(parseGlabMrList(JSON.stringify({ merge_requests: [mr] }))?.number).toBe(5)
    expect(parseGlabMrList('[]')).toBeNull()
  })

  it('空输出或非法 JSON 返回 null 而不是抛出', () => {
    expect(parseGlabMrView('')).toBeNull()
    expect(parseGlabMrView('not json')).toBeNull()
    expect(parseGlabMrList('not json')).toBeNull()
  })
})

describe('GitLab MR 链接识别', () => {
  it('支持子组路径并取出 iid', () => {
    expect(parseGitlabMergeRequestUrl('https://gitlab.example.com/group/sub/repo/-/merge_requests/12')).toMatchObject({
      host: 'gitlab.example.com',
      path: 'group/sub/repo',
      iid: 12,
    })
  })

  it('GitHub PR 链接与普通仓库链接不算 GitLab MR', () => {
    expect(isGitlabMergeRequestUrl('https://github.com/o/r/pull/7')).toBe(false)
    expect(isGitlabMergeRequestUrl('https://gitlab.example.com/group/repo')).toBe(false)
    expect(isGitlabMergeRequestUrl('router-agent')).toBe(false)
  })
})

describe('git remote 解析', () => {
  it('保留 host 并识别平台', () => {
    expect(parseGitRemote('git@gitlab.example.com:group/repo.git')).toEqual({
      host: 'gitlab.example.com',
      path: 'group/repo',
      forge: 'gitlab',
    })
    expect(parseGitRemote('https://github.com/o/r.git')).toEqual({
      host: 'github.com',
      path: 'o/r',
      forge: 'github',
    })
    expect(parseGitRemote('ssh://git@git.corp.example.com/group/sub/repo.git')).toEqual({
      host: 'git.corp.example.com',
      path: 'group/sub/repo',
      forge: 'other',
    })
  })

  it('非法 remote 返回 null', () => {
    expect(parseGitRemote('')).toBeNull()
    expect(parseGitRemote('not-a-remote')).toBeNull()
  })
})

describe('GitLabTracker 命令构造与查询', () => {
  function fakeRunner(handle: (argv: string[], opts?: { cwd?: string }) => { code: number; stdout?: string }) {
    const calls: { argv: string[]; cwd?: string }[] = []
    const runner: CommandRunner = {
      async run(argv, opts = {}) {
        calls.push({ argv, ...(opts.cwd ? { cwd: opts.cwd } : {}) })
        const result = handle(argv, opts)
        return { code: result.code, stdout: result.stdout ?? '', stderr: '' }
      },
    }
    return { runner, calls }
  }

  const merged = (iid: number) => JSON.stringify({
    iid,
    web_url: `https://gitlab.example.com/g/r/-/merge_requests/${iid}`,
    state: 'merged',
    title: 't',
    source_branch: 'ra/tk1',
  })

  it('有 workdir 时用 cwd 让 glab 从 remote 推断项目', async () => {
    const { runner, calls } = fakeRunner(argv => argv.includes('view') ? { code: 0, stdout: merged(12) } : { code: 1 })
    const info = await new GitLabTracker(runner).view('group/repo', 12, { cwd: '/tmp/wt' })

    expect(info?.state).toBe('merged')
    expect(calls[0]?.argv).toEqual(['mr', 'view', '12', '--output', 'json'])
    expect(calls[0]?.cwd).toBe('/tmp/wt')
  })

  it('没有 workdir 时用 MR 链接推导 --repo', async () => {
    const { runner, calls } = fakeRunner(() => ({ code: 0, stdout: merged(12) }))
    await new GitLabTracker(runner).view('g/r', 12, { url: 'https://gitlab.example.com/g/r/-/merge_requests/12' })

    expect(calls[0]?.argv).toEqual([
      'mr', 'view', '12', '--output', 'json',
      '--repo', 'https://gitlab.example.com/g/r',
    ])
  })

  it('按分支反查时带上 --all，合并/关闭后也能查到', async () => {
    const { runner, calls } = fakeRunner(() => ({ code: 0, stdout: JSON.stringify([JSON.parse(merged(7))]) }))
    const info = await new GitLabTracker(runner).findByBranch('group/repo', 'ra/tk1', { cwd: '/tmp/wt' })

    expect(info?.number).toBe(7)
    expect(calls[0]?.argv).toEqual([
      'mr', 'list', '--source-branch', 'ra/tk1', '--all', '--output', 'json',
    ])
  })

  it('命令构造包含 --repo 时放在输出参数之后', () => {
    expect(glabMrViewCommand(3, { repo: 'https://gitlab.example.com/g/r' })).toEqual([
      'mr', 'view', '3', '--output', 'json', '--repo', 'https://gitlab.example.com/g/r',
    ])
    expect(glabMrListCommand('ra/tk3', { repo: 'g/r' })).toContain('--all')
  })

  it('glab 失败时返回 null', async () => {
    const { runner } = fakeRunner(() => ({ code: 1 }))
    expect(await new GitLabTracker(runner).view('group/repo', 12, { cwd: '/tmp/wt' })).toBeNull()
  })
})
