import { describe, expect, it } from 'vitest'
import {
  IdentityResolver,
  classifyEntry,
  maskEmail,
  parseBatchGetId,
  parseContactUser,
  resolveBotIdentity,
  resolveRuntimeIdentity,
  type IdentityCache,
} from '../../src/sources/feishu-identity.js'
import { chatEntry, defaultConfig, type AppConfig, type FeishuSettings } from '../../src/config.js'
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

describe('通讯录错误分类', () => {
  it('lark-cli 非零退出且错误码是跨应用时，按「查无此人」丢弃条目', async () => {
    const { events, logger } = captureLogger()
    const runner = makeRunner(() => ({
      code: 1,
      stdout: '',
      stderr: JSON.stringify({ ok: false, identity: 'bot', error: { type: 'api', code: 99992361, message: 'open_id cross app' } }),
    }))
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a', logger })

    const resolution = await resolver.resolveEntries(['ou_82fb106b096ac2a7563f9a2a6077a44d'])

    expect(resolution.invalid).toHaveLength(1)
    expect(resolution.pending).toHaveLength(0)
    expect(resolution.openIds).toEqual([])
    const failed = events.find(event => event.message === 'identity:resolve-failed')
    expect(String(failed?.extra?.detail)).toContain('跨应用')
  })

  it('非零退出但没有确定错误码时保留条目待重试', async () => {
    const { events, logger } = captureLogger()
    const runner = makeRunner(() => ({
      code: 1,
      stdout: '',
      stderr: JSON.stringify({ ok: false, error: { code: 99991663, message: 'permission denied' } }),
    }))
    const resolver = new IdentityResolver({ lark: runner, appId: 'cli_a', logger })

    const resolution = await resolver.resolveEntries(['ou_self'])

    expect(resolution.pending).toHaveLength(1)
    expect(resolution.openIds).toEqual(['ou_self'])
    expect(events.find(event => event.message === 'identity:resolve-deferred')).toBeTruthy()
  })
})

/** 群成员列表的返回：机器人条目带 app_id。 */
const MEMBERS = (bots: Record<string, unknown>[] = [], users: Record<string, unknown>[] = []): Reply => ({
  code: 0,
  stdout: JSON.stringify({ ok: true, data: { users, bots } }),
  stderr: '',
})

/** 造一个只改了飞书段的配置。 */
function appConfig(feishu: Partial<FeishuSettings> = {}): AppConfig {
  const base = defaultConfig()
  return { ...base, feishu: { ...base.feishu, ...feishu } }
}

