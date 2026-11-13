/**
 * 扫描本机历史会话日志里出现过的项目目录。
 *
 * 面板的「扫描本地项目」用它给用户一份候选清单：Claude Code 的项目目录名是
 * cwd 编码后的结果（不可逆），所以路径要从会话内容里读；Codex 与 OpenCode
 * 直接在会话记录里带 cwd / directory。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, statSync, realpathSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/** 会话日志的来源，用来告诉用户这个项目是在哪用过的。 */
export type ProjectScanSource = 'claude' | 'codex' | 'opencode'

export interface ScannedProject {
  /** 本地绝对路径（Git 仓库根目录）。 */
  path: string
  /** 目录名，作为默认项目名。 */
  name: string
  /** 命中这个目录的会话来源。 */
  sources: ProjectScanSource[]
  /** 最近一次活跃时间（ISO）。 */
  lastActiveAt: string
}

export interface ProjectScanOptions {
  /** Claude Code 的项目根目录，默认 ~/.claude/projects。 */
  claudeProjectsDir?: string
  /** Codex 主目录，默认 ~/.codex。 */
  codexHome?: string
  /** OpenCode 数据目录，默认 ~/.local/share/opencode。 */
  opencodeDataDir?: string
  /** 当作临时目录、丢掉候选的根目录；默认是系统临时区。 */
  tempRoots?: string[]
}

/** API 层只依赖这一组能力，方便用假实现写测试。 */
export interface ProjectScanPort {
  scan(): Promise<ScannedProject[]>
}

/** 读会话文件时只看开头这么多字节，够拿到 cwd 就行。 */
const HEAD_BYTES = 64 * 1024
/** 每个 Claude 项目目录最多看几个会话文件。 */
const CLAUDE_FILES_PER_PROJECT = 3
/** 最多返回多少个候选项目。 */
const MAX_PROJECTS = 200

interface Hit {
  path: string
  /** 最近活跃时间（毫秒时间戳）。 */
  at: number
}

/**
 * 扫描三个来源的会话日志，返回按最近活跃时间倒序的候选项目。
 *
 * 两条收敛规则：
 * - worktree 不算项目，会话落在 worktree 上时归并到它所属的主仓库；
 * - 系统临时目录（/tmp、/var/folders 等）直接丢弃。
 */
export async function scanLocalProjects(opts: ProjectScanOptions = {}): Promise<ScannedProject[]> {
  const claudeDir = opts.claudeProjectsDir ?? join(homedir(), '.claude', 'projects')
  const codexHome = opts.codexHome ?? join(homedir(), '.codex')
  const opencodeDir = opts.opencodeDataDir ?? join(homedir(), '.local', 'share', 'opencode')

  const tempRoots = opts.tempRoots ?? TEMP_ROOTS

  const merged = new Map<string, { path: string; at: number; sources: Set<ProjectScanSource> }>()
  const collect = (source: ProjectScanSource, hits: Hit[]): void => {
    for (const hit of hits) {
      const root = resolveProjectRoot(hit.path)
      if (isTemporaryPath(root, tempRoots)) continue
      const key = canonicalPath(root)
      const current = merged.get(key)
      if (current) {
        current.at = Math.max(current.at, hit.at)
        current.sources.add(source)
        continue
      }
      merged.set(key, { path: root, at: hit.at, sources: new Set([source]) })
    }
  }

  collect('claude', await scanClaudeProjects(claudeDir))
  collect('codex', await scanCodexSessions(codexHome))
  collect('opencode', await scanOpenCode(opencodeDir))

  return [...merged.values()]
    // 只有 Git 仓库能创建 worktree，面板也只接受 Git 目录，其它目录直接不进候选。
    .filter(item => isGitRepo(item.path))
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_PROJECTS)
    .map(item => ({
      path: item.path,
      name: basename(item.path),
      sources: [...item.sources],
      lastActiveAt: new Date(item.at).toISOString(),
    }))
}

/** Claude Code：项目目录名是 cwd 编码后的结果，路径从会话内容里读。 */
async function scanClaudeProjects(root: string): Promise<Hit[]> {
  const hits: Hit[] = []
  const entries = await safeReaddir(root)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const files = (await safeReaddir(dir)).filter(file => file.isFile() && file.name.endsWith('.jsonl'))
    if (files.length === 0) continue
    const stats = await Promise.all(files.map(async file => ({
      file,
      at: (await stat(join(dir, file.name)).catch(() => null))?.mtimeMs ?? 0,
    })))
    stats.sort((a, b) => b.at - a.at)

    let cwd = ''
    let at = 0
    for (const item of stats.slice(0, CLAUDE_FILES_PER_PROJECT)) {
      const found = await readCwdFromSession(join(dir, item.file.name))
      if (found) {
        cwd = found
        at = item.at
        break
      }
    }
    if (!cwd) {
      // 会话文件读不出 cwd 时，退回按目录名反推（路径里本来就没有 '-' 时才准）。
      const guess = decodeClaudeSlug(entry.name)
      if (guess && isDirectory(guess)) {
        cwd = guess
        at = stats[0]?.at ?? 0
      }
    }
    if (cwd) hits.push({ path: cwd, at })
  }
  return hits
}

