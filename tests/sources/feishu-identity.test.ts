import { describe, expect, it } from 'vitest'
import {
  IdentityResolver,
  classifyEntry,
  maskEmail,
  parseBatchGetId,
  parseContactUser,
  type IdentityCache,
} from '../../src/sources/feishu-identity.js'
import type { CommandRunner } from '../../src/infra/process.js'
import type { Logger } from '../../src/infra/logger.js'

type Reply = { code: number; stdout: string; stderr: string }

/** 假 runner：按 argv 决定返回什么，并记录所有调用。 */
function makeRunner(reply: (argv: string[]) => Reply | Promise<Reply>) {
  const calls: string[][] = []
  const runner: CommandRunner & { calls: string[][] } = {
    calls,
    async run(argv) {
      calls.push([...argv])
      return reply(argv)
    },
  }
  return runner
}

function isBatch(argv: string[]): boolean {
  return argv.includes('/open-apis/contact/v3/users/batch_get_id')
}

function requestedUserId(argv: string[]): string {
  const index = argv.indexOf('--user-id')
  return index >= 0 ? (argv[index + 1] ?? '') : ''
}

/** 从 batch_get_id 的 argv 里取出实际发出去的邮箱。 */
function sentEmails(argv: string[]): string[] {
  const index = argv.indexOf('--data')
  if (index < 0) return []
  const data = JSON.parse(argv[index + 1] ?? '{}') as { emails?: string[] }
  return data.emails ?? []
}

/** 采集日志调用，便于断言事件名与字段。 */
function captureLogger() {
  const events: { level: string; message: string; extra?: Record<string, unknown> }[] = []
  const logger: Logger = {
    info: (message, extra) => { events.push({ level: 'info', message, ...(extra ? { extra } : {}) }) },
    warn: (message, extra) => { events.push({ level: 'warn', message, ...(extra ? { extra } : {}) }) },
    error: (message, extra) => { events.push({ level: 'error', message, ...(extra ? { extra } : {}) }) },
  }
  return { events, logger }
}

const OK_BATCH = (email: string, openId: string): Reply => ({
  code: 0,
  stdout: JSON.stringify({ ok: true, data: { user_list: [{ email, user_id: openId }] } }),
  stderr: '',
})

const OK_USER = (openId: string, name: string, email = 'pengzhen02@dewu.com'): Reply => ({
  code: 0,
  stdout: JSON.stringify({ ok: true, data: { user: { open_id: openId, user_id: 'u_1', name, email } } }),
  stderr: '',
})

describe('条目分类', () => {
  it('邮箱、open_id 与非法条目各归其类', () => {
    expect(classifyEntry('a@b.com')).toEqual({ kind: 'email', value: 'a@b.com' })
    expect(classifyEntry(' ou_x ')).toEqual({ kind: 'open_id', value: 'ou_x' })
    expect(classifyEntry('张三')).toEqual({ kind: 'invalid', value: '张三' })
    expect(classifyEntry('')).toEqual({ kind: 'invalid', value: '' })
  })
})

describe('邮箱掩码', () => {
  it('只保留邮箱首字符，域名保留', () => {
    expect(maskEmail('pengzhen02@dewu.com')).toBe('p***@dewu.com')
  })

  it('不是邮箱的字符串原样返回', () => {
    expect(maskEmail('ou_abc')).toBe('ou_abc')
    expect(maskEmail('张三')).toBe('张三')
  })
})

describe('通讯录返回解析', () => {
  it('batch_get_id 返回 email → open_id 映射', () => {
    const map = parseBatchGetId(JSON.stringify({
      ok: true,
      data: { user_list: [{ email: 'PengZhen02@dewu.com', user_id: 'ou_1' }] },
    }))
    expect(map.get('pengzhen02@dewu.com')).toBe('ou_1')
  })

  it('batch_get_id 输出无法解析时返回空映射', () => {
    expect(parseBatchGetId('not json').size).toBe(0)
  })

  it('contact +get-user 返回用户信息', () => {
    expect(parseContactUser(JSON.stringify({
      ok: true,
      data: { user: { open_id: 'ou_1', user_id: 'u_1', name: '阿振(Pz)', email: 'pengzhen02@dewu.com' } },
    }))).toEqual({ openId: 'ou_1', userId: 'u_1', name: '阿振(Pz)', email: 'pengzhen02@dewu.com' })
    expect(parseContactUser('not json')).toBeNull()
  })
})

