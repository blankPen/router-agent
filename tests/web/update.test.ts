import { describe, expect, it } from 'vitest'
import { hasPendingUpdate, parseSkippedVersion, updateBannerVisible, type UpdateSnapshot } from '../../src/web/client/update.js'

function snapshot(over: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    current: '0.3.0',
    latest: '0.4.0',
    installedVersion: null,
    hasUpdate: true,
    checkedAt: '2026-11-09T10:00:00.000Z',
    phase: 'idle',
    error: null,
    message: null,
    ...over,
  }
}

describe('忽略版本', () => {
  it('空白值视为没有忽略', () => {
    expect(parseSkippedVersion(null)).toBeNull()
    expect(parseSkippedVersion('')).toBeNull()
    expect(parseSkippedVersion('   ')).toBeNull()
    expect(parseSkippedVersion(' 0.4.0 ')).toBe('0.4.0')
  })
})

describe('更新提示可见性', () => {
  it('有新版本且未被忽略时提示', () => {
    expect(hasPendingUpdate(snapshot(), null)).toBe(true)
    expect(hasPendingUpdate(snapshot(), '0.3.9')).toBe(true)
  })

  it('忽略过同一个版本、没有新版本或拿到空快照时不提示', () => {
    expect(hasPendingUpdate(snapshot(), '0.4.0')).toBe(false)
    expect(hasPendingUpdate(snapshot({ hasUpdate: false }), null)).toBe(false)
    expect(hasPendingUpdate(snapshot({ latest: null }), null)).toBe(false)
    expect(hasPendingUpdate(null, null)).toBe(false)
  })

  it('更新流程进行中 / 失败 / 完成时始终占位，不因忽略状态被藏掉', () => {
    for (const phase of ['updating', 'restarting', 'done', 'error'] as const) {
      expect(updateBannerVisible(snapshot(), '0.4.0', phase)).toBe(true)
    }
    expect(updateBannerVisible(snapshot(), '0.4.0', 'idle')).toBe(false)
    expect(updateBannerVisible(snapshot(), null, 'idle')).toBe(true)
  })
})