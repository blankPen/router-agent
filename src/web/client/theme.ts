/**
 * 面板主题：亮色 / 暗色 / 跟随系统（默认）。
 *
 * 三态统一由 `<html data-theme="light|dark">` 驱动：CSS 只认这个属性，
 * 跟随系统时由这里把 `prefers-color-scheme` 解析成具体明暗，再监听系统变化。
 * 选择只存在浏览器 localStorage，不写入服务端配置。
 */
import { useCallback, useEffect, useState } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

/** 与 `src/web/index.html` 首屏内联脚本保持一致，改名要两处一起改。 */
export const THEME_STORAGE_KEY = 'router-agent.theme'

export const THEME_MODE_LABEL: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '亮色',
  dark: '暗色',
}

/** 把任意存储值收敛成合法主题；不认识的值（含 null）回退为跟随系统。 */
export function parseThemeMode(raw: unknown): ThemeMode {
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}

/** 跟随系统时按系统偏好解析，显式主题直接用自身。 */
export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  if (mode === 'system') return systemDark ? 'dark' : 'light'
  return mode
}

/**
 * 三态循环：跟随系统 → 与系统相反的显式主题 → 与系统相同的显式主题 → 跟随系统。
 *
 * 这样从默认态点第一下就能看到明暗变化；之后在两种显式主题之间来回切换，
 * 最后一步回到跟随系统（若系统主题恰好等于当前显式主题，画面不变但状态回到自动）。
 */
export function nextThemeMode(mode: ThemeMode, systemDark: boolean): ThemeMode {
  const systemTheme: ResolvedTheme = systemDark ? 'dark' : 'light'
  if (mode === 'system') return systemDark ? 'light' : 'dark'
  if (mode === systemTheme) return 'system'
  return systemTheme
}

/** 浏览器当前的系统深色偏好；非浏览器环境回退为亮色。 */
export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false
}

/** 只写 `data-theme`，让 CSS 变量切换；重复写同一个值没有副作用。 */
export function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = resolved
}

export function readStoredThemeMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system'
  try {
    return parseThemeMode(window.localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return 'system'
  }
}

export function writeStoredThemeMode(mode: ThemeMode): void {
  if (typeof window === 'undefined') return
  try {
    // 跟随系统不落存储：下次打开仍按系统偏好走，而不是记住某次的解析结果。
    if (mode === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY)
    else window.localStorage.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    // 无痕模式 / 禁用存储时写不进去，只影响本次会话，不阻断切换。
  }
}

export interface ThemeController {
  mode: ThemeMode
  resolved: ResolvedTheme
  systemDark: boolean
  setMode: (mode: ThemeMode) => void
}

/** 面板全局主题状态：初始化读本地存储，跟随系统时同步响应系统主题变化。 */
export function useThemeMode(): ThemeController {
  const [mode, setModeState] = useState<ThemeMode>(readStoredThemeMode)
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches)
    media.addEventListener('change', onChange)
    // 首帧之后系统偏好也可能已经被改过，挂监听时顺手对齐一次。
    setSystemDark(media.matches)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const resolved = resolveTheme(mode, systemDark)

  useEffect(() => {
    applyTheme(resolved)
  }, [resolved])

  const setMode = useCallback((next: ThemeMode): void => {
    writeStoredThemeMode(next)
    setModeState(next)
  }, [])

  return { mode, resolved, systemDark, setMode }
}
