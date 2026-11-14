import { describe, expect, it } from 'vitest'
import {
  admitsByScope,
  effectiveAdmins,
  effectiveAllowed,
  gate,
  handlesUnaddressed,
  negotiateAcceptance,
  revalidateMandate,
  scopeOf,
  shouldAcknowledge,
  type Policy,
} from '#core/policy.js'
import type { Mandate, Trigger } from '#core/model.js'

const policy: Policy = {
  version: 'p1',
  acceptMode: 'auto',
  maxWorkers: 4,
  allowed: ['ou_alice'],
  bots: ['cli_bot'],
  scopeByChat: { oc_chat: 'mention' },
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
  it('管理员 @bot 是显式请求，任何 accept mode 下都成立', () => {
    for (const mode of ['off', 'observe', 'auto'] as const) {
      expect(gate(trigger(), { ...policy, acceptMode: mode })).toEqual({ action: 'explicit', strength: 'explicit' })
    }
  })

  it('管理员未 @ 时按推断候选进研判', () => {
    expect(gate(trigger({ addressed: 'none' }), policy)).toEqual({ action: 'infer', strength: 'inferred' })
  })

  it('普通成员 @bot 时进入研判，但不给显式授权', () => {
    expect(gate(trigger({ actorId: 'ou_bob' }), policy)).toEqual({ action: 'infer', strength: 'inferred' })
  })

  it('普通成员未 @ 时忽略', () => {
    expect(gate(trigger({ actorId: 'ou_bob', addressed: 'none' }), policy)).toEqual({ action: 'ignore', reason: 'admission:not-addressed' })
  })

  it('私聊不构成显式授权：进入研判（设计文档 2.3）', () => {
    expect(gate(trigger({ addressed: 'direct' }), policy)).toEqual({ action: 'infer', strength: 'inferred' })
    expect(gate(trigger({ addressed: 'direct' }), { ...policy, acceptMode: 'off' })).toEqual({ action: 'reply-only', strength: 'inferred', reason: 'accept-mode:off' })
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

  it('机器人只有被列入 bots 才可能成为推断候选，且永远不是显式', () => {
    expect(gate(trigger({ isBot: true, actorId: 'cli_bot' }), policy)).toEqual({ action: 'infer', strength: 'inferred' })
    expect(gate(trigger({ isBot: true, actorId: 'other_bot' }), policy).action).toBe('ignore')
    // 未 @ 的机器人消息只在「接受所有消息」的群里算数
    expect(gate(trigger({ isBot: true, actorId: 'cli_bot', addressed: 'none' }), policy).action).toBe('ignore')
    expect(gate(trigger({ isBot: true, actorId: 'cli_bot', addressed: 'none' }), {
      ...policy,
      scopeByChat: { oc_chat: 'all' },
    })).toEqual({ action: 'infer', strength: 'inferred' })
  })
})

describe('群消息范围', () => {
  it('没配范围的群按 mention 处理', () => {
    expect(scopeOf(policy, 'oc_other')).toBe('mention')
    expect(scopeOf({ ...policy, scopeByChat: {} }, 'oc_other')).toBe('mention')
  })

  it('仅接受管理员消息的群：普通成员 @ 也不处理', () => {
    const adminsOnly: Policy = { ...policy, scopeByChat: { oc_chat: 'admins' } }
    expect(gate(trigger({ actorId: 'ou_bob' }), adminsOnly)).toEqual({ action: 'ignore', reason: 'admission:not-admin' })
    expect(gate(trigger({ actorId: 'ou_alice' }), adminsOnly)).toEqual({ action: 'explicit', strength: 'explicit' })
    expect(gate(trigger({ actorId: 'ou_alice', addressed: 'none' }), adminsOnly)).toEqual({ action: 'infer', strength: 'inferred' })
  })

  it('接受所有消息的群：普通成员未 @ 也进流程', () => {
    const all: Policy = { ...policy, scopeByChat: { oc_chat: 'all' } }
    expect(gate(trigger({ actorId: 'ou_bob', addressed: 'none' }), all)).toEqual({ action: 'infer', strength: 'inferred' })
  })

  it('admitsByScope 与 Gate 同口径', () => {
    expect(admitsByScope('admins', true, false)).toBe(true)
    expect(admitsByScope('admins', false, true)).toBe(false)
    expect(admitsByScope('mention', false, true)).toBe(true)
    expect(admitsByScope('mention', false, false)).toBe(false)
    expect(admitsByScope('all', false, false)).toBe(true)
  })

  it('未 @ 的消息：只有「接受所有消息」的群才回话', () => {
    expect(handlesUnaddressed(policy, 'oc_chat')).toBe(false)
    expect(handlesUnaddressed({ ...policy, scopeByChat: { oc_chat: 'all' } }, 'oc_chat')).toBe(true)
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

  it('推断 Mandate 在 auto 模式下且发起人仍是管理员时有效', () => {
    expect(revalidateMandate(mandate, policy)).toEqual({ valid: true })
  })

  it('发起人被移出管理员名单后推断 Mandate 失效', () => {
    expect(revalidateMandate(mandate, { ...policy, allowed: [] })).toEqual({ valid: false, reason: 'sender:not-allowed' })
  })
})

describe('管理员名单：默认名单 + 群内扩充', () => {
  const scoped: Policy = { ...policy, allowedByChat: { oc_chat: ['ou_bob'] } }

  it('群名单是扩充：默认管理员仍然有效', () => {
    expect(effectiveAdmins(scoped, 'oc_chat')).toEqual(['ou_alice', 'ou_bob'])
    expect(gate(trigger({ actorId: 'ou_alice' }), scoped)).toEqual({ action: 'explicit', strength: 'explicit' })
    expect(gate(trigger({ actorId: 'ou_bob' }), scoped)).toEqual({ action: 'explicit', strength: 'explicit' })
  })

  it('名单外的人只是普通成员，按群范围处理', () => {
    expect(gate(trigger({ actorId: 'ou_carol' }), scoped)).toEqual({ action: 'infer', strength: 'inferred' })
    expect(gate(trigger({ actorId: 'ou_carol', addressed: 'none' }), scoped)).toEqual({ action: 'ignore', reason: 'admission:not-addressed' })
  })

  it('群名单只影响该群，其它群仍走默认名单', () => {
    expect(gate(trigger({ chatId: 'oc_other', actorId: 'ou_alice' }), scoped)).toEqual({ action: 'explicit', strength: 'explicit' })
    expect(gate(trigger({ chatId: 'oc_other', actorId: 'ou_bob' }), scoped)).toMatchObject({ action: 'infer' })
  })

  it('Mandate 重新校验也按扩充后的名单判定', () => {
    const mandate: Mandate = {
      id: 'md1', ticketId: 'tk1', policyVersion: 'p1', strength: 'inferred', scope: 'x', rules: [],
      actorId: 'ou_alice', actorName: 'Alice', source: 'feishu', chatId: 'oc_chat', threadId: 'feishu:oc_chat:om_1',
      createdAt: '2026-11-06T10:00:00.000Z',
    }
    expect(revalidateMandate(mandate, scoped)).toEqual({ valid: true })
    expect(revalidateMandate({ ...mandate, actorId: 'ou_carol' }, scoped)).toEqual({ valid: false, reason: 'sender:not-allowed' })
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

  it('不在解析结果里的人不算管理员', () => {
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

  it('群级名单按解析出的 open_id 匹配', () => {
    const scoped: Policy = {
      ...policy,
      allowedByChat: { oc_chat: ['a@b.com'] },
      allowedByChatOpenIds: { oc_chat: ['ou_bob'] },
    }
    expect(effectiveAdmins(scoped, 'oc_chat')).toEqual(['ou_alice', 'ou_bob'])
    expect(gate(trigger({ actorId: 'ou_bob' }), scoped)).toEqual({ action: 'explicit', strength: 'explicit' })
  })

  it('群级名单配了但解析为空：只按默认管理员算', () => {
    const scoped: Policy = {
      ...policy,
      allowedByChat: { oc_chat: ['a@b.com'] },
      allowedByChatOpenIds: { oc_chat: [] },
    }
    expect(effectiveAdmins(scoped, 'oc_chat')).toEqual(['ou_alice'])
    expect(gate(trigger({ actorId: 'ou_alice' }), scoped)).toEqual({ action: 'explicit', strength: 'explicit' })
  })
})

describe('回执表情', () => {
  it('范围不覆盖的人 @ 机器人：不加表情（否则有表情、永远没回复）', () => {
    const adminsOnly: Policy = { ...policy, scopeByChat: { oc_chat: 'admins' } }
    expect(shouldAcknowledge(trigger({ actorId: 'ou_bob' }), adminsOnly)).toBe(false)
  })

  it('管理员 @ 机器人：加表情', () => {
    expect(shouldAcknowledge(trigger(), policy)).toBe(true)
  })

  it('普通成员 @ 机器人：加表情（会进决策层）', () => {
    expect(shouldAcknowledge(trigger({ actorId: 'ou_bob' }), policy)).toBe(true)
  })

  it('普通成员未 @ 且群里不是「接受所有消息」：不加表情', () => {
    expect(shouldAcknowledge(trigger({ actorId: 'ou_bob', addressed: 'none' }), policy)).toBe(false)
  })

  it('管理员未 @ 且群里不主动回话：不加表情（不插话就别留「Typing」）', () => {
    expect(shouldAcknowledge(trigger({ addressed: 'none' }), policy)).toBe(false)
  })

  it('「接受所有消息」群里普通成员未 @：加表情', () => {
    const all: Policy = { ...policy, scopeByChat: { oc_chat: 'all' } }
    expect(shouldAcknowledge(trigger({ actorId: 'ou_bob', addressed: 'none' }), all)).toBe(true)
  })

  it('未 @ 但话题已绑定工单被放行的消息：加表情（否则用户看不到回应）', () => {
    expect(shouldAcknowledge(trigger({ addressed: 'none', unaddressedAdmitted: true }), policy)).toBe(true)
  })

  it('私聊消息加表情', () => {
    expect(shouldAcknowledge(trigger({ actorId: 'ou_bob', addressed: 'direct' }), policy)).toBe(true)
  })
})
