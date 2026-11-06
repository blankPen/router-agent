import { describe, expect, it } from 'vitest'
import { gate, negotiateAcceptance, revalidateMandate, type Policy } from '../../src/core/policy.js'
import type { Mandate, Trigger } from '../../src/core/model.js'

const policy: Policy = {
  version: 'p1',
  acceptMode: 'auto',
  maxWorkers: 4,
  allowed: ['ou_alice'],
  bots: ['cli_bot'],
  admission: {
    listedNotAddressed: 'inferred',
    unlistedAddressed: 'inferred',
    unlistedNotAddressed: 'ignore',
  },
  receiveAll: true,
}

function trigger(over: Partial<Trigger> = {}): Trigger {
  return {
    id: 't1',
    source: 'feishu',
    externalId: 'om_1',
    threadId: 'feishu:chat:om_1',
    chatId: 'oc_chat',
    chatName: '研发群',
    actorId: 'ou_alice',
    actorName: 'Alice',
    isBot: false,
    text: '帮我把登录超时改成 30 秒',
    addressed: 'mention',
    receivedAt: '2026-11-06T10:00:00.000Z',
    disposition: 'pending',
    ...over,
  }
}

describe('确定性 Gate', () => {
  it('名单内成员 @bot 是显式请求，任何 accept mode 下都成立', () => {
    for (const mode of ['off', 'observe', 'auto'] as const) {
      expect(gate(trigger(), { ...policy, acceptMode: mode })).toEqual({ action: 'explicit', strength: 'explicit' })
    }
  })

  it('名单内成员未 @ 时按准入表进入研判', () => {
    expect(gate(trigger({ addressed: 'none' }), policy)).toEqual({ action: 'infer', strength: 'inferred' })
  })

  it('名单外成员 @bot 时进入研判', () => {
    expect(gate(trigger({ actorId: 'ou_bob' }), policy)).toEqual({ action: 'infer', strength: 'inferred' })
  })

  it('名单外成员未 @ 时忽略', () => {
    expect(gate(trigger({ actorId: 'ou_bob', addressed: 'none' }), policy)).toEqual({ action: 'ignore', reason: 'admission:unlisted-not-addressed' })
  })

  it('私聊不构成显式授权：进入研判（设计文档 2.3）', () => {
    expect(gate(trigger({ addressed: 'direct' }), policy)).toEqual({ action: 'infer', strength: 'inferred' })
    expect(gate(trigger({ addressed: 'direct' }), { ...policy, acceptMode: 'off' })).toEqual({ action: 'reply-only', strength: 'inferred', reason: 'accept-mode:off' })
  })

  it('私聊按已寻址处理', () => {
    expect(gate(trigger({ addressed: 'direct', actorId: 'ou_bob' }), policy)).toEqual({ action: 'infer', strength: 'inferred' })
  })

  it('accept mode 为 off 时推断候选只回复说明、不开工', () => {
    expect(gate(trigger({ addressed: 'none' }), { ...policy, acceptMode: 'off' })).toEqual({
      action: 'reply-only',
      strength: 'inferred',
      reason: 'accept-mode:off',
    })
  })

  it('accept mode 为 off 时显式请求仍然开工', () => {
    expect(gate(trigger(), { ...policy, acceptMode: 'off' }).action).toBe('explicit')
  })

  it('名单外 @bot 在 off 模式下同样只回复说明', () => {
    expect(gate(trigger({ actorId: 'ou_bob' }), { ...policy, acceptMode: 'off' }).action).toBe('reply-only')
  })

  it('机器人只有被列入 bots 才可能成为推断候选，且永远不是显式', () => {
    expect(gate(trigger({ isBot: true, actorId: 'cli_bot' }), policy)).toEqual({ action: 'infer', strength: 'inferred' })
    expect(gate(trigger({ isBot: true, actorId: 'other_bot' }), policy).action).toBe('ignore')
    // 接收全部消息的范围内，被列入的机器人未 @ 也可以成为推断候选
    expect(gate(trigger({ isBot: true, actorId: 'cli_bot', addressed: 'none' }), policy)).toEqual({ action: 'infer', strength: 'inferred' })
    // 不接收全部消息时，同样的消息无法进入研判
    expect(gate(trigger({ isBot: true, actorId: 'cli_bot', addressed: 'none' }), { ...policy, receiveAll: false }).action).toBe('ignore')
  })

  it('准入表可把名单外 @ 设为显式，支持专用支持群', () => {
    const p = { ...policy, admission: { ...policy.admission, unlistedAddressed: 'explicit' as const } }
    expect(gate(trigger({ actorId: 'ou_bob' }), p)).toEqual({ action: 'explicit', strength: 'explicit' })
  })
})

