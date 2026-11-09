import { describe, expect, it } from 'vitest'
import { hashForTab, tabFromHash } from '../../src/web/client/tabs.js'

describe('面板页签 hash', () => {
  it('识别已知页签', () => {
    expect(tabFromHash('#setup')).toBe('setup')
    expect(tabFromHash('#logs')).toBe('logs')
    expect(tabFromHash('tickets')).toBe('tickets')
  })

  it('忽略未知值与空 hash，交给调用方回退默认页', () => {
    expect(tabFromHash('')).toBeNull()
    expect(tabFromHash('#')).toBeNull()
    expect(tabFromHash('#nope')).toBeNull()
  })

  it('页签与 hash 一一对应', () => {
    expect(hashForTab('setup')).toBe('#setup')
    expect(hashForTab('sources')).toBe('#sources')
  })
})