describe('身份条目解析', () => {
  it('邮箱条目走 batch_get_id，解析出的 open_id 进入名单', async () => {
    const openId = 'ou_aa94092a6fd14dd0672a7f327a00fd61'
    const runner = makeRunner(argv => {
      if (isBatch(argv)) return OK_BATCH('pengzhen02@dewu.com', openId)
      return OK_USER(openId, '阿振(Pz)')
    })
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a' })

    const resolution = await resolver.resolveEntries(['pengzhen02@dewu.com'])

    expect(runner.calls[0]).toEqual([
      'api', 'POST', '/open-apis/contact/v3/users/batch_get_id',
      '--params', JSON.stringify({ user_id_type: 'open_id' }),
      '--data', JSON.stringify({ emails: ['pengzhen02@dewu.com'] }),
      '--as', 'bot', '--format', 'json',
    ])
    expect(resolution.openIds).toContain(openId)
    expect(resolution.names.get(openId)).toBe('阿振(Pz)')
    expect(resolution.entries[0]).toMatchObject({ kind: 'email', status: 'resolved', openId, name: '阿振(Pz)' })
    expect(resolution.invalid).toHaveLength(0)
    expect(resolution.pending).toHaveLength(0)
  })

  it('邮箱查无此人（没有 user_id 字段）判定为 invalid 且不进名单', async () => {
    const runner = makeRunner(() => ({
      code: 0,
      stdout: JSON.stringify({ ok: true, data: { user_list: [{ email: 'pengzhen02@dewu.com' }] } }),
      stderr: '',
    }))
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a' })

    const resolution = await resolver.resolveEntries(['pengzhen02@dewu.com'])

    expect(resolution.entries[0]?.status).toBe('invalid')
    expect(resolution.entries[0]?.detail).toContain('查无此人')
    expect(resolution.openIds).not.toContain('ou_aa94092a6fd14dd0672a7f327a00fd61')
    expect(resolution.openIds).toHaveLength(0)
    expect(resolution.invalid).toHaveLength(1)
    // 失败原因里不能出现完整邮箱
    expect(resolution.entries[0]?.detail).not.toContain('pengzhen02@dewu.com')
  })

  it('跨应用 open_id 判定为 invalid 并说明是跨应用', async () => {
    const runner = makeRunner(() => ({
      code: 0,
      stdout: JSON.stringify({ ok: false, error: { code: '99992361', msg: 'open_id cross app' } }),
      stderr: '',
    }))
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a' })

    const resolution = await resolver.resolveEntries(['ou_82fb106b096ac2a7563f9a2a6077a44d'])

    expect(resolution.entries[0]?.status).toBe('invalid')
    expect(resolution.entries[0]?.detail).toContain('跨应用')
    expect(resolution.invalid).toHaveLength(1)
  })

  it('查无此人的 open_id 判定为 invalid', async () => {
    const runner = makeRunner(() => ({
      code: 0,
      stdout: JSON.stringify({ ok: false, error: { code: '99992351', msg: 'user not exist' } }),
      stderr: '',
    }))
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a' })

    const resolution = await resolver.resolveEntries(['ou_not_exist'])

    expect(resolution.entries[0]?.status).toBe('invalid')
    expect(resolution.entries[0]?.detail).toContain('查无此人')
    expect(resolution.invalid).toHaveLength(1)
  })

  it('lark-cli 非零退出判定为 pending，条目保留而不是丢弃', async () => {
    const runner = makeRunner(() => ({ code: 1, stdout: '', stderr: 'permission denied' }))
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a' })

    const resolution = await resolver.resolveEntries(['ou_aa94092a6fd14dd0672a7f327a00fd61'])

    expect(resolution.entries[0]?.status).toBe('pending')
    expect(resolution.invalid).toHaveLength(0)
    expect(resolution.pending).toHaveLength(1)
    expect(resolution.entries).toHaveLength(1)
  })

  it('lark-cli 抛异常判定为 pending，条目保留而不是丢弃', async () => {
    const runner = makeRunner(() => { throw new Error('spawn lark-cli ENOENT') })
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a' })

    const resolution = await resolver.resolveEntries(['pengzhen02@dewu.com'])

    expect(resolution.entries[0]?.status).toBe('pending')
    expect(resolution.entries[0]?.detail).toContain('spawn lark-cli ENOENT')
    expect(resolution.invalid).toHaveLength(0)
    expect(resolution.pending).toHaveLength(1)
  })

  it('open_id 条目取回通讯录显示名并回填名字表', async () => {
    const openId = 'ou_aa94092a6fd14dd0672a7f327a00fd61'
    const runner = makeRunner(argv => OK_USER(requestedUserId(argv), '阿振(Pz)'))
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a' })

    const resolution = await resolver.resolveEntries([openId])

    expect(runner.calls[0]).toEqual(['contact', '+get-user', '--user-id', openId, '--as', 'bot', '--format', 'json'])
    expect(resolution.names.get(openId)).toBe('阿振(Pz)')
    expect(resolution.entries[0]?.status).toBe('resolved')
  })

  it('缓存命中时不再调用 lark-cli', async () => {
    const runner = makeRunner(() => { throw new Error('不该被调用') })
    const cache: IdentityCache = {
      get: () => ({ openId: 'ou_cached', name: '阿振(Pz)' }),
      set: () => {},
    }
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a', cache })

    const resolution = await resolver.resolveEntries(['pengzhen02@dewu.com'])

    expect(runner.calls).toHaveLength(0)
    expect(resolution.openIds).toEqual(['ou_cached'])
    expect(resolution.names.get('ou_cached')).toBe('阿振(Pz)')
  })

  it('解析成功后写缓存，键带 appId 与条目类型', async () => {
    const openId = 'ou_aa94092a6fd14dd0672a7f327a00fd61'
    const runner = makeRunner(argv => {
      if (isBatch(argv)) return OK_BATCH('pengzhen02@dewu.com', openId)
      return OK_USER(openId, '阿振(Pz)')
    })
    const sets: unknown[][] = []
    const cache: IdentityCache = {
      get: () => null,
      set: (...args) => { sets.push(args) },
    }
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a', cache })

    await resolver.resolveEntries(['pengzhen02@dewu.com'])

    expect(sets).toContainEqual(['cli_a', 'email', 'pengzhen02@dewu.com', openId, '阿振(Pz)'])
  })

  it('名字暂时取不到时不写缓存，下次解析会重试补名字', async () => {
    const openId = 'ou_aa94092a6fd14dd0672a7f327a00fd61'
    const runner = makeRunner(argv => {
      if (isBatch(argv)) return OK_BATCH('pengzhen02@dewu.com', openId)
      return { code: 1, stdout: '', stderr: 'contact timeout' }
    })
    const sets: unknown[][] = []
    const cache: IdentityCache = {
      get: () => null,
      set: (...args) => { sets.push(args) },
    }
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a', cache })

    const resolution = await resolver.resolveEntries(['pengzhen02@dewu.com'])

    // 身份已经确定（open_id 拿到了），只是显示名没取到
    expect(resolution.entries[0]?.status).toBe('resolved')
    expect(resolution.openIds).toContain(openId)
    expect(resolution.entries[0]?.name).toBe('')
    // 没有名字就不写缓存，下次解析会重新去查
    expect(sets).toHaveLength(0)
  })

  it('没有 appId 时不写缓存，避免跨应用污染', async () => {
    const openId = 'ou_aa94092a6fd14dd0672a7f327a00fd61'
    const runner = makeRunner(argv => {
      if (isBatch(argv)) return OK_BATCH('pengzhen02@dewu.com', openId)
      return OK_USER(openId, '阿振(Pz)')
    })
    const sets: unknown[][] = []
    const cache: IdentityCache = {
      get: () => null,
      set: (...args) => { sets.push(args) },
    }
    const resolver = new IdentityResolver({ lark: runner, cache })

    await resolver.resolveEntries(['pengzhen02@dewu.com'])

    expect(sets).toHaveLength(0)
  })

  it('非法条目判定为 invalid 并提示正确写法', async () => {
    const runner = makeRunner(() => { throw new Error('不该被调用') })
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a' })

    const resolution = await resolver.resolveEntries(['张三'])

    expect(resolution.entries[0]?.status).toBe('invalid')
    expect(resolution.entries[0]?.kind).toBe('invalid')
    expect(resolution.invalid).toHaveLength(1)
    expect(runner.calls).toHaveLength(0)
  })

  it('重复条目的 open_id 去重', async () => {
    const openId = 'ou_aa94092a6fd14dd0672a7f327a00fd61'
    const runner = makeRunner(argv => {
      if (isBatch(argv)) return OK_BATCH('pengzhen02@dewu.com', openId)
      return OK_USER(openId, '阿振(Pz)')
    })
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a' })

    const resolution = await resolver.resolveEntries(['pengzhen02@dewu.com', 'pengzhen02@dewu.com'])

    expect(resolution.openIds).toEqual([openId])
    expect(resolution.entries).toHaveLength(2)
  })
})

