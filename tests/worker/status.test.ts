import { describe, expect, it } from 'vitest'
import { latestActivityAt } from '../../src/worker/status.js'

describe('最后活动时间', () => {
  it('取多个时间戳里最新的一个，空值忽略', () => {
    expect(latestActivityAt(
      undefined,
      '2026-11-09T08:46:59.000Z',
      '2026-11-09T08:53:47.000Z',
    )).toBe('2026-11-09T08:53:47.000Z')
  })

  it('全空时返回 undefined', () => {
    expect(latestActivityAt()).toBeUndefined()
  })
})