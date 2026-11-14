import { describe, expect, it } from 'vitest'
import { admissionOf, isSmallTalk, type AdmissionContext } from '#core/admission.js'

describe('isSmallTalk', () => {
  it('pure_greetings_are_small_talk', () => {
    for (const text of ['你好', '你好，在吗', 'Hi', '在不在？', '测试一下', '谢谢！', '好的', '在吗在吗']) {
      expect(isSmallTalk(text)).toBe(true)
    }
  })

  it('requests_with_substance_are_not_small_talk', () => {
    for (const text of ['修个 bug', '改登录超时', '在吗，帮我把超时改成 30 秒', '你好，请把 README 端口改成 3083', '']) {
      expect(isSmallTalk(text)).toBe(false)
    }
  })
})

describe('admissionOf', () => {
  const base: AdmissionContext = { text: '修个 bug' }

  it('bot_messages_are_dropped_before_anything', () => {
    expect(admissionOf({ ...base, isBot: true })).toMatchObject({ outcome: 'drop', rule: 'bot' })
  })

  it('media_only_messages_bypass_to_router_for_fixed_reply', () => {
    expect(admissionOf({ ...base, mediaOnly: true })).toMatchObject({ outcome: 'bypass', rule: 'media-only' })
  })

  it('command_like_messages_bypass_to_router', () => {
    expect(admissionOf({ ...base, isCommand: true })).toMatchObject({ outcome: 'bypass', rule: 'command' })
  })

  it('active_intake_session_bypasses_repeat_decision', () => {
    expect(admissionOf({ ...base, hasActiveIntake: true })).toMatchObject({ outcome: 'bypass', rule: 'active-intake' })
  })

  it('bound_ticket_thread_bypasses_to_ticket_path', () => {
    expect(admissionOf({ ...base, hasBoundTicket: true })).toMatchObject({ outcome: 'bypass', rule: 'bound-ticket' })
  })

  it('admin_bypasses_identity_split_even_for_small_talk', () => {
    expect(admissionOf({ text: '你好', isAdmin: true })).toMatchObject({ outcome: 'bypass', rule: 'identity-split' })
  })

  it('member_small_talk_is_dropped_as_noise', () => {
    expect(admissionOf({ text: '你好', isAdmin: false })).toMatchObject({ outcome: 'drop', rule: 'noise' })
  })

  it('member_real_request_passes_to_decision_layer', () => {
    expect(admissionOf(base)).toMatchObject({ outcome: 'pass', rule: 'pass' })
  })
})
