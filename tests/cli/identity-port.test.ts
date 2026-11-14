import { describe, expect, it } from 'vitest'
import { createIdentityPort } from '../../src/cli/index.js'
import { chatEntry, defaultConfig, type AppConfig } from '../../src/config.js'
import type { CommandRunner } from '#infra/process.js'
import type { Logger } from '#infra/logger.js'
import type { IdentityCache } from '@router-agent/channel-feishu'

type Reply = { code: number; stdout: string; stderr: string }

const NO_CACHE: IdentityCache = { get: () => null, set: () => {} }

const NOOP_LOGGER: Logger = { info: () => {}, warn: () => {}, error: () => {} }

/** 假 runner：按 argv 决定返回什么。 */
function makeRunner(reply: (argv: string[]) => Reply): CommandRunner {
  return { run: async argv => reply(argv) }
}

const OK_BATCH = (email: string, openId: string): Reply => ({
  code: 0,
  stdout: JSON.stringify({ ok: true, data: { user_list: [{ email, user_id: openId }] } }),
  stderr: '',
})

const OK_USER = (openId: string, name: string): Reply => ({
  code: 0,
  stdout: JSON.stringify({ ok: true, data: { user: { open_id: openId, user_id: 'u_1', name, email: 'alice@example.com' } } }),
  stderr: '',
})

const OK_MEMBERS = (openId: string, name: string, appId: string): Reply => ({
  code: 0,
  stdout: JSON.stringify({ ok: true, data: { bots: [{ member_id: openId, name, app_id: appId }] } }),
  stderr: '',
})

function configWith(allowed: string[]): AppConfig {
  return {
    ...defaultConfig(),
    feishu: {
      ...defaultConfig().feishu,
      appId: 'cli_a',
      allowed,
      chats: [chatEntry('oc_dev', { scope: 'mention' })],
    },
  }
}

describe('身份端口', () => {
  it('重解析后把 open_id、机器人身份与显示名同步出去', async () => {
    const lark = makeRunner(argv => {
      if (argv.includes('/open-apis/contact/v3/users/batch_get_id')) return OK_BATCH('alice@example.com', 'ou_alice')
      if (argv.includes('+get-user')) return OK_USER('ou_alice', 'Alice')
      if (argv.includes('+chat-members-list')) return OK_MEMBERS('ou_bot', '机器人', 'cli_a')
      return { code: 0, stdout: '{}', stderr: '' }
    })
    const channel = { botOpenIds: [] as string[], botNames: [] as string[], actorNames: new Map<string, string>() }
    const port = createIdentityPort({
      config: configWith(['alice@example.com']),
      lark,
      cache: NO_CACHE,
      logger: NOOP_LOGGER,
      channel,
    })

    const status = await port.refresh()
    expect(status.entries[0]).toMatchObject({ entry: 'alice@example.com', status: 'resolved', name: 'Alice' })
    expect(port.policyIds?.().allowedOpenIds).toEqual(['ou_alice'])
    // 通道侧拿到的是新值：机器人身份变了，@ 判定必须用新的 open_id。
    expect(channel.botOpenIds).toEqual(['ou_bot'])
    expect(channel.botNames).toEqual(['机器人'])
    expect(channel.actorNames.get('ou_alice')).toBe('Alice')
    expect(port.snapshot().entries).toHaveLength(1)
  })

  it('重解析失败时抛出，保留上一次的快照', async () => {
    // allowed 不是数组：解析器会直接抛错，模拟一次没预料到的失败。
    const broken = configWith(['alice@example.com'])
    ;(broken.feishu as { allowed: unknown }).allowed = undefined
    const lark = makeRunner(() => ({ code: 0, stdout: '{}', stderr: '' }))
    const channel = { botOpenIds: ['ou_bot'] as string[], botNames: [] as string[], actorNames: new Map<string, string>() }
    const port = createIdentityPort({
      config: broken,
      lark,
      cache: NO_CACHE,
      logger: NOOP_LOGGER,
      channel,
    })

    await expect(port.refresh()).rejects.toThrow('允许名单重解析失败')
    // 失败不动通道侧，也不清空已有的快照。
    expect(channel.botOpenIds).toEqual(['ou_bot'])
    expect(port.snapshot().entries).toEqual([])
  })
})
