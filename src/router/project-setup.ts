import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { realRunner, type CommandRunner } from '#infra/process.js'
import { parseOrcaRepos } from '@router-agent/channel-feishu'
import { normalizeRuntimeId, ORCA_RUNTIME_ID } from '#runtime/runtimes/catalog.js'

/** 目录选择结果：用户取消时 canceled=true，path 为空。 */
export interface PickedDirectory {
  canceled: boolean
  path: string
}

/** 本地目录探测结果。不是 Git 仓库时 isGit=false，error 里带一句可展示的说明。 */
export interface RepoInspection {
  path: string
  name: string
  isGit: boolean
  branch: string
  /** HEAD 处于游离状态时为 true，此时 branch 为空。 */
  detached: boolean
  remoteUrl: string
  error?: string
}

/** 登记到 Orca 的结果；Orca 没开或命令失败时 registered=false，但项目仍可先写进配置。 */
export interface OrcaRegistration {
  registered: boolean
  repo: string
  displayName: string
  error?: string
}

/** 准备完成后可直接写进 projects 清单的草稿。 */
export interface PreparedProject extends RepoInspection {
  repo: string
  orca?: OrcaRegistration
  /** Git 项目：目标目录已存在同远程仓库时复用，没有重复 clone。 */
  reused?: boolean
}

/** 前端能直接展示的项目登记错误。 */
export class ProjectSetupError extends Error {
  readonly code: string
  readonly detail?: Record<string, unknown>

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.name = 'ProjectSetupError'
    this.code = code
    this.detail = detail
  }
}

export interface ProjectSetupOptions {
  /** RA_HOME，Git 项目默认 clone 到 <home>/repos/<name>。 */
  home: string
  git?: CommandRunner
  orca?: CommandRunner
  /** 直接注入目录选择器（测试用）；默认按平台调用系统弹框。 */
  picker?: () => Promise<PickedDirectory>
  platform?: NodeJS.Platform
}

/** API 层只依赖这一组能力，方便用假实现写测试。 */
export interface ProjectSetupPort {
  pickDirectory(): Promise<PickedDirectory>
  inspectDirectory(path: string): Promise<RepoInspection>
  prepareLocal(path: string, runtimeId: string): Promise<PreparedProject>
  cloneRepository(url: string, runtimeId: string): Promise<PreparedProject>
}

const CLONE_TIMEOUT_MS = 10 * 60 * 1_000
const GIT_URL_PATTERN = /^(?:https?|ssh|git|file):\/\/[^\s]+$/i
/** scp 风格：git@host:owner/repo.git（也允许其它用户与自定义 SSH 别名）。 */
const SCP_URL_PATTERN = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/

/**
 * 本地项目登记：目录选择、Git 仓库探测、Git 地址 clone、Orca 仓库登记。
 *
 * 面板和 Router 跑在同一台机器上，所以目录选择框由服务端调用系统原生弹框
 * （浏览器拿不到本地绝对路径）。macOS 用 osascript，Linux 用 zenity，
 * Windows 用 PowerShell；任一平台失败都会让前端退回手输路径。
 */
export class ProjectSetup implements ProjectSetupPort {
  private readonly home: string
  private readonly git: CommandRunner
  private readonly orca: CommandRunner
  private readonly picker?: () => Promise<PickedDirectory>
  private readonly platform: NodeJS.Platform

  constructor(opts: ProjectSetupOptions) {
    this.home = opts.home
    this.git = opts.git ?? realRunner('git')
    this.orca = opts.orca ?? realRunner('orca')
    this.picker = opts.picker
    this.platform = opts.platform ?? process.platform
  }

  async pickDirectory(): Promise<PickedDirectory> {
    if (this.picker) return this.picker()
    if (this.platform === 'darwin') {
      const res = await realRunner('osascript').run([
        '-e',
        'POSIX path of (choose folder with prompt "选择本地项目目录")',
      ])
      if (res.code !== 0) {
        if (/user canceled|-128/i.test(res.stderr)) return { canceled: true, path: '' }
        throw new ProjectSetupError('picker-failed', res.stderr.trim() || '无法打开目录选择框')
      }
      const path = cleanPickedPath(res.stdout)
      return path ? { canceled: false, path } : { canceled: true, path: '' }
    }

    if (this.platform === 'linux') {
      const res = await realRunner('zenity').run(['--file-selection', '--directory', '--title=选择本地项目目录'])
      if (res.code !== 0) {
        if (res.code === 1 && !res.stderr.trim()) return { canceled: true, path: '' }
        throw new ProjectSetupError('picker-failed', res.stderr.trim() || '无法打开目录选择框')
      }
      const path = cleanPickedPath(res.stdout)
      return path ? { canceled: false, path } : { canceled: true, path: '' }
    }

    if (this.platform === 'win32') {
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
        '$d.Description = "选择本地项目目录";',
        'if ($d.ShowDialog() -eq "OK") { $d.SelectedPath }',
      ].join(' ')
      const res = await realRunner('powershell').run(['-NoProfile', '-NonInteractive', '-STA', '-Command', script])
      if (res.code !== 0) {
        throw new ProjectSetupError('picker-failed', res.stderr.trim() || '无法打开目录选择框')
      }
      const path = cleanPickedPath(res.stdout)
      return path ? { canceled: false, path } : { canceled: true, path: '' }
    }

