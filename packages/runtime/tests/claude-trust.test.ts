import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeTrustKey, ensureClaudeBackgroundReady } from '#runtime/agents/claude-trust.js'

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'ra-claude-trust-'))
}

describe('ensureClaudeBackgroundReady', () => {
  it('未信任的目录会补齐目录信任与免责提示', () => {
    const home = tempHome()
    const workdir = join(home, 'worktrees', 'tk-1')
    const result = ensureClaudeBackgroundReady(workdir, { home })

    expect(result.ready).toBe(true)
    expect(result.added).toEqual(['bypassPermissionsModeAccepted', 'workspaceTrust'])
    const config = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
    expect(config.bypassPermissionsModeAccepted).toBe(true)
    expect(config.projects[claudeTrustKey(workdir)].hasTrustDialogAccepted).toBe(true)
  })

  it('已经满足条件时不动配置文件', () => {
    const home = tempHome()
    const workdir = join(home, 'worktrees', 'tk-1')
    ensureClaudeBackgroundReady(workdir, { home })
    const path = join(home, '.claude.json')
    const before = readFileSync(path, 'utf8')

    const result = ensureClaudeBackgroundReady(workdir, { home })
    expect(result.ready).toBe(true)
    expect(result.added).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('配置文件损坏时报告原因且不覆盖原文件', () => {
    const home = tempHome()
    const path = join(home, '.claude.json')
    writeFileSync(path, '{ 不是 JSON', 'utf8')

    const result = ensureClaudeBackgroundReady(join(home, 'worktrees', 'tk-1'), { home })
    expect(result.ready).toBe(false)
    expect(result.reason).toContain('Claude 配置')
    expect(readFileSync(path, 'utf8')).toBe('{ 不是 JSON')
  })
})
