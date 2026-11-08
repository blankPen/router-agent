import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandResult, CommandRunner } from '../../src/infra/process.js'
import { GitWorktreeProvider, parseGitHubRepo } from '../../src/worker/workspaces/git-worktree.js'
import { WorkerBackendError } from '../../src/worker/port.js'

interface Call {
  argv: string[]
  cwd?: string
}

function scripted(handler: (argv: string[], cwd?: string) => CommandResult): CommandRunner & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    async run(argv, opts) {
      calls.push({ argv, ...(opts?.cwd ? { cwd: opts.cwd } : {}) })
      return handler(argv, opts?.cwd)
    },
  }
}

function repo(): string {
  return mkdtempSync(join(tmpdir(), 'ra-repo-'))
}

describe('GitWorktreeProvider', () => {
  it('分支已存在时加数字后缀，避免重新派工撞冲突', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ra-wt-'))
    let showRefCalls = 0
    const git = scripted(argv => {
      if (argv[0] === 'check-ref-format') return { code: 0, stdout: '', stderr: '' }
      if (argv[0] === 'show-ref') {
        showRefCalls += 1
        return { code: showRefCalls === 1 ? 0 : 1, stdout: '', stderr: '' }
      }
      if (argv[0] === 'worktree' && argv[1] === 'add') return { code: 0, stdout: '', stderr: '' }
      if (argv[0] === 'rev-parse') return { code: 0, stdout: 'ra/tk-1-demo-2\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const provider = new GitWorktreeProvider({ git, worktreesRoot: root })
    const workspace = await provider.create({
      ticketId: 'tk-1',
      repo: repo(),
      baseBranch: 'main',
      workBranch: 'ra/tk-1-demo',
      name: 'ra-tk-1-demo',
      workdir: join(root, 'ra-tk-1-demo'),
    })
    expect(workspace.branch).toBe('ra/tk-1-demo-2')
    const add = git.calls.find(call => call.argv[0] === 'worktree' && call.argv[1] === 'add')
    expect(add?.argv).toContain('ra/tk-1-demo-2')
    expect(add?.argv.some(arg => arg.endsWith('ra-tk-1-demo-2'))).toBe(true)
  })

  it('拒绝相对路径仓库和越界 workdir', async () => {
    const git = scripted(() => ({ code: 0, stdout: '', stderr: '' }))
    const provider = new GitWorktreeProvider({ git, worktreesRoot: '/tmp/ra-root' })
    await expect(provider.create({
      ticketId: 'tk-1', repo: 'acme/web', baseBranch: 'main', workBranch: 'ra/x', name: 'x', workdir: '/tmp/ra-root/x',
    })).rejects.toBeInstanceOf(WorkerBackendError)
    await expect(provider.create({
      ticketId: 'tk-1', repo: '/tmp/repo', baseBranch: 'main', workBranch: 'ra/x', name: 'x', workdir: '/etc/x',
    })).rejects.toBeInstanceOf(WorkerBackendError)
  })

  it('从 origin 解析 owner/repo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ra-wt-'))
    const workdir = join(root, 'wt')
    const git = scripted(argv => {
      if (argv[0] === 'remote') return { code: 0, stdout: 'git@github.com:acme/web.git\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const provider = new GitWorktreeProvider({ git, worktreesRoot: root })
    expect(await provider.remoteRepo(workdir)).toBe('acme/web')
    expect(parseGitHubRepo('https://github.com/acme/web.git')).toBe('acme/web')
  })
})