describe('机器人身份自动识别', () => {
  it('群成员里 app_id 匹配的机器人被识别出来', async () => {
    const runner = makeRunner(() => MEMBERS([{ member_id: 'ou_bot', name: 'Pz小助手', app_id: 'cli_a' }]))
    const { events, logger } = captureLogger()

    const bot = await resolveBotIdentity({ appId: 'cli_a', chatIds: ['oc_1'], lark: runner, logger })

    expect(runner.calls[0]).toEqual(['im', '+chat-members-list', '--chat-id', 'oc_1', '--as', 'bot', '--format', 'json'])
    expect(bot.botOpenIds).toEqual(['ou_bot'])
    expect(bot.botNames).toEqual(['Pz小助手'])
    expect(bot.resolved).toBe(true)
    const resolved = events.find(event => event.message === 'feishu:bot-identity-resolved')
    expect(resolved?.level).toBe('info')
    expect(resolved?.extra).toMatchObject({ bot: 'ou_bot', name: 'Pz小助手' })
  })

  it('群成员里没有匹配 appId 的机器人时判定为未识别并说明原因', async () => {
    const runner = makeRunner(() => MEMBERS(
      [{ member_id: 'ou_other_bot', name: '别的机器人', app_id: 'cli_other' }],
      [{ member_id: 'ou_alice', name: '阿振' }],
    ))
    const { events, logger } = captureLogger()

    const bot = await resolveBotIdentity({ appId: 'cli_a', chatIds: ['oc_1'], lark: runner, logger })

    expect(bot.resolved).toBe(false)
    expect(bot.botOpenIds).toEqual([])
    expect(bot.botNames).toEqual([])
    expect(bot.detail).toContain('oc_1')
    expect(bot.detail).toContain('cli_a')
    expect(bot.detail).toContain('没找到')
    const failed = events.find(event => event.message === 'feishu:bot-identity-failed')
    expect(failed?.level).toBe('error')
    expect(failed?.extra?.detail).toContain('没找到')
  })

  it('读取群成员抛异常时判定为未识别并带上原因', async () => {
    const runner = makeRunner(() => { throw new Error('spawn lark-cli ENOENT') })

    const bot = await resolveBotIdentity({ appId: 'cli_a', chatIds: ['oc_1'], lark: runner })

    expect(bot.resolved).toBe(false)
    expect(bot.detail).toContain('spawn lark-cli ENOENT')
  })

  it('lark-cli 非零退出时判定为未识别并带上 stderr', async () => {
    const runner = makeRunner(() => ({ code: 1, stdout: '', stderr: 'permission denied' }))

    const bot = await resolveBotIdentity({ appId: 'cli_a', chatIds: ['oc_1'], lark: runner })

    expect(bot.resolved).toBe(false)
    expect(bot.detail).toContain('permission denied')
  })

  it('多个群的结果取并集', async () => {
    const runner = makeRunner((argv) => {
      const chatId = argv[argv.indexOf('--chat-id') + 1]
      if (chatId === 'oc_1') return MEMBERS([{ member_id: 'ou_bot_1', name: '小助手', app_id: 'cli_a' }])
      return MEMBERS([{ member_id: 'ou_bot_2', name: '小助手二号', app_id: 'cli_a' }])
    })

    const bot = await resolveBotIdentity({ appId: 'cli_a', chatIds: ['oc_1', 'oc_2'], lark: runner })

    expect(bot.botOpenIds).toEqual(['ou_bot_1', 'ou_bot_2'])
    expect(bot.botNames).toEqual(['小助手', '小助手二号'])
    expect(bot.resolved).toBe(true)
  })

  it('没有 appId 时不调用 lark-cli，直接判定为未识别', async () => {
    const runner = makeRunner(() => { throw new Error('不该被调用') })
    const { events, logger } = captureLogger()

    const bot = await resolveBotIdentity({ appId: '', chatIds: ['oc_1'], lark: runner, logger })

    expect(runner.calls).toHaveLength(0)
    expect(bot.resolved).toBe(false)
    expect(bot.detail).toContain('appId')
    expect(events.find(event => event.message === 'feishu:bot-identity-failed')?.level).toBe('error')
  })

  it('没有 mention 群时不扫描也不写错误事件，且 resolved 为 true（无需识别不是失败）', async () => {
    const runner = makeRunner(() => { throw new Error('不该被调用') })
    const { events, logger } = captureLogger()

    const bot = await resolveBotIdentity({ appId: 'cli_a', chatIds: [], lark: runner, logger })

    expect(runner.calls).toHaveLength(0)
    expect(bot.resolved).toBe(true)
    expect(bot.detail).toContain('无需识别')
    expect(events.find(event => event.message === 'feishu:bot-identity-failed')).toBeUndefined()
  })

  it('lark-cli 返回 ok:false 错误信封时按接口异常处理，不能当成没找到机器人', async () => {
    const runner = makeRunner(() => ({
      code: 0,
      stdout: JSON.stringify({ ok: false, error: { code: 99991663, msg: 'permission denied for alice@example.com' } }),
      stderr: '',
    }))
    const { events, logger } = captureLogger()

    const bot = await resolveBotIdentity({ appId: 'cli_a', chatIds: ['oc_1'], lark: runner, logger })

    expect(bot.resolved).toBe(false)
    expect(bot.detail).toContain('接口异常')
    expect(bot.detail).toContain('99991663')
    // 接口异常不能被说成「机器人不在群里」，否则排查方向会被带偏。
    expect(bot.detail).not.toContain('没找到')
    // 错误信息里的邮箱必须掩码。
    expect(bot.detail).not.toContain('alice@example.com')
    const failed = events.find(event => event.message === 'feishu:bot-identity-failed')
    expect(failed?.level).toBe('error')
    expect(String(failed?.extra?.detail)).toContain('接口异常')
    expect(String(failed?.extra?.detail)).not.toContain('没找到')
    expect(String(failed?.extra?.detail)).not.toContain('alice@example.com')
  })

  it('顶层带 error 字段（即使 ok 不为 false）也按接口异常处理', async () => {
    const runner = makeRunner(() => ({
      code: 0,
      stdout: JSON.stringify({ data: {}, error: { code: 12345, msg: 'rate limited' } }),
      stderr: '',
    }))

    const bot = await resolveBotIdentity({ appId: 'cli_a', chatIds: ['oc_1'], lark: runner })

    expect(bot.resolved).toBe(false)
    expect(bot.detail).toContain('接口异常')
    expect(bot.detail).toContain('12345')
    expect(bot.detail).not.toContain('没找到')
  })

  it('成员列表结构异常时按接口异常处理，不当成没找到机器人', async () => {
    const runner = makeRunner(() => ({
      code: 0,
      stdout: JSON.stringify({ ok: true, data: { items: [] } }),
      stderr: '',
    }))

    const bot = await resolveBotIdentity({ appId: 'cli_a', chatIds: ['oc_1'], lark: runner })

    expect(bot.resolved).toBe(false)
    expect(bot.detail).toContain('接口异常')
    expect(bot.detail).not.toContain('没找到')
  })

  it('部分群读取失败时，成功分支的 detail 仍然带出失败的群', async () => {
    const runner = makeRunner(argv => {
      const chatId = argv[argv.indexOf('--chat-id') + 1]
      if (chatId === 'oc_1') return MEMBERS([{ member_id: 'ou_bot', name: '小助手', app_id: 'cli_a' }])
      return { code: 0, stdout: JSON.stringify({ ok: false, error: { code: 99991663, msg: 'permission denied' } }), stderr: '' }
    })
    const { events, logger } = captureLogger()

    const bot = await resolveBotIdentity({ appId: 'cli_a', chatIds: ['oc_1', 'oc_2'], lark: runner, logger })

    expect(bot.resolved).toBe(true)
    expect(bot.detail).toContain('oc_2')
    expect(bot.detail).toContain('接口异常')
    expect(events.find(event => event.message === 'feishu:bot-identity-resolved')?.level).toBe('info')
  })
})

