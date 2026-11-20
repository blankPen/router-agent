import { describe, expect, it } from 'vitest'
import { looksLikeAutomationIntent } from '../../src/automation/intent.js'

describe('对话式自动化意图预筛', () => {
  it('「每天监听某仓库」这类周期动作会被识别', () => {
    expect(looksLikeAutomationIntent('帮我每天监听这个仓库的 issue')).toBe(true)
  })

  it('英文 schedule 描述也会被识别', () => {
    expect(looksLikeAutomationIntent('schedule a check every day for new issues')).toBe(true)
  })

  it('普通需求不会被误判', () => {
    expect(looksLikeAutomationIntent('帮我把登录超时改成 30 秒')).toBe(false)
  })

  it('只提到概念、没有动作时不会误判', () => {
    expect(looksLikeAutomationIntent('这个自动化是什么意思')).toBe(false)
  })
})