describe('accept mode 判定', () => {
  it('observe 模式下推断通过只记录「本应接单」', () => {
    expect(negotiateAcceptance('accept', 'inferred', 'observe')).toEqual({ decision: 'ignore', wouldAccept: true })
  })

  it('auto 模式下推断通过直接接单', () => {
    expect(negotiateAcceptance('accept', 'inferred', 'auto')).toEqual({ decision: 'accept', wouldAccept: false })
  })

  it('显式请求不受 accept mode 影响', () => {
    expect(negotiateAcceptance('accept', 'explicit', 'observe')).toEqual({ decision: 'accept', wouldAccept: false })
    expect(negotiateAcceptance('accept', 'explicit', 'off')).toEqual({ decision: 'accept', wouldAccept: false })
  })

  it('ignore / stop / unavailable 原样保留', () => {
    expect(negotiateAcceptance('stop', 'inferred', 'observe')).toEqual({ decision: 'stop', wouldAccept: false })
  })
})

describe('Mandate 重新校验', () => {
  const mandate: Mandate = {
    id: 'md1',
    ticketId: 'tk1',
    policyVersion: 'p0',
    strength: 'inferred',
    scope: '修复登录超时',
    rules: ['bugfix'],
    actorId: 'ou_alice',
    actorName: 'Alice',
    source: 'feishu',
    chatId: 'oc_chat',
    threadId: 'feishu:chat:om_1',
    createdAt: '2026-11-06T09:00:00.000Z',
  }

  it('显式 Mandate 在策略变化后仍然有效', () => {
    expect(revalidateMandate({ ...mandate, strength: 'explicit' }, { ...policy, acceptMode: 'off' })).toEqual({ valid: true })
  })

  it('推断 Mandate 在 accept mode 不再是 auto 时失效', () => {
    expect(revalidateMandate(mandate, { ...policy, acceptMode: 'observe' })).toEqual({ valid: false, reason: 'accept-mode:not-auto' })
  })

  it('推断 Mandate 在 auto 模式下且发起人仍在名单内时有效', () => {
    expect(revalidateMandate(mandate, policy)).toEqual({ valid: true })
  })

  it('发起人被移出名单后推断 Mandate 失效', () => {
    expect(revalidateMandate(mandate, { ...policy, allowed: [] })).toEqual({ valid: false, reason: 'sender:not-allowed' })
  })
})

describe('群级白名单', () => {
  const scoped: Policy = { ...policy, allowedByChat: { oc_chat: ['ou_bob'] } }

  it('配了群白名单后，只认这一份：全局名单外的人进来也无效', () => {
    expect(gate(trigger({ actorId: 'ou_bob' }), scoped)).toEqual({ action: 'explicit', strength: 'explicit' })
    // ou_alice 在全局名单里，但不在这个群的白名单里
    expect(gate(trigger({ actorId: 'ou_alice' }), scoped)).toEqual({ action: 'ignore', reason: 'admission:not-in-chat-allowlist' })
  })

  it('群白名单只影响该群，其它群仍走全局 allowed', () => {
    expect(gate(trigger({ chatId: 'oc_other', actorId: 'ou_alice' }), scoped)).toEqual({ action: 'explicit', strength: 'explicit' })
    expect(gate(trigger({ chatId: 'oc_other', actorId: 'ou_bob' }), scoped)).toMatchObject({ action: 'infer' })
  })

  it('空白名单等于没配，沿用全局 allowed', () => {
    expect(gate(trigger({ actorId: 'ou_alice' }), { ...policy, allowedByChat: { oc_chat: [] } })).toEqual({ action: 'explicit', strength: 'explicit' })
  })

  it('Mandate 重新校验也按群白名单判定', () => {
    const mandate: Mandate = {
      id: 'md1', ticketId: 'tk1', policyVersion: 'p1', strength: 'inferred', scope: 'x', rules: [],
      actorId: 'ou_alice', actorName: 'Alice', source: 'feishu', chatId: 'oc_chat', threadId: 'feishu:oc_chat:om_1',
      createdAt: '2026-11-06T10:00:00.000Z',
    }
    expect(revalidateMandate(mandate, scoped)).toEqual({ valid: false, reason: 'sender:not-allowed' })
    expect(revalidateMandate({ ...mandate, actorId: 'ou_bob' }, scoped)).toEqual({ valid: true })
  })
})