describe('运行时身份装配', () => {
  const OPEN_ID = 'ou_aa94092a6fd14dd0672a7f327a00fd61'

  it('全局名单里的邮箱被解析成 open_id 并带出显示名', async () => {
    const runner = makeRunner(argv => {
      if (isBatch(argv)) return OK_BATCH('pengzhen02@dewu.com', OPEN_ID)
      if (requestedUserId(argv) === OPEN_ID) return OK_USER(OPEN_ID, '阿振(Pz)')
      return MEMBERS()
    })
    const config = appConfig({ appId: 'cli_a', allowed: ['pengzhen02@dewu.com'] })

    const identity = await resolveRuntimeIdentity({ config, lark: runner })

    expect(identity.allowedOpenIds).toEqual([OPEN_ID])
    expect(identity.names.get(OPEN_ID)).toBe('阿振(Pz)')
    expect(identity.status.invalidCount).toBe(0)
    expect(identity.status.pendingCount).toBe(0)
    expect(identity.status.entries).toHaveLength(1)
  })

  it('群级名单单独解析并按群归位', async () => {
    const runner = makeRunner(argv => {
      if (isBatch(argv)) return OK_BATCH('pengzhen02@dewu.com', OPEN_ID)
      if (requestedUserId(argv) === OPEN_ID) return OK_USER(OPEN_ID, '阿振(Pz)')
      return MEMBERS()
    })
    const config = appConfig({
      appId: 'cli_a',
      chats: [chatEntry('oc_1', { mode: 'mention', allowed: ['pengzhen02@dewu.com'] })],
    })

    const identity = await resolveRuntimeIdentity({ config, lark: runner })

    expect(identity.allowedByChatOpenIds).toEqual({ oc_1: [OPEN_ID] })
    expect(identity.names.get(OPEN_ID)).toBe('阿振(Pz)')
  })

  it('需求分析助手的终审管理员支持邮箱，按群解析成 open_id', async () => {
    const runner = makeRunner(argv => {
      if (isBatch(argv)) return OK_BATCH('pengzhen02@dewu.com', OPEN_ID)
      if (requestedUserId(argv) === OPEN_ID) return OK_USER(OPEN_ID, '阿振(Pz)')
      return MEMBERS()
    })
    const config = appConfig({
      appId: 'cli_a',
      chats: [
        chatEntry('oc_1', { mode: 'all', intake: { enabled: true, maxQuestions: 10, codeAccess: true, approvers: ['pengzhen02@dewu.com'] } }),
        chatEntry('oc_2', { mode: 'all' }),
      ],
    })

    const identity = await resolveRuntimeIdentity({ config, lark: runner })

    expect(identity.approverOpenIdsByChat).toEqual({ oc_1: [OPEN_ID] })
    expect(identity.names.get(OPEN_ID)).toBe('阿振(Pz)')
  })

  it('终审管理员配了邮箱却解析不出来时写 error 事件，该群没有可终审的人', async () => {
    const runner = makeRunner(() => ({ code: 1, stdout: '', stderr: 'permission denied' }))
    const { events, logger } = captureLogger()
    const config = appConfig({
      appId: 'cli_a',
      chats: [chatEntry('oc_1', { mode: 'all', intake: { enabled: true, maxQuestions: 10, codeAccess: true, approvers: ['pengzhen02@dewu.com'] } })],
    })

    const identity = await resolveRuntimeIdentity({ config, lark: runner, logger })

    expect(identity.approverOpenIdsByChat).toEqual({ oc_1: [] })
    const empty = events.find(event => event.message === 'feishu:intake-approver-empty')
    expect(empty?.level).toBe('error')
    expect(empty?.extra?.chat).toBe('oc_1')
  })

  it('群级名单配了却一个都解析不出来时写 error 事件，该群拒绝所有人', async () => {
    const runner = makeRunner(() => ({ code: 1, stdout: '', stderr: 'permission denied' }))
    const { events, logger } = captureLogger()
    const config = appConfig({
      appId: 'cli_a',
      chats: [chatEntry('oc_1', { mode: 'mention', allowed: ['pengzhen02@dewu.com'] })],
    })

    const identity = await resolveRuntimeIdentity({ config, lark: runner, logger })

    expect(identity.allowedByChatOpenIds).toEqual({ oc_1: [] })
    const empty = events.find(event => event.message === 'feishu:chat-allowlist-empty')
    expect(empty?.level).toBe('error')
    expect(empty?.extra?.chat).toBe('oc_1')
  })

  it('有条目解析不出来时写 warn 事件并计数', async () => {
    const runner = makeRunner(() => ({ code: 0, stdout: JSON.stringify({ ok: false, error: { code: '99992361', msg: 'cross app' } }), stderr: '' }))
    const { events, logger } = captureLogger()
    const config = appConfig({ appId: 'cli_a', allowed: ['ou_82fb106b096ac2a7563f9a2a6077a44d'] })

    const identity = await resolveRuntimeIdentity({ config, lark: runner, logger })

    expect(identity.allowedOpenIds).toEqual([])
    expect(identity.status.invalidCount).toBe(1)
    const invalid = events.find(event => event.message === 'config:identity-invalid')
    expect(invalid?.level).toBe('warn')
    expect(invalid?.extra?.count).toBe(1)
  })

  it('手动填了 botOpenIds 时不扫描群成员', async () => {
    const runner = makeRunner(() => { throw new Error('不该被调用') })
    const config = appConfig({
      appId: 'cli_a',
      botOpenIds: ['ou_manual_bot'],
      botNames: ['手动机器人'],
      chats: [chatEntry('oc_1', { mode: 'mention' })],
    })

    const identity = await resolveRuntimeIdentity({ config, lark: runner })

    expect(runner.calls).toHaveLength(0)
    expect(identity.bot.botOpenIds).toEqual(['ou_manual_bot'])
    expect(identity.bot.botNames).toEqual(['手动机器人'])
    expect(identity.bot.resolved).toBe(true)
  })

  it('没有 mode=mention 群时机器人身份标记为可用（无需识别，不是失败）', async () => {
    const runner = makeRunner(() => { throw new Error('不该被调用') })
    const config = appConfig({
      appId: 'cli_a',
      chats: [chatEntry('oc_all', { mode: 'all' })],
    })

    const identity = await resolveRuntimeIdentity({ config, lark: runner })

    expect(runner.calls).toHaveLength(0)
    expect(identity.bot.resolved).toBe(true)
    expect(identity.bot.detail).toContain('无需识别')
  })

  it('只扫描 mode=mention 的群来识别机器人身份', async () => {
    const runner = makeRunner(() => MEMBERS([{ member_id: 'ou_bot', name: '小助手', app_id: 'cli_a' }]))
    const config = appConfig({
      appId: 'cli_a',
      chats: [chatEntry('oc_all', { mode: 'all' }), chatEntry('oc_mention', { mode: 'mention' })],
    })

    const identity = await resolveRuntimeIdentity({ config, lark: runner })

    const scanned = runner.calls.map(call => call[call.indexOf('--chat-id') + 1])
    expect(scanned).toEqual(['oc_mention'])
    expect(identity.bot.botOpenIds).toEqual(['ou_bot'])
    expect(identity.bot.resolved).toBe(true)
  })

  it('缓存命中时不调用通讯录，名单仍然可用', async () => {
    const runner = makeRunner(() => { throw new Error('不该被调用') })
    const cache: IdentityCache = {
      get: () => ({ openId: 'ou_cached', name: '阿振(Pz)' }),
      set: () => {},
    }
    const config = appConfig({ appId: 'cli_a', allowed: ['pengzhen02@dewu.com'] })

    const identity = await resolveRuntimeIdentity({ config, lark: runner, cache })

    expect(runner.calls).toHaveLength(0)
    expect(identity.allowedOpenIds).toEqual(['ou_cached'])
    expect(identity.names.get('ou_cached')).toBe('阿振(Pz)')
  })
})

