import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandResult, CommandRunner } from '#infra/process.js'
import {
  ProjectSetup,
  ProjectSetupError,
  isGitUrl,
  projectNameFromGitUrl,
} from '../../src/router/project-setup.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function initRepo(dir: string, branch = 'main'): string {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-b', branch)
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'init')
  return dir
}

function real(path: string): string {
  return realpathSync.native(path)
}

function result(stdout = '', code = 0, stderr = ''): CommandResult {
  return { code, stdout, stderr }
}

function fakeRunner(handler: (argv: string[]) => CommandResult): CommandRunner & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    async run(argv) {
      calls.push(argv)
      return handler(argv)
    },
  }
}

describe('项目登记：Git 地址解析', () => {
  it('接受 ssh / http(s) / git 协议与 git@host:path', () => {
    expect(isGitUrl('git@gitlab.example.com:group/repo.git')).toBe(true)
    expect(isGitUrl('https://github.com/owner/repo.git')).toBe(true)
    expect(isGitUrl('ssh://git@host/owner/repo.git')).toBe(true)
    expect(isGitUrl('file:///tmp/source.git')).toBe(true)
    expect(isGitUrl('ftp://host/repo.git')).toBe(false)
    expect(isGitUrl('--upload-pack=evil')).toBe(false)
    expect(isGitUrl('git@host:owner/repo.git\nrm -rf /')).toBe(false)
  })

  it('从不同写法的地址推导目录名', () => {
    expect(projectNameFromGitUrl('git@gitlab.example.com:pengzhen02/teamwork-repos.git')).toBe('teamwork-repos')
    expect(projectNameFromGitUrl('https://github.com/owner/repo.git')).toBe('repo')
    expect(projectNameFromGitUrl('ssh://git@host/owner/repo/')).toBe('repo')
    expect(projectNameFromGitUrl('https://host/owner/repo?ref=main')).toBe('repo')
    expect(projectNameFromGitUrl('https://host/')).toBe('')
  })
})

describe('项目登记：本地目录探测', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ra-project-setup-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('识别 Git 仓库、根目录与当前分支', async () => {
    const repo = initRepo(join(root, 'router-agent'))
    const setup = new ProjectSetup({ home: join(root, 'home') })
    const info = await setup.inspectDirectory(repo)
    expect(info).toMatchObject({
      path: real(repo),
      name: 'router-agent',
      isGit: true,
      branch: 'main',
      detached: false,
    })
    expect(info.error).toBeUndefined()
  })

  it('选中子目录时回到 Git 根目录', async () => {
    const repo = initRepo(join(root, 'repo'))
    mkdirSync(join(repo, 'src', 'nested'), { recursive: true })
    const setup = new ProjectSetup({ home: join(root, 'home') })
    const info = await setup.inspectDirectory(join(repo, 'src', 'nested'))
    expect(info.path).toBe(real(repo))
    expect(info.name).toBe('repo')
  })

  it('兼容 path: 前缀；非 Git 目录返回 isGit=false', async () => {
    const repo = initRepo(join(root, 'repo'))
    const plain = join(root, 'plain')
    mkdirSync(plain)
    const setup = new ProjectSetup({ home: join(root, 'home') })

    expect((await setup.inspectDirectory(`path:${repo}`)).path).toBe(real(repo))
    const info = await setup.inspectDirectory(plain)
    expect(info.isGit).toBe(false)
    expect(info.error).toContain('不是 Git 仓库')
  })

  it('相对路径与不存在的目录直接报错', async () => {
    const setup = new ProjectSetup({ home: join(root, 'home') })
    await expect(setup.inspectDirectory('./repo')).rejects.toMatchObject({ code: 'path-not-absolute' })
    await expect(setup.inspectDirectory(join(root, 'missing'))).rejects.toMatchObject({ code: 'path-not-found' })
  })

  it('非 Orca 运行时直接写本地绝对路径，不碰 Orca', async () => {
    const repo = initRepo(join(root, 'repo'))
    const orca = fakeRunner(() => result('', 1, 'should-not-run'))
    const setup = new ProjectSetup({ home: join(root, 'home'), orca })
    const prepared = await setup.prepareLocal(repo, 'claude-code')
    expect(prepared.repo).toBe(real(repo))
    expect(prepared.orca).toBeUndefined()
    expect(orca.calls).toHaveLength(0)
  })

  it('Orca 运行时：已登记则复用，未登记则调用 repo add', async () => {
    const repo = initRepo(join(root, 'repo'))
    const existing = fakeRunner(() => result(JSON.stringify({
      result: { repos: [{ displayName: 'repo', path: repo, kind: 'git' }] },
    })))
    const prepared = await new ProjectSetup({ home: join(root, 'home'), orca: existing })
      .prepareLocal(repo, 'orca')
    expect(prepared.repo).toBe(real(repo))
    expect(prepared.orca).toMatchObject({ registered: true, displayName: 'repo' })
    expect(existing.calls.map(argv => argv.slice(0, 2).join(' '))).toEqual(['repo list'])

    const adding = fakeRunner(argv => argv[0] === 'repo' && argv[1] === 'list'
      ? result('{"result":{"repos":[]}}')
      : result('{"result":{"repo":{"displayName":"repo"}}}'))
    const added = await new ProjectSetup({ home: join(root, 'home'), orca: adding })
      .prepareLocal(repo, 'orca')
    expect(added.orca).toMatchObject({ registered: true, displayName: 'repo' })
    expect(adding.calls.some(argv => argv[0] === 'repo' && argv[1] === 'add')).toBe(true)
  })

  it('Orca 不可用时仍返回本地路径草稿并带失败原因', async () => {
    const repo = initRepo(join(root, 'repo'))
    const orca = fakeRunner(() => result('', 1, 'Orca runtime not reachable'))
    const prepared = await new ProjectSetup({ home: join(root, 'home'), orca }).prepareLocal(repo, 'orca')
    expect(prepared.repo).toBe(real(repo))
    expect(prepared.orca).toMatchObject({ registered: false })
    expect(prepared.orca?.error).toContain('not reachable')
  })

  it('非 Git 目录不能登记为项目', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    const setup = new ProjectSetup({ home: join(root, 'home') })
    await expect(setup.prepareLocal(plain, 'claude-code')).rejects.toBeInstanceOf(ProjectSetupError)
    await expect(setup.prepareLocal(plain, 'claude-code')).rejects.toMatchObject({ code: 'not-a-git-repo' })
  })

  it('目录选择器可以由测试注入', async () => {
    const setup = new ProjectSetup({
      home: join(root, 'home'),
      picker: async () => ({ canceled: false, path: join(root, 'picked') }),
    })
    await expect(setup.pickDirectory()).resolves.toEqual({ canceled: false, path: join(root, 'picked') })
  })
})

