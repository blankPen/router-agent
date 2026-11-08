import { isAbsolute, resolve } from 'node:path'
import type { CommandRunner } from '../../infra/process.js'
import { WorkerBackendError, type WorkspaceInfo, type WorkspaceProvider, type WorkspaceRequest, type Workspace } from '../port.js'

export interface GitWorktreeProviderOptions {
  git: CommandRunner
  /** 允许创建工作区的根目录；用于防止路径越界。为空表示不限制。 */
  worktreesRoot?: string
}

/**
 * 纯 git worktree 实现：只负责隔离目录与分支，不负责启动 Agent。
 * 所有位置参数前加 `--`，分支名先过 check-ref-format，避免选项注入。
 */
export class GitWorktreeProvider implements WorkspaceProvider {
  readonly id = 'git-worktree'
  private git: CommandRunner
  private worktreesRoot?: string

  constructor(opts: GitWorktreeProviderOptions) {
    this.git = opts.git
    this.worktreesRoot = opts.worktreesRoot ? resolve(opts.worktreesRoot) : undefined
  }

  async create(req: WorkspaceRequest): Promise<Workspace> {
    const repoPath = this.repoPathOf(req.repo)
    const base = req.baseBranch.trim()
    const branch = req.workBranch.trim()
    if (!base) throw new WorkerBackendError('workspace:missing-branch', '起始分支为空，拒绝创建 worktree')
    if (!branch) throw new WorkerBackendError('workspace:missing-branch', '工作分支为空，拒绝创建 worktree')
    await this.assertBranch(base, repoPath)
    await this.assertBranch(branch, repoPath)
    const workdir = this.assertWorkdir(req.workdir)
    const res = await this.git.run(['worktree', 'add', '-b', branch, '--', workdir, base], { cwd: repoPath })
    if (res.code !== 0) {
      throw new WorkerBackendError('workspace:create-failed', `git worktree add 失败: ${res.stderr || res.stdout}`, {
        cause: res.stderr || res.stdout,
        detail: { workdir, branch, repo: repoPath },
      })
    }
    const actual = await this.git.run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workdir })
    return {
      workspaceRef: workdir,
      workdir,
      branch: actual.code === 0 ? actual.stdout.trim() : branch,
    }
  }

  async inspect(ref: string): Promise<WorkspaceInfo | null> {
    const workdir = this.assertWorkdir(ref)
    const branchRes = await this.git.run(['-C', workdir, 'rev-parse', '--abbrev-ref', 'HEAD'])
    if (branchRes.code !== 0) return null
    const statusRes = await this.git.run(['-C', workdir, 'status', '--porcelain'])
    return {
      workdir,
      branch: branchRes.stdout.trim(),
      ...(statusRes.code === 0 ? { dirty: statusRes.stdout.trim().length > 0 } : {}),
    }
  }

  async remove(ref: string): Promise<void> {
    const workdir = this.assertWorkdir(ref)
    const res = await this.git.run(['worktree', 'remove', '--', workdir])
    if (res.code !== 0) {
      throw new WorkerBackendError('workspace:remove-failed', `git worktree remove 失败: ${res.stderr || res.stdout}`, {
        cause: res.stderr || res.stdout,
        detail: { workdir },
      })
    }
  }

  /** 删除本次新建的分支；只用于 launch 失败回滚。 */
  async deleteBranch(branch: string, repoPath: string): Promise<void> {
    const path = this.repoPathOf(repoPath)
    await this.assertBranch(branch, path)
    const res = await this.git.run(['branch', '-D', '--', branch], { cwd: path })
    if (res.code !== 0) {
      throw new WorkerBackendError('workspace:remove-failed', `git branch -D 失败: ${res.stderr || res.stdout}`, {
        cause: res.stderr || res.stdout,
        detail: { branch, repo: path },
      })
    }
  }

  async version(): Promise<string | null> {
    const res = await this.git.run(['--version'])
    return res.code === 0 ? res.stdout.trim() : null
  }

  private async assertBranch(branch: string, repoPath: string): Promise<void> {
    if (branch.startsWith('-')) {
      throw new WorkerBackendError('workspace:missing-branch', `非法分支名: ${branch}`)
    }
    const res = await this.git.run(['check-ref-format', '--branch', branch], { cwd: repoPath })
    if (res.code !== 0) {
      throw new WorkerBackendError('workspace:missing-branch', `非法分支名: ${branch}`)
    }
  }

  private repoPathOf(repo: string): string {
    const path = repo.trim().replace(/^(id|name|path):/, '')
    if (!path || !isAbsolute(path)) {
      throw new WorkerBackendError('workspace:missing-repo', `git worktree 需要本地仓库绝对路径（path:/abs），收到: ${repo}`)
    }
    return resolve(path)
  }

  private assertWorkdir(input?: string): string {
    if (!input) throw new WorkerBackendError('workspace:create-failed', 'workdir 为空')
    if (input.includes('..')) throw new WorkerBackendError('workspace:create-failed', `workdir 不允许包含 ..: ${input}`)
    const workdir = isAbsolute(input) ? resolve(input) : resolve(input)
    if (this.worktreesRoot && !workdir.startsWith(`${this.worktreesRoot}/`) && workdir !== this.worktreesRoot) {
      throw new WorkerBackendError('workspace:create-failed', `workdir 越界: ${workdir}`)
    }
    return workdir
  }
}