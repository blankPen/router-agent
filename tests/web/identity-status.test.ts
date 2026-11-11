import { describe, expect, it } from 'vitest'
import {
  describeEntry,
  normalizeIdentityStatus,
  problemEntries,
  summarizeBot,
  summarizeIdentity,
  type IdentityStatusView,
} from '../../src/web/client/identity-status.js'

function view(partial: Partial<IdentityStatusView> = {}): IdentityStatusView {
  return {
    entries: [],
    bot: { botOpenIds: [], botNames: [], resolved: true, detail: '' },
    invalidCount: 0,
    pendingCount: 0,
    ...partial,
  }
}

const RESOLVED_EMAIL = {
  entry: 'pengzhen@dewu.com',
  kind: 'email' as const,
  status: 'resolved' as const,
  name: '阿振(Pz)',
  detail: '',
}

describe('允许名单解析状态汇总', () => {
  it('没有状态时也不报错', () => {
    const summary = summarizeIdentity(undefined)
    expect(summary.kind).toBe('ok')
    expect(summary.text).toBeTruthy()
  })

  it('有条目解析不到时提示错误', () => {
    const summary = summarizeIdentity(view({ invalidCount: 2 }))
    expect(summary.kind).toBe('error')
    expect(summary.text).toContain('没能解析到')
  })

  it('只有待重试条目时提示警告', () => {
    const summary = summarizeIdentity(view({ pendingCount: 1 }))
    expect(summary.kind).toBe('warn')
    expect(summary.text).toContain('待重试')
  })

  it('全部解析到时提示正常', () => {
    const summary = summarizeIdentity(view({ entries: [RESOLVED_EMAIL] }))
    expect(summary.kind).toBe('ok')
    expect(summary.text).toContain('已解析')
  })
})

describe('名单条目展示', () => {
  it('邮箱只显示掩码后的形态', () => {
    const text = describeEntry(RESOLVED_EMAIL)
    expect(text).not.toContain('pengzhen@dewu.com')
    expect(text).toContain('p***@dewu.com')
    expect(text).toContain('阿振(Pz)')
  })

  it('open_id 原样显示并带上失败原因', () => {
    const text = describeEntry({
      entry: 'ou_abc',
      kind: 'open_id',
      status: 'invalid',
      name: '',
      detail: '当前应用下查不到这个 id',
    })
    expect(text).toContain('ou_abc')
    expect(text).toContain('查不到这个 id')
  })

  it('只挑出有问题的条目', () => {
    const entries = problemEntries(view({
      entries: [
        RESOLVED_EMAIL,
        { entry: 'bad', kind: 'invalid', status: 'invalid', name: '', detail: '格式不对' },
        { entry: 'x@y.com', kind: 'email', status: 'pending', name: '', detail: '通讯录超时' },
      ],
    }))
    expect(entries.map(entry => entry.status)).toEqual(['invalid', 'pending'])
  })
})

describe('机器人身份', () => {
  it('没识别出来时提示 @ 模式会失效', () => {
    const summary = summarizeBot(view({
      bot: { botOpenIds: [], botNames: [], resolved: false, detail: '群 oc_1 里没找到机器人' },
    }))
    expect(summary.kind).toBe('error')
    expect(summary.text).toContain('机器人身份没识别出来')
    expect(summary.text).toContain('@ 模式的消息不会被接收')
  })

  it('后端把「无需识别」标成 resolved=true 时不再告警', () => {
    const summary = summarizeBot(view({
      bot: { botOpenIds: [], botNames: [], resolved: true, detail: '没有配置 mode=mention 的群，无需识别机器人身份' },
    }))
    expect(summary.kind).toBe('ok')
    expect(summary.text).not.toContain('机器人身份没识别出来')
  })

  it('识别出来时显示机器人名字', () => {
    const summary = summarizeBot(view({
      bot: { botOpenIds: ['ou_bot'], botNames: ['阿罗'], resolved: true, detail: '按 App ID 自动识别' },
    }))
    expect(summary.kind).toBe('ok')
    expect(summary.text).toContain('阿罗')
  })
})

describe('残缺的服务端快照', () => {
  it('缺 entries 与 bot 时按良性缺省归一，不抛错', () => {
    const normalized = normalizeIdentityStatus({})
    expect(normalized.entries).toEqual([])
    expect(normalized.bot.resolved).toBe(true)
    expect(normalized.bot.botOpenIds).toEqual([])
    expect(normalized.invalidCount).toBe(0)
    expect(normalized.pendingCount).toBe(0)

    // 面板的汇总函数也必须能直接处理残缺快照，不能拖垮整个配置页。
    expect(summarizeIdentity({} as IdentityStatusView).kind).toBe('ok')
    expect(summarizeBot({} as IdentityStatusView).kind).toBe('ok')
    expect(problemEntries({} as IdentityStatusView)).toEqual([])
  })

  it('只缺 bot 时仍保留可用的 entries 与计数', () => {
    const normalized = normalizeIdentityStatus({
      entries: [RESOLVED_EMAIL],
      invalidCount: 1,
      pendingCount: 2,
    } as IdentityStatusView)
    expect(normalized.entries).toEqual([RESOLVED_EMAIL])
    expect(normalized.bot.resolved).toBe(true)
    expect(normalized.invalidCount).toBe(1)
    expect(normalized.pendingCount).toBe(2)
  })
})