    throw new ProjectSetupError('picker-unsupported', `当前平台 ${this.platform} 不支持原生目录选择，请手动填写绝对路径`)
  }

  async inspectDirectory(input: string): Promise<RepoInspection> {
    const path = this.normalizeLocalPath(input)
    if (!existsSync(path)) {
      throw new ProjectSetupError('path-not-found', `目录不存在：${path}`)
    }
    if (!statSync(path).isDirectory()) {
      throw new ProjectSetupError('not-a-directory', `不是目录：${path}`)
    }
    // macOS 的 /var → /private/var 等软链接会让同一个目录出现两种字符串，统一成真实路径。
    const real = canonicalPath(path)

    const inside = await this.git.run(['-C', real, 'rev-parse', '--is-inside-work-tree'])
    const bare = await this.git.run(['-C', real, 'rev-parse', '--is-bare-repository'])
    const isWorkTree = inside.code === 0 && inside.stdout.trim() === 'true'
    const isBare = bare.code === 0 && bare.stdout.trim() === 'true'
    if (!isWorkTree && !isBare) {
      return {
        path: real,
        name: basename(real),
        isGit: false,
        branch: '',
        detached: false,
        remoteUrl: '',
        error: '该目录不是 Git 仓库',
      }
    }

    const rootRes = isWorkTree ? await this.git.run(['-C', real, 'rev-parse', '--show-toplevel']) : null
    const root = rootRes?.code === 0 && rootRes.stdout.trim() ? canonicalPath(rootRes.stdout.trim()) : real

    let branch = ''
    let detached = false
    const symbolic = await this.git.run(['-C', root, 'symbolic-ref', '--short', '-q', 'HEAD'])
    if (symbolic.code === 0) {
      branch = symbolic.stdout.trim()
    } else {
      const abbrev = await this.git.run(['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'])
      const value = abbrev.code === 0 ? abbrev.stdout.trim() : ''
      if (value === 'HEAD') detached = true
      else branch = value
    }

    const remote = await this.git.run(['-C', root, 'remote', 'get-url', 'origin'])
    return {
      path: root,
      name: basename(root),
      isGit: true,
      branch,
      detached,
      remoteUrl: remote.code === 0 ? remote.stdout.trim() : '',
    }
  }

  /** 本地项目：探测后（Orca 运行时）登记到 Orca，返回可直接写配置的草稿。 */
  async prepareLocal(input: string, runtimeId: string): Promise<PreparedProject> {
    const inspection = await this.inspectDirectory(input)
    if (!inspection.isGit) {
      throw new ProjectSetupError('not-a-git-repo', `不是 Git 仓库，无法创建 worktree：${inspection.path}`)
    }
    return this.withRuntimeRepo(inspection, runtimeId)
  }

  /**
   * Git 项目：clone 到 <home>/repos/<name> 并初始化；Orca 运行时同时登记为仓库。
   * 目标目录已存在且远程一致时直接复用，方便失败后重试。
   */
  async cloneRepository(rawUrl: string, runtimeId: string): Promise<PreparedProject> {
    const url = rawUrl.trim()
    if (!isGitUrl(url)) {
      throw new ProjectSetupError('invalid-url', '请填写 ssh 或 http(s) 的 Git 地址，例如 git@host:owner/repo.git')
    }
    if (!this.home) {
      throw new ProjectSetupError('home-missing', 'RA_HOME 未初始化，无法确定 clone 目录')
    }

    const name = projectNameFromGitUrl(url)
    if (!name) {
      throw new ProjectSetupError('invalid-url', `无法从 Git 地址解析项目名：${url}`)
    }
    const reposDir = join(this.home, 'repos')
    mkdirSync(reposDir, { recursive: true })
    // repos 目录本身也按真实路径算，避免 RA_HOME 指向软链接时配置里出现两种写法。
    const target = join(canonicalPath(reposDir), name)
    let reused = false

    if (existsSync(target)) {
      const existing = await this.inspectDirectory(target)
      if (!existing.isGit || existing.path !== target) {
        throw new ProjectSetupError('target-exists', `目标目录已存在且不是独立的 Git 仓库：${target}`)
      }
      if (!sameRemote(existing.remoteUrl, url)) {
        throw new ProjectSetupError(
          'target-exists',
          `目标目录已被其它仓库占用：${target}（origin=${existing.remoteUrl || '未知'}）`,
        )
      }
      reused = true
      const prepared = await this.withRuntimeRepo(existing, runtimeId)
      return { ...prepared, reused }
    }

    const cloned = await this.git.run(['clone', '--', url, target], { timeoutMs: CLONE_TIMEOUT_MS })
    if (cloned.code !== 0) {
      throw new ProjectSetupError('clone-failed', `git clone 失败：${(cloned.stderr || cloned.stdout).trim()}`, {
        url,
        target,
      })
    }

    const inspection = await this.inspectDirectory(target)
    const prepared = await this.withRuntimeRepo(inspection, runtimeId)
    return { ...prepared, reused }
  }

  /**
   * Orca 运行时用 `orca repo add` 把目录登记成项目，配置里写 `path:<abs>`
   * （避免 displayName 重名）；其它运行时直接写本地绝对路径。
   */
  private async withRuntimeRepo(inspection: RepoInspection, runtimeId: string): Promise<PreparedProject> {
    if (normalizeRuntimeId(runtimeId) !== ORCA_RUNTIME_ID) {
      return { ...inspection, repo: inspection.path }
    }
    const orca = await this.registerOrcaRepo(inspection.path)
    return { ...inspection, repo: orca.repo, orca }
  }

  private async registerOrcaRepo(path: string): Promise<OrcaRegistration> {
    const selector = `path:${path}`
    const listed = await this.orca.run(['repo', 'list', '--json'])
    if (listed.code !== 0) {
      return {
        registered: false,
        repo: selector,
        displayName: basename(path),
        error: (listed.stderr || listed.stdout).trim() || 'orca repo list 执行失败',
      }
    }

    const existing = parseOrcaRepos(listed.stdout).find(repo => repo.path && canonicalPath(repo.path) === path)
    if (existing) {
      return { registered: true, repo: selector, displayName: existing.name }
    }

    const added = await this.orca.run(['repo', 'add', '--path', path, '--kind', 'git', '--json'])
    if (added.code !== 0) {
      return {
        registered: false,
        repo: selector,
        displayName: basename(path),
        error: (added.stderr || added.stdout).trim() || 'orca repo add 执行失败',
      }
    }
    return { registered: true, repo: selector, displayName: parseOrcaAddedName(added.stdout) || basename(path) }
  }

  private normalizeLocalPath(input: string): string {
    const value = input.trim().replace(/^path:/, '')
    if (!value) throw new ProjectSetupError('path-required', '请先选择或填写本地目录')
    if (!isAbsolute(value)) {
      throw new ProjectSetupError('path-not-absolute', `请填写绝对路径：${value}`)
    }
    return resolve(value)
  }
}

