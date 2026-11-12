import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentProfileOf, resolveSession, resolveSessionId } from '#runtime/agents/registry.js'
import { readCodexSession } from '#runtime/agents/codex.js'
import { claudeProjectSlug } from '#runtime/agents/claude.js'

const NL = String.fromCharCode(10)

/** 造一份 Codex rollout：目录按日期分，cwd 写在首行 session_meta 里。 */
function writeCodexSession(root: string, workdir: string, sessionId: string): void {
  const dir = join(root, 'sessions', '2026', '11', '11')
  mkdirSync(dir, { recursive: true })
  const lines = [
    JSON.stringify({ timestamp: '2026-11-11T12:50:55.951Z', type: 'session_meta', payload: { session_id: sessionId, id: sessionId, cwd: workdir } }),
    JSON.stringify({ timestamp: '2026-11-11T12:51:05.272Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我在改 README' }] } }),
    JSON.stringify({ timestamp: '2026-11-11T12:51:06.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"pnpm test --run"}' } }),
  ]
  writeFileSync(join(dir, `rollout-2026-11-11T12-50-55-${sessionId}.jsonl`), `${lines.join(NL)}${NL}`)
}

describe('Agent 档案注册表', () => {
  it('档案自带人工恢复命令：谁在跑就用谁的 CLI', () => {
    expect(agentProfileOf('claude')?.resume?.command).toBe('claude')
    expect(agentProfileOf('codex')?.resume?.command).toBe('codex')
    expect(agentProfileOf('codex')?.resume?.args).toEqual(['resume', '{sessionId}'])
    expect(agentProfileOf('opencode')?.resume?.command).toBe('opencode')
    expect(agentProfileOf('nope')).toBeNull()
    expect(agentProfileOf('')).toBeNull()
  })

  it('指定 Agent 时用它的档案读取会话', () => {
    const root = mkdtempSync(join(tmpdir(), 'ra-codex-'))
    const workdir = '/tmp/wt-codex'
    writeCodexSession(root, workdir, 'sess-codex-1')
    const resolved = resolveSession(workdir, 'codex', { roots: { codex: root } })
    expect(resolved?.profile.id).toBe('codex')
    expect(resolveSessionId(workdir, 'codex', { roots: { codex: root } })).toBe('sess-codex-1')
  })

  it('没指定 Agent 时自动探测：谁在这个 workdir 留下会话就用谁', () => {
    const claudeRoot = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const codexRoot = mkdtempSync(join(tmpdir(), 'ra-codex-'))
    const workdir = '/tmp/wt-both'
    const projects = join(claudeRoot, claudeProjectSlug(workdir))
    mkdirSync(projects, { recursive: true })
    writeFileSync(join(projects, 'sess-claude-1.jsonl'), '{}\n')
    writeCodexSession(codexRoot, workdir, 'sess-codex-1')
    const resolved = resolveSession(workdir, undefined, { roots: { claude: claudeRoot, codex: codexRoot } })
    expect(resolved?.profile.id).toBe('claude')
  })

  it('只有 Codex 会话时自动探测到 Codex', () => {
    const codexRoot = mkdtempSync(join(tmpdir(), 'ra-codex-'))
    const workdir = '/tmp/wt-codex-only'
    writeCodexSession(codexRoot, workdir, 'sess-codex-2')
    const resolved = resolveSession(workdir, undefined, { roots: { codex: codexRoot } })
    expect(resolved?.profile.id).toBe('codex')
  })
})

describe('Codex 会话记录', () => {
  it('解析 assistant 文本与工具调用', () => {
    const root = mkdtempSync(join(tmpdir(), 'ra-codex-'))
    const workdir = '/tmp/wt-codex-read'
    writeCodexSession(root, workdir, 'sess-codex-3')
    const snapshot = readCodexSession(workdir, { root })
    expect(snapshot?.sessionId).toBe('sess-codex-3')
    expect(snapshot?.events.map(event => event.kind)).toEqual(['text', 'tool'])
    expect(snapshot?.events[0]?.text).toBe('我在改 README')
    expect(snapshot?.events[1]?.text).toBe('exec_command(pnpm test --run)')
    expect(snapshot?.events[1]?.tool).toEqual({ name: 'exec_command', target: 'pnpm test --run' })
  })

  it('别的 workdir 的会话不会被认领', () => {
    const root = mkdtempSync(join(tmpdir(), 'ra-codex-'))
    writeCodexSession(root, '/tmp/other', 'sess-other')
    expect(readCodexSession('/tmp/wt-missing', { root })).toBeNull()
  })
})