describe('失败信息里的邮箱必须掩码', () => {
  it('lark-cli 抛异常时异常信息里的邮箱掩码后才进 detail', async () => {
    const runner = makeRunner(() => {
      throw new Error('spawn failed: --data {"emails":["pengzhen02@dewu.com"]}')
    })
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a' })

    const resolution = await resolver.resolveEntries(['pengzhen02@dewu.com'])

    expect(resolution.entries[0]?.status).toBe('pending')
    expect(resolution.entries[0]?.detail).not.toContain('pengzhen02@dewu.com')
    expect(resolution.entries[0]?.detail).toContain('p***@dewu.com')
  })

  it('缓存读写异常里的邮箱掩码后才进日志', async () => {
    const { events, logger } = captureLogger()
    const cache: IdentityCache = {
      get: () => { throw new Error(`cache lookup failed for pengzhen02@dewu.com`) },
      set: () => { throw new Error(`cache write failed for pengzhen02@dewu.com`) },
    }
    const runner = makeRunner(argv => {
      if (isBatch(argv)) return OK_BATCH('pengzhen02@dewu.com', 'ou_1')
      return OK_USER('ou_1', '阿振(Pz)')
    })
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a', cache, logger })

    await resolver.resolveEntries(['pengzhen02@dewu.com'])

    const cacheFailed = events.filter(event => event.message === 'identity:cache-failed')
    expect(cacheFailed.length).toBeGreaterThan(0)
    for (const event of cacheFailed) {
      expect(String(event.extra?.detail)).not.toContain('pengzhen02@dewu.com')
      expect(String(event.extra?.detail)).toContain('p***@dewu.com')
    }
    expect(JSON.stringify(events)).not.toContain('pengzhen02@dewu.com')
  })
})

