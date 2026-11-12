import { describe, expect, it } from 'vitest'
import { FeishuBotAdmin, FEISHU_AUTH_DOMAINS, FEISHU_AUTH_SCOPES, feishuAuthScopeArgs } from '@router-agent/channel-feishu'
import type { CommandRunner } from '#infra/process.js'

describe('飞书授权参数', () => {
  it('业务域之外显式申请 contact:user.id:readonly', () => {
    // lark-cli 的 contact 域不含这个 scope；邮箱→open_id 的 batch_get_id 依赖它。
    expect(FEISHU_AUTH_SCOPES).toContain('contact:user.id:readonly')
    expect(feishuAuthScopeArgs()).toEqual([
      '--domain', FEISHU_AUTH_DOMAINS.join(','),
      '--scope', 'contact:user.id:readonly',
    ])
  })

  it('仍然只申请 router-agent 用到的四个业务域', () => {
    expect(FEISHU_AUTH_DOMAINS).toEqual(['im', 'docs', 'drive', 'contact'])
  })
})

describe('Device Flow 授权', () => {
  it('发起授权时带上显式 scope', async () => {
    const calls: string[][] = []
    const lark: CommandRunner = {
      async run(argv) {
        calls.push(argv)
        return {
          code: 0,
          stdout: JSON.stringify({ device_code: 'dc_1', verification_url: 'https://example.com/v' }),
          stderr: '',
        }
      },
    }
    const admin = new FeishuBotAdmin({ lark })
    const login = await admin.startLogin()
    expect(login.deviceCode).toBe('dc_1')
    expect(calls[0]).toEqual([
      'auth', 'login', '--no-wait', '--json',
      '--domain', 'im,docs,drive,contact',
      '--scope', 'contact:user.id:readonly',
    ])
  })
})
