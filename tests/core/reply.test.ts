import { describe, expect, it } from 'vitest'
import { isReplyPayload } from '#core/reply.js'

describe('回复载荷校验', () => {
  it('卡片字段与操作合法时接受载荷', () => {
    const payload = {
      fallbackText: '部署结果',
      blocks: [{
        type: 'card',
        title: '部署结果',
        fields: [{ label: '环境', value: 'staging' }],
        actions: [{ label: '查看日志', url: 'https://example.com/logs' }],
      }],
    }
    expect(isReplyPayload(payload)).toBe(true)
  })

  it('卡片 fields 不是数组时拒绝，避免渲染时静默丢字段', () => {
    expect(isReplyPayload({
      fallbackText: '部署结果',
      blocks: [{ type: 'card', title: '部署结果', fields: '环境' }],
    })).toBe(false)
  })

  it('卡片操作项缺 url 时拒绝，避免生成点不动的按钮', () => {
    expect(isReplyPayload({
      fallbackText: '部署结果',
      blocks: [{ type: 'card', title: '部署结果', actions: [{ label: '查看日志' }] }],
    })).toBe(false)
  })
})
