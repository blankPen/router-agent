import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CHAT_MEMBERS,
  MAX_MEMBER_QUESTIONS,
  chatMembersIssue,
  normalizeChatMembers,
} from '../../src/web/client/chat-members.js'
import { groupFields, groupsFor } from '../../src/web/client/fields.js'

describe('处理普通成员消息的群级配置', () => {
  it('默认关闭、最多 10 轮、允许只读项目代码', () => {
    expect(DEFAULT_CHAT_MEMBERS).toEqual({ enabled: false, approvers: [], maxQuestions: 10, codeAccess: true })
  })

  it('轮次必须是 0–50 的整数', () => {
    expect(chatMembersIssue(undefined)).toBeNull()
    expect(chatMembersIssue({ ...DEFAULT_CHAT_MEMBERS, maxQuestions: 0 })).toBeNull()
    expect(chatMembersIssue({ ...DEFAULT_CHAT_MEMBERS, maxQuestions: 10 })).toBeNull()
    expect(chatMembersIssue({ ...DEFAULT_CHAT_MEMBERS, maxQuestions: -1 })).toContain('整数')
    expect(chatMembersIssue({ ...DEFAULT_CHAT_MEMBERS, maxQuestions: MAX_MEMBER_QUESTIONS + 1 })).toContain('整数')
    expect(chatMembersIssue({ ...DEFAULT_CHAT_MEMBERS, maxQuestions: 1.5 })).toContain('整数')
  })

  it('管理员条目去空白、丢空项', () => {
    const value = normalizeChatMembers({
      enabled: true,
      approvers: [' admin@example.com ', '', 'ou_x'],
      maxQuestions: 10,
      codeAccess: false,
    })
    expect(value.approvers).toEqual(['admin@example.com', 'ou_x'])
    expect(value.enabled).toBe(true)
    expect(value.codeAccess).toBe(false)
  })

  it('配置面板不再有全局「需求识别」分组：配置下沉到群', () => {
    const groups = groupsFor()
    expect(groups.find(group => group.id === 'intake')).toBeUndefined()
    const paths = groupFields(groups).map(field => field.path)
    expect(paths.some(path => path.startsWith('intake.'))).toBe(false)
  })
})
