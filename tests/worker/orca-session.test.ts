import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeProjectSlug, latestClaudeSessionId } from '../../src/worker/orca/session.js'

describe('latestClaudeSessionId', () => {
  it('按 workdir 的 slug 目录取最新会话文件名作为 session id', () => {
    const projects = mkdtempSync(join(tmpdir(), 'ra-projects-'))
    const workdir = '/tmp/ra worktree'
    const dir = join(projects, claudeProjectSlug(workdir))
    mkdirSync(dir, { recursive: true })

    const older = join(dir, 'old-session.jsonl')
    const newer = join(dir, 'new-session.jsonl')
    writeFileSync(older, '{}\n')
    writeFileSync(newer, '{}\n')
    utimesSync(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))
    utimesSync(newer, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'))

    expect(latestClaudeSessionId(workdir, { projectsDir: projects })).toBe('new-session')
  })

  it('目录不存在或没有会话文件时返回 null', () => {
    const projects = mkdtempSync(join(tmpdir(), 'ra-projects-'))
    expect(latestClaudeSessionId('/tmp/not-here', { projectsDir: projects })).toBeNull()

    const dir = join(projects, claudeProjectSlug('/tmp/empty'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'notes.txt'), '')
    expect(latestClaudeSessionId('/tmp/empty', { projectsDir: projects })).toBeNull()
  })
})