describe('全局名单为空时的告警', () => {
  it('一个都解析不出来时写 error 事件，并说明是待重试还是查无此人', async () => {
    const runner = makeRunner(() => ({ code: 1, stdout: '', stderr: 'permission denied' }))
    const { events, logger } = captureLogger()
    const config = appConfig({ appId: 'cli_a', allowed: ['pengzhen02@dewu.com'] })

    const identity = await resolveRuntimeIdentity({ config, lark: runner, logger })

    expect(identity.allowedOpenIds).toEqual([])
    const empty = events.find(event => event.message === 'feishu:allowlist-empty')
    expect(empty?.level).toBe('error')
    expect(empty?.extra?.count).toBe(1)
    expect(String(empty?.extra?.detail)).toContain('待重试')
    // 状态快照里能看出这条是「待重试」而不是「查无此人」
    expect(identity.status.pendingCount).toBe(1)
    expect(identity.status.invalidCount).toBe(0)
  })

  it('确认查无此人时 error 事件里写明是查无此人', async () => {
    const runner = makeRunner(() => ({
      code: 0,
      stdout: JSON.stringify({ ok: true, data: { user_list: [{ email: 'pengzhen02@dewu.com' }] } }),
      stderr: '',
    }))
    const { events, logger } = captureLogger()
    const config = appConfig({ appId: 'cli_a', allowed: ['pengzhen02@dewu.com'] })

    await resolveRuntimeIdentity({ config, lark: runner, logger })

    const empty = events.find(event => event.message === 'feishu:allowlist-empty')
    expect(empty?.level).toBe('error')
    expect(String(empty?.extra?.detail)).toContain('查无此人')
  })

  it('名单没配时不写这个错误事件', async () => {
    const runner = makeRunner(() => { throw new Error('不该被调用') })
    const { events, logger } = captureLogger()
    const config = appConfig({ appId: 'cli_a' })

    await resolveRuntimeIdentity({ config, lark: runner, logger })

    expect(events.find(event => event.message === 'feishu:allowlist-empty')).toBeUndefined()
  })
})