describe('响应结构对不上时保留条目', () => {
  it('条目没有 email 字段时按 pending 处理，不当成查无此人', async () => {
    const runner = makeRunner(() => ({
      code: 0,
      stdout: JSON.stringify({ ok: true, data: { user_list: [{ user_id: 'ou_1' }] } }),
      stderr: '',
    }))
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a' })

    const resolution = await resolver.resolveEntries(['pengzhen02@dewu.com'])

    expect(resolution.entries[0]?.status).toBe('pending')
    expect(resolution.invalid).toHaveLength(0)
    expect(resolution.pending).toHaveLength(1)
  })

  it('返回条数与请求不一致时按 pending 处理，不当成查无此人', async () => {
    const runner = makeRunner(() => ({
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        data: { user_list: [{ email: 'pengzhen02@dewu.com', user_id: 'ou_1' }, { email: 'other@dewu.com', user_id: 'ou_2' }] },
      }),
      stderr: '',
    }))
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a' })

    const resolution = await resolver.resolveEntries(['pengzhen02@dewu.com'])

    expect(resolution.entries[0]?.status).toBe('pending')
    expect(resolution.invalid).toHaveLength(0)
    expect(resolution.pending).toHaveLength(1)
  })

  it('返回空 user_list 时按 pending 处理，不当成查无此人', async () => {
    const runner = makeRunner(() => ({
      code: 0,
      stdout: JSON.stringify({ ok: true, data: { user_list: [] } }),
      stderr: '',
    }))
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a' })

    const resolution = await resolver.resolveEntries(['pengzhen02@dewu.com'])

    expect(resolution.entries[0]?.status).toBe('pending')
    expect(resolution.invalid).toHaveLength(0)
    expect(resolution.pending).toHaveLength(1)
  })
})

