import { describe, expect, it } from 'vitest'
import {
  THEME_STORAGE_KEY,
  nextThemeMode,
  parseThemeMode,
  readStoredThemeMode,
  resolveTheme,
  storeThemeMode,
  themeModeIcon,
  themeModeLabel,
} from '../../src/web/client/theme.js'

function reader(value: string | null): Pick<Storage, 'getItem'> {
  return { getItem: (key: string) => key === THEME_STORAGE_KEY ? value : null }
}

describe('面板主题选择', () => {
  it('只认 system / light / dark，其它值回退跟随系统', () => {
    expect(parseThemeMode('system')).toBe('system')
    expect(parseThemeMode('light')).toBe('light')
    expect(parseThemeMode('dark')).toBe('dark')
    for (const raw of [null, undefined, '', 'Dark', 'auto', 'dark ']) {
      expect(parseThemeMode(raw)).toBe('system')
    }
  })

  it('跟随系统时首次点击切到与当前观感相反的一档，保证看得到变化', () => {
    expect(nextThemeMode('system', true)).toBe('light')
    expect(nextThemeMode('system', false)).toBe('dark')
  })

  it('亮 / 暗之间往返，再点回到跟随系统', () => {
    expect(nextThemeMode('light', true)).toBe('dark')
    expect(nextThemeMode('light', false)).toBe('dark')
    expect(nextThemeMode('dark', true)).toBe('system')
    expect(nextThemeMode('dark', false)).toBe('system')
  })

  it('解析主题：显式选择优先，否则取系统偏好', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('文案与图标按选择走，跟随系统显示显示器图标', () => {
    expect(themeModeLabel('system')).toBe('跟随系统')
    expect(themeModeLabel('light')).toBe('亮色')
    expect(themeModeLabel('dark')).toBe('暗色')
    expect(themeModeIcon('system')).toBe('monitor')
    expect(themeModeIcon('light')).toBe('sun')
    expect(themeModeIcon('dark')).toBe('moon')
  })
})

describe('主题选择的存取', () => {
  it('读到合法值就用，读不到或非法都按跟随系统', () => {
    expect(readStoredThemeMode(reader('dark'))).toBe('dark')
    expect(readStoredThemeMode(reader(null))).toBe('system')
    expect(readStoredThemeMode(reader('neon'))).toBe('system')
  })

  it('存储不可用时不影响调用方', () => {
    const broken: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    }
    expect(readStoredThemeMode(broken)).toBe('system')
    expect(() => storeThemeMode('dark', broken)).not.toThrow()
    expect(readStoredThemeMode(null)).toBe('system')
  })

  it('写入固定的存储键，供首帧内联脚本复用', () => {
    const writes: Array<[string, string]> = []
    const storage: Pick<Storage, 'setItem'> = {
      setItem: (key, value) => { writes.push([key, value]) },
    }
    storeThemeMode('light', storage)
    expect(writes).toEqual([[THEME_STORAGE_KEY, 'light']])
    expect(THEME_STORAGE_KEY).toBe('ra.theme')
  })
})