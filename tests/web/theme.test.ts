import { describe, expect, it } from 'vitest'
import {
  nextThemeMode,
  parseThemeMode,
  resolveTheme,
  type ThemeMode,
} from '../../src/web/client/theme.js'

describe('面板主题解析', () => {
  it('只接受 light / dark / system，其余（含 null）回退跟随系统', () => {
    expect(parseThemeMode('light')).toBe('light')
    expect(parseThemeMode('dark')).toBe('dark')
    expect(parseThemeMode('system')).toBe('system')
    expect(parseThemeMode(null)).toBe('system')
    expect(parseThemeMode(undefined)).toBe('system')
    expect(parseThemeMode('auto')).toBe('system')
  })

  it('跟随系统时按系统偏好解析，显式主题保持自身', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})

describe('主题三态循环', () => {
  const cycle = (start: ThemeMode, systemDark: boolean, steps: number): ThemeMode[] => {
    const seen: ThemeMode[] = [start]
    let mode = start
    for (let index = 0; index < steps; index += 1) {
      mode = nextThemeMode(mode, systemDark)
      seen.push(mode)
    }
    return seen
  }

  it('系统为亮色时：跟随系统 → 暗色 → 亮色 → 跟随系统', () => {
    expect(cycle('system', false, 3)).toEqual(['system', 'dark', 'light', 'system'])
  })

  it('系统为暗色时：跟随系统 → 亮色 → 暗色 → 跟随系统', () => {
    expect(cycle('system', true, 3)).toEqual(['system', 'light', 'dark', 'system'])
  })

  it('从默认（跟随系统）点第一下，画面明暗一定反转', () => {
    expect(resolveTheme(nextThemeMode('system', false), false)).toBe('dark')
    expect(resolveTheme(nextThemeMode('system', true), true)).toBe('light')
  })
})
