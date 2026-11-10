import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, type CliIo } from '../src/cli/index.js'
import { Store } from '../src/store/db.js'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'ra-migrate-'))
}

function io(dir: string): CliIo & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    stdout: line => out.push(line),
    stderr: line => err.push(line),
    env: { RA_HOME: dir },
  }
}

function seed(dir: string): void {
  const store = new Store(join(dir, 'state.db'))
  store.upsertChatSession({
    sessionKey: 'chat:oc_dev:user:ou_alice',
    chatId: 'oc_dev',
    actorId: 'ou_alice',
    threadId: '',
    sessionFile: '/tmp/alice.jsonl',
    sessionId: 'sess_1',
    soulVersion: '',
    policyVersion: '',
    createdAt: '2026-11-06T10:00:00.000Z',
    lastUsedAt: '2026-11-06T10:00:00.000Z',
    status: 'active',
    resetAt: null,
    resetBy: null,
    purgedAt: null,
  })
  store.close()
}

describe('ra migrate sessions', () => {
  it('dry-run 只读，apply 后可用新 key 命中旧文件，verify 通过', async () => {
    const dir = home()
    seed(dir)

    const dry = io(dir)
    expect(await runCli(['migrate', 'sessions', '--dry-run', '--home', dir], dry)).toBe(0)
    expect(dry.out.join('\n')).toContain('待迁移 1 条')
    let store = new Store(join(dir, 'state.db'))
    expect(store.getChatSession('chat:oc_dev:user:ou_alice')?.sessionFile).toBe('/tmp/alice.jsonl')
    store.close()

    const apply = io(dir)
    expect(await runCli(['migrate', 'sessions', '--apply', '--yes', '--home', dir], apply)).toBe(0)
    expect(apply.out.join('\n')).toContain('迁移完成：会话 1 条')

    store = new Store(join(dir, 'state.db'))
    expect(store.getChatSession('channel:feishu:chat:oc_dev:user:ou_alice')?.sessionFile).toBe('/tmp/alice.jsonl')
    expect(store.getChatSession('chat:oc_dev:user:ou_alice')).toBeNull()
    store.close()

    const verify = io(dir)
    expect(await runCli(['migrate', 'sessions', '--verify', '--home', dir], verify)).toBe(0)
    expect(verify.out.join('\n')).toContain('校验通过')
  })

  it('apply 在非交互且未传 --yes 时取消，不写库', async () => {
    const dir = home()
    seed(dir)
    const output = io(dir)
    expect(await runCli(['migrate', 'sessions', '--apply', '--home', dir], output)).toBe(1)
    expect(output.err.join('\n')).toContain('已取消')
    const store = new Store(join(dir, 'state.db'))
    expect(store.getChatSession('chat:oc_dev:user:ou_alice')).not.toBeNull()
    store.close()
  })

  it('未知子命令给出用法', async () => {
    const dir = home()
    const output = io(dir)
    expect(await runCli(['migrate', 'unknown', '--home', dir], output)).toBe(2)
    expect(output.err.join('\n')).toContain('ra migrate sessions')
  })
})