describe('邮箱分片', () => {
  it('邮箱数量超过单次上限时按片请求，单片失败不影响其他片', async () => {
    const emails = Array.from({ length: 51 }, (_, index) => `user${index}@dewu.com`)
    const failed = 'user50@dewu.com'
    const runner = makeRunner(argv => {
      if (isBatch(argv)) {
        const sent = sentEmails(argv)
        if (sent.includes(failed)) return { code: 1, stdout: '', stderr: 'too many emails' }
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            data: { user_list: sent.map(email => ({ email, user_id: `ou_${email.split('@')[0]}` })) },
          }),
          stderr: '',
        }
      }
      return OK_USER(requestedUserId(argv), '阿振(Pz)')
    })
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a' })

    const resolution = await resolver.resolveEntries(emails)

    const batchCalls = runner.calls.filter(isBatch)
    expect(batchCalls).toHaveLength(2)
    expect(sentEmails(batchCalls[0]!)).toHaveLength(50)
    expect(sentEmails(batchCalls[1]!)).toEqual([failed])

    // 第一片的 50 条都解析成功
    expect(resolution.openIds).toHaveLength(50)
    // 失败那一片的条目保留待重试，不能被当成查无此人丢弃
    expect(resolution.pending).toHaveLength(1)
    expect(resolution.pending[0]?.entry).toBe(failed)
    expect(resolution.invalid).toHaveLength(0)
  })
})

describe('解析日志', () => {
  it('解析成功写 info 事件，失败与待重试写 warn 事件且邮箱已掩码', async () => {
    const openId = 'ou_aa94092a6fd14dd0672a7f327a00fd61'
    const { events, logger } = captureLogger()
    const runner = makeRunner(argv => {
      if (isBatch(argv)) return OK_BATCH('pengzhen02@dewu.com', openId)
      if (requestedUserId(argv) === openId) return OK_USER(openId, '阿振(Pz)')
      return { code: 0, stdout: JSON.stringify({ ok: false, error: { code: '99992361', msg: 'cross app' } }), stderr: '' }
    })
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a', logger })

    await resolver.resolveEntries(['pengzhen02@dewu.com', 'ou_cross_app'])

    const resolved = events.find(event => event.message === 'identity:resolved')
    expect(resolved?.level).toBe('info')
    expect(resolved?.extra).toMatchObject({ entry: 'p***@dewu.com', actor: openId, name: '阿振(Pz)' })

    const failed = events.find(event => event.message === 'identity:resolve-failed')
    expect(failed?.level).toBe('warn')
    expect(failed?.extra?.entry).toBe('ou_cross_app')

    // 日志里不能出现完整邮箱
    expect(JSON.stringify(events)).not.toContain('pengzhen02@dewu.com')
  })

  it('暂时查不了写 warn 的 resolve-deferred 事件', async () => {
    const { events, logger } = captureLogger()
    const runner = makeRunner(() => ({ code: 1, stdout: '', stderr: 'boom' }))
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a', logger })

    await resolver.resolveEntries(['pengzhen02@dewu.com'])

    const deferred = events.find(event => event.message === 'identity:resolve-deferred')
    expect(deferred?.level).toBe('warn')
    expect(deferred?.extra?.entry).toBe('p***@dewu.com')
    expect(JSON.stringify(events)).not.toContain('pengzhen02@dewu.com')
  })
})
