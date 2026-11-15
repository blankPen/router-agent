import { describe, expect, it } from 'vitest'
import { approvePayload, needsProjectForApprove, projectOptions } from '../../src/web/client/events-model.js'

describe('事件面板操作', () => {
  it('没有判定出项目的待审核事件，批准前要先选项目', () => {
    expect(needsProjectForApprove({ status: 'review' })).toBe(true)
    expect(needsProjectForApprove({ status: 'review', project: 'router-agent' })).toBe(false)
    expect(needsProjectForApprove({ status: 'review', project: '  ' })).toBe(true)
  })

  it('不是待审核状态的事件不需要选项目', () => {
    expect(needsProjectForApprove({ status: 'pending' })).toBe(false)
    expect(needsProjectForApprove({ status: 'done' })).toBe(false)
  })

  it('批准时带上选好的项目', () => {
    expect(approvePayload('router-agent')).toEqual({ action: 'approve', project: 'router-agent' })
    expect(approvePayload('  ')).toEqual({ action: 'approve' })
  })

  it('项目选项按名字排序', () => {
    const options = projectOptions([{ name: 'ops', repo: '/r/ops' }, { name: 'api', repo: '/r/api' }])
    expect(options.map(item => item.name)).toEqual(['api', 'ops'])
  })
})
