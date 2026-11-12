import { describe, expect, it } from 'vitest'
import {
  effectiveAllowed,
  effectiveAllowedByChat,
  gate,
  negotiateAcceptance,
  revalidateMandate,
  shouldAcknowledge,
  type Policy,
} from '../../src/core/policy.js'
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

describe('名单解析结果', () => {
  /** 配置里写的是邮箱，运行时按解析出的 open_id 匹配。 */
  const emailPolicy: Policy = { ...policy, allowed: ['a@b.com'], allowedOpenIds: ['ou_alice'] }

  const mandate: Mandate = {
    id: 'md1',
    ticketId: 'tk1',
    policyVersion: 'p1',
    strength: 'inferred',
    scope: 'x',
    rules: [],
    actorId: 'ou_alice',
    actorName: 'Alice',
    source: 'feishu',
    chatId: 'oc_chat',
    threadId: 'feishu:oc_chat:om_1',
    createdAt: '2026-11-06T10:00:00.000Z',
  }

  it('邮箱条目按解析出的 open_id 命中名单', () => {
    expect(gate(trigger({ actorId: 'ou_alice', addressed: 'mention' }), emailPolicy)).toEqual({ action: 'explicit', strength: 'explicit' })
  })

  it('不在解析结果里的人不算名单内', () => {
    expect(gate(trigger({ actorId: 'ou_bob', addressed: 'mention' }), emailPolicy).action).not.toBe('explicit')
  })

  it('旧库里没有解析结果的 Policy 仍按原始条目匹配', () => {
    const legacy: Policy = { ...policy, allowed: ['ou_alice'] }
    expect('allowedOpenIds' in legacy).toBe(false)
    expect(gate(trigger({ actorId: 'ou_alice' }), legacy)).toEqual({ action: 'explicit', strength: 'explicit' })
  })

  it('effectiveAllowed 优先用解析结果，缺失时回退原始条目', () => {
    expect(effectiveAllowed(emailPolicy)).toEqual(['ou_alice'])
    expect(effectiveAllowed({ ...policy, allowed: ['ou_alice'] })).toEqual(['ou_alice'])
  })

  it('effectiveAllowedByChat 区分「未配置该群」与「配了但解析为空」', () => {
    expect(effectiveAllowedByChat(policy, 'oc_chat')).toBeUndefined()
    expect(effectiveAllowedByChat({ ...policy, allowedByChat: { oc_chat: [] } }, 'oc_chat')).toBeUndefined()
    expect(effectiveAllowedByChat({ ...policy, allowedByChat: { oc_chat: ['a@b.com'] } }, 'oc_chat')).toEqual(['a@b.com'])
    expect(effectiveAllowedByChat({ ...policy, allowedByChat: { oc_chat: ['a@b.com'] }, allowedByChatOpenIds: { oc_chat: [] } }, 'oc_chat')).toEqual([])
  })

  it('群级名单按解析出的 open_id 匹配', () => {
    const scoped: Policy = {
      ...policy,
      allowedByChat: { oc_chat: ['a@b.com'] },
      allowedByChatOpenIds: { oc_chat: ['ou_alice'] },
    }
    expect(gate(trigger({ actorId: 'ou_alice' }), scoped)).toEqual({ action: 'explicit', strength: 'explicit' })
    expect(gate(trigger({ actorId: 'ou_bob' }), scoped)).toEqual({ action: 'ignore', reason: 'admission:not-in-chat-allowlist' })
  })

  it('群级名单配了但解析为空：该群拒绝所有人，不退回全局名单', () => {
    const scoped: Policy = {
      ...policy,
      allowedByChat: { oc_chat: ['a@b.com'] },
      allowedByChatOpenIds: { oc_chat: [] },
    }
    // ou_alice 在全局名单里，但这个群的名单一个都没解析出来 → 谁都不许进
    expect(gate(trigger({ actorId: 'ou_alice' }), scoped)).toEqual({ action: 'ignore', reason: 'admission:chat-allowlist-empty' })
  })

  it('Mandate 重新校验按解析结果判定发起人是否仍在名单内', () => {
    expect(revalidateMandate(mandate, emailPolicy)).toEqual({ valid: true })
    expect(revalidateMandate({ ...mandate, actorId: 'ou_bob' }, emailPolicy)).toEqual({ valid: false, reason: 'sender:not-allowed' })
  })
})

describe('回执表情', () => {
  const replyAll = new Set(['oc_chat'])

  it('被群白名单拦截的人 @ 机器人：不加表情（否则有表情、永远没回复）', () => {
    const scoped: Policy = { ...policy, allowedByChat: { oc_chat: ['ou_bob'] } }
    expect(shouldAcknowledge(trigger({ actorId: 'ou_alice' }), scoped, new Set())).toBe(false)
  })

  it('群白名单内的人 @ 机器人：加表情', () => {
    const scoped: Policy = { ...policy, allowedByChat: { oc_chat: ['ou_bob'] } }
    expect(shouldAcknowledge(trigger({ actorId: 'ou_bob' }), scoped, new Set())).toBe(true)
  })

  it('全量接收群里，名单外未 @ 的消息会被 admission 忽略：不加表情', () => {
    expect(shouldAcknowledge(trigger({ actorId: 'ou_bob', addressed: 'none' }), policy, replyAll)).toBe(false)
  })

  it('全量接收群里，名单内未 @ 的消息：会进研判，加表情', () => {
    expect(shouldAcknowledge(trigger({ addressed: 'none' }), policy, replyAll)).toBe(true)
  })

  it('非全量接收群里未 @ 的消息：不加表情', () => {
    expect(shouldAcknowledge(trigger({ addressed: 'none' }), policy, new Set())).toBe(false)
  })

  it('未 @ 但话题已绑定工单被放行的消息：加表情（否则用户看不到回应）', () => {
    expect(shouldAcknowledge(trigger({ addressed: 'none', unaddressedAdmitted: true }), policy, new Set())).toBe(true)
  })

  it('未 @ 放行的消息即使准入表要求忽略未寻址消息，也照样加表情：它一定会被处理', () => {
    const strict: Policy = { ...policy, admission: { ...policy.admission, listedNotAddressed: 'ignore' } }
    expect(shouldAcknowledge(trigger({ addressed: 'none', unaddressedAdmitted: true }), strict, new Set())).toBe(true)
  })

  it('未 @ 放行的消息若被群白名单拦下：仍然不加表情', () => {
    const scoped: Policy = { ...policy, allowedByChat: { oc_chat: ['ou_bob'] } }
    expect(shouldAcknowledge(trigger({ actorId: 'ou_alice', addressed: 'none', unaddressedAdmitted: true }), scoped, new Set())).toBe(false)
  })

  it('名单外但准入允许研判的 @ 消息：仍加表情', () => {
    expect(shouldAcknowledge(trigger({ actorId: 'ou_bob' }), policy, new Set())).toBe(true)
  })

  it('私聊消息加表情', () => {
    expect(shouldAcknowledge(trigger({ actorId: 'ou_bob', addressed: 'direct' }), policy, new Set())).toBe(true)
  })
})
