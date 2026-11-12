import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CHAT_INTAKE,
  MAX_INTAKE_QUESTIONS,
  chatIntakeIssue,
  normalizeChatIntake,
} from '../../src/web/client/chat-intake.js'
import { sectionsFor } from '../../src/web/client/fields.js'

describe('需求分析助手的群级配置', () => {
  it('默认关闭、最多 10 轮、允许只读项目代码', () => {
    expect(DEFAULT_CHAT_INTAKE).toEqual({ enabled: false, approvers: [], maxQuestions: 10, codeAccess: true })
  })

  it('轮次必须是 0–50 的整数', () => {
    expect(chatIntakeIssue(undefined)).toBeNull()
    expect(chatIntakeIssue({ ...DEFAULT_CHAT_INTAKE, maxQuestions: 0 })).toBeNull()
    expect(chatIntakeIssue({ ...DEFAULT_CHAT_INTAKE, maxQuestions: 10 })).toBeNull()
    expect(chatIntakeIssue({ ...DEFAULT_CHAT_INTAKE, maxQuestions: -1 })).toContain('整数')
    expect(chatIntakeIssue({ ...DEFAULT_CHAT_INTAKE, maxQuestions: MAX_INTAKE_QUESTIONS + 1 })).toContain('整数')
    expect(chatIntakeIssue({ ...DEFAULT_CHAT_INTAKE, maxQuestions: 1.5 })).toContain('整数')
  })

  it('管理员条目去空白、丢空项', () => {
    const value = normalizeChatIntake({
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
    const sections = sectionsFor()
    expect(sections.find(section => section.id === 'intake')).toBeUndefined()
    const paths = sections.flatMap(section => section.fields.map(field => field.path))
    expect(paths.some(path => path.startsWith('intake.'))).toBe(false)
  })
})
