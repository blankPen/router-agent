import { describe, expect, it } from 'vitest'
import { LARK_PROFILE_HOME, larkEnv, withEnv, parseAuthStatus, parseDeviceLogin, parseLarkChats, parseLarkMembers, parseSelfOpenId, parseAppId, parseOrcaRepos, parseBotAvailable, parseEventPrecheck, parseOrcaStatus } from '@router-agent/channel-feishu'
import type { CommandRunner } from '#infra/process.js'

describe('lark-cli 配置隔离', () => {
  it('始终使用固定的专属 profile，不接受配置目录覆盖', () => {
    const base = { HOME: '/Users/me', PATH: '/bin' }
    expect(larkEnv(base)).toEqual({ HOME: LARK_PROFILE_HOME, PATH: '/bin' })
  })

  it('withEnv 把固定环境传给底层 runner，调用方 env 优先', async () => {
    const calls: { argv: string[]; env?: NodeJS.ProcessEnv }[] = []
    const inner: CommandRunner = {
      async run(argv, opts = {}) {
        calls.push({ argv, ...(opts.env ? { env: opts.env } : {}) })
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const runner = withEnv(inner, { HOME: '/h', PATH: '/bin' })
    await runner.run(['im', '+chat-list'])
    await runner.run(['im', '+chat-list'], { env: { PATH: '/other' } })
    expect(calls[0]?.env).toEqual({ HOME: '/h', PATH: '/bin' })
    expect(calls[1]?.env).toEqual({ HOME: '/h', PATH: '/other' })
  })
})

describe('lark-cli 返回解析', () => {
  it('群列表兼容 chats / items', () => {
    expect(parseLarkChats(JSON.stringify({ data: { chats: [{ chat_id: 'oc_a', name: 'A' }] } }))).toEqual([{ chatId: 'oc_a', name: 'A' }])
    expect(parseLarkChats(JSON.stringify({ data: { items: [{ chat_id: 'oc_b', name: 'B' }] } }))).toEqual([{ chatId: 'oc_b', name: 'B' }])
    expect(parseLarkChats('bad')).toEqual([])
  })

  it('群成员区分用户与机器人，机器人带 app_id', () => {
    const members = parseLarkMembers(JSON.stringify({
      data: {
        users: [{ member_id: 'ou_me', name: '我' }],
        bots: [{ member_id: 'ou_bot', name: 'Pz小助手', app_id: 'cli_x' }],
      },
    }))
    expect(members).toHaveLength(2)
    expect(members[0]).toEqual({ openId: 'ou_me', name: '我', type: 'user' })
    expect(members[1]).toEqual({ openId: 'ou_bot', name: 'Pz小助手', type: 'bot', appId: 'cli_x' })
  })

  it('从 auth status / config show 取自己的 open_id 与 appId', () => {
    expect(parseSelfOpenId(JSON.stringify({ identities: { user: { openId: 'ou_me' } } }))).toBe('ou_me')
    expect(parseSelfOpenId('bad')).toBe('')
    expect(parseAppId(JSON.stringify({ appId: 'cli_a' }))).toBe('cli_a')
  })

  it('解析 auth status 的机器人 / 用户授权状态', () => {
    const status = parseAuthStatus(JSON.stringify({
      appId: 'cli_a',
      identities: {
        bot: { available: true, status: 'ready', message: 'Bot identity: ready' },
        user: { available: true, status: 'needs_refresh', openId: 'ou_me', userName: '阿振' },
      },
    }))
    expect(status).toMatchObject({
      appId: 'cli_a',
      bot: { available: true, status: 'ready' },
      user: { available: true, status: 'needs_refresh', openId: 'ou_me', userName: '阿振' },
    })
    expect(parseAuthStatus('bad').bot.available).toBe(false)
  })

  it('解析 Device Flow 的 device_code 与 verification_url，兼容 data 包裹与 stderr 兜底', () => {
    expect(parseDeviceLogin(JSON.stringify({ device_code: 'dc_1', verification_url: 'https://example.com/activate', user_code: 'uc_1' })))
      .toEqual({ deviceCode: 'dc_1', verificationUrl: 'https://example.com/activate', userCode: 'uc_1' })
    expect(parseDeviceLogin(JSON.stringify({ data: { device_code: 'dc_2', verification_url: 'https://example.com/2' } })).deviceCode).toBe('dc_2')
    expect(parseDeviceLogin(JSON.stringify({ device_code: 'dc_3', verification_url: 'https://example.com/verify?user_code=AB-12' })).userCode).toBe('AB-12')
    expect(parseDeviceLogin('not json', 'open https://example.com/3 to authorize').verificationUrl).toBe('https://example.com/3')
  })

  it('解析机器人身份、事件预检与 orca status', () => {
    expect(parseBotAvailable(JSON.stringify({ identities: { bot: { available: true } } }))).toBe(true)
    expect(parseBotAvailable('bad')).toBe(false)
    expect(parseEventPrecheck(JSON.stringify({ data: { decision: { status: 'ready', preconditions: [{ name: 'scopes_granted', status: 'ok' }] } } }))).toEqual({ ready: true, detail: 'status=ready' })
    expect(parseEventPrecheck(JSON.stringify({ data: { decision: { status: 'blocked', preconditions: [{ name: 'scopes_granted', status: 'missing' }] } } })).ready).toBe(false)
    expect(parseOrcaStatus('appRunning: true\nruntimeReachable: true\nruntimeState: ready')).toEqual({ appRunning: 'true', runtimeReachable: 'true', runtimeState: 'ready' })
  })

  it('Orca 仓库列表只保留 git 类型的仓库', () => {
    const repos = parseOrcaRepos(JSON.stringify({
      result: { repos: [{ displayName: 'teamwork-repos', path: '/p', kind: 'git' }, { displayName: 'dsh', path: '/d', kind: 'folder' }] },
    }))
    expect(repos).toEqual([{ name: 'teamwork-repos', path: '/p', kind: 'git' }])
  })
})