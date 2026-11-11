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
    expect(output.err.join('\n')).toContain('ra migrate <sessions|threads>')
  })
})

describe('ra migrate threads', () => {
  const AT = '2026-11-06T10:00:00.000Z'

  function seedThread(dir: string): void {
    const store = new Store(join(dir, 'state.db'))
    store.upsertThread({ id: 'feishu:oc_dev:om_root', source: 'feishu', rootId: 'om_root', chatId: 'oc_dev', createdAt: AT })
    store.close()
  }

  it('dry-run 只读，报告待回填数量', async () => {
    const dir = home()
    seedThread(dir)
    const output = io(dir)
    expect(await runCli(['migrate', 'threads', '--dry-run', '--home', dir], output)).toBe(0)
    expect(output.out.join('\n')).toContain('待回填话题 ID：1')
    expect(output.out.join('\n')).toContain('未写入任何数据')

    const store = new Store(join(dir, 'state.db'))
    expect(store.listThreadAliases('feishu', 'feishu:oc_dev:om_root')).toEqual([])
    store.close()
  })

  it('apply 回填话题 ID 后，话题内直发的消息能落回老线程', async () => {
    const dir = home()
    seedThread(dir)
    const output = io(dir)
    output.lark = {
      async run(argv: string[]) {
        expect(argv).toContain('om_root')
        return {
          code: 0,
          stdout: JSON.stringify({ ok: true, data: { messages: [{ message_id: 'om_root', thread_id: 'omt_topic' }] } }),
          stderr: '',
        }
      },
    }
    expect(await runCli(['migrate', 'threads', '--apply', '--yes', '--home', dir], output)).toBe(0)
    expect(output.out.join('\n')).toContain('回填完成：1 条')

    const store = new Store(join(dir, 'state.db'))
    expect(store.listThreadAliases('feishu', 'feishu:oc_dev:om_root')).toEqual(['om_root', 'omt_topic'])
    // 关键：只带话题 ID 的消息现在能解析到存量线程
    const resolved = store.resolveThread({
      source: 'feishu',
      chatId: 'oc_dev',
      keys: ['omt_topic', 'om_new'],
      canonicalId: 'feishu:oc_dev:omt_topic',
      createdAt: AT,
    })
    expect(resolved).toEqual({ threadId: 'feishu:oc_dev:om_root', created: false })
    store.close()
  })

  it('查询失败的批次如实报告，不假装成功', async () => {
    const dir = home()
    seedThread(dir)
    const output = io(dir)
    output.lark = { async run() { return { code: 1, stdout: '', stderr: 'boom' } } }
    expect(await runCli(['migrate', 'threads', '--apply', '--yes', '--home', dir], output)).toBe(1)
    expect(output.err.join('\n')).toContain('部分线程没有查到话题 ID')
  })

  it('verify 在还有待回填线程时不通过', async () => {
    const dir = home()
    seedThread(dir)
    const output = io(dir)
    expect(await runCli(['migrate', 'threads', '--verify', '--home', dir], output)).toBe(1)
    expect(output.err.join('\n')).toContain('ra migrate threads --apply')
  })
})