/** Codex：会话首行的 session_meta 带 cwd。 */
async function scanCodexSessions(codexHome: string): Promise<Hit[]> {
  const hits: Hit[] = []
  for (const file of await findSessionFiles(join(codexHome, 'sessions'), 6)) {
    const head = await readHead(file)
    const meta = parseJson(head.split('\n')[0] ?? '')
    const payload = (meta?.payload ?? meta) as Record<string, unknown> | null
    const cwd = typeof payload?.cwd === 'string' ? payload.cwd : ''
    if (!cwd) continue
    const stamp = typeof payload?.timestamp === 'string' ? Date.parse(payload.timestamp) : Number.NaN
    const mtime = (await stat(file).catch(() => null))?.mtimeMs ?? 0
    hits.push({ path: cwd, at: Math.max(mtime, Number.isNaN(stamp) ? 0 : stamp) })
  }
  return hits
}

/** OpenCode：新版存在 opencode.db，老版本是 storage 目录下的 JSON。 */
async function scanOpenCode(dataDir: string): Promise<Hit[]> {
  const hits: Hit[] = []
  const dbPath = join(dataDir, 'opencode.db')
  if (existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        for (const row of db.prepare(
          "select directory as dir, max(time_updated) as at from session where directory is not null and directory != '' group by directory",
        ).all() as Array<{ dir: string; at: number | null }>) {
          hits.push({ path: row.dir, at: Number(row.at ?? 0) })
        }
        for (const row of db.prepare(
          "select worktree as dir, max(time_updated) as at from project where worktree is not null and worktree != '' and worktree != '/' group by worktree",
        ).all() as Array<{ dir: string; at: number | null }>) {
          hits.push({ path: row.dir, at: Number(row.at ?? 0) })
        }
      } finally {
        db.close()
      }
      return hits
    } catch {
      // 数据库读不了（格式变了或被占用）就退回 storage 目录。
    }
  }

  const storage = join(dataDir, 'storage')
  for (const entry of await safeReaddir(join(storage, 'project'))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const data = parseJson(await readFileText(join(storage, 'project', entry.name)))
    const worktree = typeof data?.worktree === 'string' ? data.worktree : ''
    if (worktree) hits.push({ path: worktree, at: Number(data?.time?.updated ?? 0) })
  }
  for (const entry of await safeReaddir(join(storage, 'session'))) {
    if (!entry.isDirectory()) continue
    for (const file of await safeReaddir(join(storage, 'session', entry.name))) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue
      const data = parseJson(await readFileText(join(storage, 'session', entry.name, file.name)))
      const directory = typeof data?.directory === 'string' ? data.directory : ''
      if (directory) hits.push({ path: directory, at: Number(data?.time?.updated ?? 0) })
    }
  }
  return hits
}

/** 读会话文件开头，找第一条带 cwd 的记录。 */
async function readCwdFromSession(file: string): Promise<string> {
  const head = await readHead(file)
  for (const line of head.split('\n')) {
    const record = parseJson(line)
    const cwd = typeof record?.cwd === 'string' ? record.cwd : ''
    if (cwd.startsWith('/')) return cwd
  }
  return ''
}

/** 读取文件开头的一段内容。 */
async function readHead(file: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(file, 'r')
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return ''
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function readFileText(file: string): Promise<string> {
  const handle = await open(file, 'r').catch(() => null)
  if (!handle) return ''
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return ''
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** 递归找会话文件（Codex 按年月日分目录）。 */
async function findSessionFiles(root: string, depth: number): Promise<string[]> {
  const files: string[] = []
  const walk = async (dir: string, level: number): Promise<void> => {
    if (level > depth) return
    for (const entry of await safeReaddir(dir)) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, level + 1)
        continue
      }
      if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) files.push(full)
    }
  }
  await walk(root, 0)
  return files
}

async function safeReaddir(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function parseJson(text: string): Record<string, any> | null {
  if (!text.trim()) return null
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null ? value : null
  } catch {
    return null
  }
}

/** 临时目录：系统临时区里的目录不是项目。 */
const TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders']

/**
 * 归并项目根目录：`.git` 是文件说明这是 git worktree（`.git` 里写着主仓库的
 * `.git/worktrees/<名字>`），归并到主仓库；worktree 本身不是项目，不单独出现。
 */
function resolveProjectRoot(path: string): string {
  const dotGit = join(path, '.git')
  let info: ReturnType<typeof statSync>
  try {
    info = statSync(dotGit)
  } catch {
    return path
  }
  if (info.isDirectory() || !info.isFile()) return path
  const gitdir = readGitdir(dotGit)
  return (gitdir ? mainRepoOf(gitdir) : null) ?? path
}

/** 读 `.git` 文件里的 `gitdir:` 指向。 */
function readGitdir(dotGit: string): string {
  try {
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
    return match ? match[1]!.trim() : ''
  } catch {
    return ''
  }
}

/** 从 `<主仓库>/.git/worktrees/<名字>` 推出主仓库路径。 */
function mainRepoOf(gitdir: string): string | null {
  const match = /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(gitdir)
  return match ? match[1]! : null
}

/** 是不是 git 仓库：`.git` 是目录才算（worktree 的 `.git` 是文件）。 */
function isGitRepo(path: string): boolean {
  try {
    return statSync(join(path, '.git')).isDirectory()
  } catch {
    return false
  }
}

/** 系统临时目录下的路径直接丢弃。 */
function isTemporaryPath(path: string, roots: string[]): boolean {
  const value = path.replace(/\/+$/, '')
  return roots.some(root => value === root || value.startsWith(`${root.replace(/\/+$/, '')}/`))
}

/** Claude Code 的项目目录名：cwd 里非字母数字字符全换成 '-'。 */
function decodeClaudeSlug(slug: string): string {
  const path = slug.replace(/-/g, '/')
  return path.startsWith('/') ? path : ''
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 同一目录可能有多个写法（软链接），用真实路径做去重键。 */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
