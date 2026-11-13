import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { scanLocalProjects } from '../../src/router/project-scan.js'

describe('扫描本地项目', () => {
  let root: string
  let claudeDir: string
  let codexHome: string
  let opencodeDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ra-scan-'))
    claudeDir = join(root, 'claude', 'projects')
    codexHome = join(root, 'codex')
    opencodeDir = join(root, 'opencode')
    mkdirSync(claudeDir, { recursive: true })
    mkdirSync(codexHome, { recursive: true })
    mkdirSync(opencodeDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** 造一个真实存在的项目目录。 */
  function makeProject(name: string): string {
    const path = join(root, 'workspaces', name)
    mkdirSync(path, { recursive: true })
    return path
  }

  /** Claude Code 的项目目录名是 cwd 的非字母数字字符替换成 '-'。 */
  function claudeSession(cwd: string, sessionId: string, mtime: string): void {
    const dir = join(claudeDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${sessionId}.jsonl`)
    writeFileSync(
      file,
      `${JSON.stringify({ type: 'mode', mode: 'normal' })}\n${JSON.stringify({ type: 'user', cwd, timestamp: mtime })}\n`,
    )
    const time = new Date(mtime)
    utimesSync(file, time, time)
  }

  function codexSession(cwd: string, mtime: string): void {
    const dir = join(codexHome, 'sessions', '2026', '01', '02')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'rollout-2026-01-02T00-00-00-11111111-2222-3333-4444-555555555555.jsonl')
    writeFileSync(
      file,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd, timestamp: mtime } })}\n`,
    )
    const time = new Date(mtime)
    utimesSync(file, time, time)
  }

  function opencodeDb(rows: Array<[string, number]>): void {
    const db = new DatabaseSync(join(opencodeDir, 'opencode.db'))
    db.exec('create table session (id text primary key, directory text, time_updated integer)')
    db.exec('create table project (id text primary key, worktree text, time_updated integer)')
    const insertSession = db.prepare('insert into session (id, directory, time_updated) values (?, ?, ?)')
    const insertProject = db.prepare('insert into project (id, worktree, time_updated) values (?, ?, ?)')
    rows.forEach(([directory, at], index) => {
      insertSession.run(`ses_${index}`, directory, at)
      insertProject.run(`prj_${index}`, directory, at)
    })
    db.close()
  }

  it('从 Claude Code 会话日志读出项目目录', async () => {
    const alpha = makeProject('alpha')
    claudeSession(alpha, 'sess-1', '2026-01-02T00:00:00.000Z')

    const projects = await scanLocalProjects({ claudeProjectsDir: claudeDir, codexHome, opencodeDataDir: opencodeDir })

    expect(projects.map(item => item.path)).toEqual([alpha])
    expect(projects[0]?.sources).toEqual(['claude'])
    expect(projects[0]?.name).toBe('alpha')
  })

  it('从 Codex 会话日志读出项目目录', async () => {
    const beta = makeProject('beta')
    codexSession(beta, '2026-01-03T00:00:00.000Z')

    const projects = await scanLocalProjects({ claudeProjectsDir: claudeDir, codexHome, opencodeDataDir: opencodeDir })

    expect(projects.map(item => item.path)).toEqual([beta])
    expect(projects[0]?.sources).toEqual(['codex'])
  })

  it('从 OpenCode 数据库读出项目目录', async () => {
    const gamma = makeProject('gamma')
    opencodeDb([[gamma, Date.parse('2026-01-05T00:00:00.000Z')]])

    const projects = await scanLocalProjects({ claudeProjectsDir: claudeDir, codexHome, opencodeDataDir: opencodeDir })

    expect(projects.map(item => item.path)).toEqual([gamma])
    expect(projects[0]?.sources).toEqual(['opencode'])
  })

  it('同一目录被多个来源命中时合并来源并取最近活跃时间', async () => {
    const delta = makeProject('delta')
    claudeSession(delta, 'sess-2', '2026-01-01T00:00:00.000Z')
    codexSession(delta, '2026-01-02T00:00:00.000Z')
    opencodeDb([[delta, Date.parse('2026-01-09T00:00:00.000Z')]])

    const projects = await scanLocalProjects({ claudeProjectsDir: claudeDir, codexHome, opencodeDataDir: opencodeDir })

    expect(projects).toHaveLength(1)
    expect(projects[0]?.sources).toEqual(['claude', 'codex', 'opencode'])
    expect(projects[0]?.lastActiveAt).toBe('2026-01-09T00:00:00.000Z')
  })

  it('按最近活跃时间倒序排列', async () => {
    const older = makeProject('older')
    const newer = makeProject('newer')
    claudeSession(older, 'sess-old', '2026-01-01T00:00:00.000Z')
    claudeSession(newer, 'sess-new', '2026-01-05T00:00:00.000Z')

    const projects = await scanLocalProjects({ claudeProjectsDir: claudeDir, codexHome, opencodeDataDir: opencodeDir })

    expect(projects.map(item => item.name)).toEqual(['newer', 'older'])
  })

  it('跳过目录已不存在的会话记录', async () => {
    claudeSession(join(root, 'workspaces', 'gone'), 'sess-gone', '2026-01-02T00:00:00.000Z')

    const projects = await scanLocalProjects({ claudeProjectsDir: claudeDir, codexHome, opencodeDataDir: opencodeDir })

    expect(projects).toEqual([])
  })

  it('标记是否 Git 仓库', async () => {
    const plain = makeProject('plain')
    const repo = makeProject('repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    claudeSession(plain, 'sess-plain', '2026-01-02T00:00:00.000Z')
    claudeSession(repo, 'sess-repo', '2026-01-02T00:00:00.000Z')

    const projects = await scanLocalProjects({ claudeProjectsDir: claudeDir, codexHome, opencodeDataDir: opencodeDir })

    expect(projects.find(item => item.path === plain)?.isGit).toBe(false)
    expect(projects.find(item => item.path === repo)?.isGit).toBe(true)
  })
})