describe('项目登记：Git 地址 clone', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ra-project-clone-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('clone 到 RA_HOME/repos/<项目名> 并识别分支', async () => {
    const source = initRepo(join(root, 'source'), 'trunk')
    const bare = join(root, 'source.git')
    execFileSync('git', ['clone', '--bare', source, bare])
    const home = join(root, 'home')
    const setup = new ProjectSetup({ home })
    const prepared = await setup.cloneRepository(`file://${bare}`, 'claude-code')

    expect(prepared.isGit).toBe(true)
    expect(prepared.branch).toBe('trunk')
    expect(prepared.repo).toBe(join(real(join(home, 'repos')), 'source'))
    expect(prepared.reused).toBe(false)
    expect(existsSync(join(home, 'repos', 'source', 'README.md'))).toBe(true)
  })

  it('目标目录已存在同远程仓库时复用，不重复 clone', async () => {
    const source = initRepo(join(root, 'source'), 'main')
    const bare = join(root, 'source.git')
    execFileSync('git', ['clone', '--bare', source, bare])
    const home = join(root, 'home')
    const setup = new ProjectSetup({ home })

    await setup.cloneRepository(`file://${bare}`, 'claude-code')
    const second = await setup.cloneRepository(`file://${bare}`, 'claude-code')
    expect(second.reused).toBe(true)
    expect(second.repo).toBe(join(real(join(home, 'repos')), 'source'))
  })

  it('目标目录被其它仓库占用时报错', async () => {
    const source = initRepo(join(root, 'source'), 'main')
    const other = initRepo(join(root, 'other'), 'main')
    const bare = join(root, 'source.git')
    execFileSync('git', ['clone', '--bare', source, bare])
    const home = join(root, 'home')
    mkdirSync(join(home, 'repos'), { recursive: true })
    git(root, 'clone', '--', other, join(home, 'repos', 'source'))

    const setup = new ProjectSetup({ home })
    await expect(setup.cloneRepository(`file://${bare}`, 'claude-code')).rejects.toMatchObject({ code: 'target-exists' })
  })

  it('非法地址与缺失 home 直接拒绝', async () => {
    const setup = new ProjectSetup({ home: join(root, 'home') })
    await expect(setup.cloneRepository('--upload-pack=evil', 'claude-code')).rejects.toMatchObject({ code: 'invalid-url' })
    await expect(new ProjectSetup({ home: '' }).cloneRepository('https://host/a/b.git', 'claude-code'))
      .rejects.toMatchObject({ code: 'home-missing' })
  })
})