/** 是否是面板可接受的 Git 地址（ssh / http / git 协议，或 git@host:path）。 */
export function isGitUrl(value: string): boolean {
  const url = value.trim()
  if (!url || url.startsWith('-') || /[\r\n]/.test(url)) return false
  return GIT_URL_PATTERN.test(url) || SCP_URL_PATTERN.test(url)
}

/** 从 Git 地址推导目录名：https://host/a/b.git → b，git@host:a/b.git → b。 */
export function projectNameFromGitUrl(value: string): string {
  const url = value.trim().replace(/[?#].*$/, '').replace(/\/+$/, '')
  let last = ''
  if (SCP_URL_PATTERN.test(url)) {
    const colon = url.lastIndexOf(':')
    last = colon >= 0 ? url.slice(colon + 1) : url
  } else {
    try {
      last = new URL(url).pathname
    } catch {
      last = url
    }
  }
  const segment = last.split('/').filter(Boolean).pop() ?? ''
  const name = segment.replace(/\.git$/i, '').replace(/[\\:*?"<>|]+/g, '-').replace(/^\.+/, '').trim()
  return name && name !== '.' && name !== '..' ? name : ''
}

/** 去掉 osascript 返回值的尾随换行与目录尾斜杠。 */
function cleanPickedPath(stdout: string): string {
  const raw = stdout.trim().replace(/\r?\n.*$/s, '')
  if (!raw) return ''
  const path = canonicalPath(raw)
  return path === '/' ? path : path.replace(/\/+$/, '')
}

/** 取真实路径；路径不存在或解析失败时退回 resolve，保证调用方拿到绝对路径。 */
function canonicalPath(value: string): string {
  const absolute = resolve(value)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

/** 两个 Git 地址是否指向同一个远程；忽略协议、用户名与 .git 后缀差异。 */
function sameRemote(left: string, right: string): boolean {
  return normalizeRemote(left) === normalizeRemote(right)
}

function normalizeRemote(value: string): string {
  return value
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .replace(/^[\w.-]+@([^:]+):/, '$1/')
    .replace(/^(?:https?|ssh|git|file):\/\/(?:[^@/]+@)?/i, '')
    .toLowerCase()
}

/** `orca repo add --json` 的返回结构在不同 Orca 版本里略有差异，这里做兼容解析。 */
function parseOrcaAddedName(stdout: string): string {
  try {
    const doc = JSON.parse(stdout) as Record<string, any>
    const result = doc?.result ?? doc
    return String(
      result?.repo?.displayName
      ?? result?.displayName
      ?? result?.repos?.[0]?.displayName
      ?? '',
    )
  } catch {
    return ''
  }
}
