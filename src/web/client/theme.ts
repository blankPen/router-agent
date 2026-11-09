/**
 * 面板主题：跟随系统 / 亮色 / 暗色。
 *
 * 用户的选择存 localStorage；首帧由 index.html 的内联脚本提前写到
 * `<html data-theme>`，避免深色用户刷新时先闪一帧白底。CSS 只认这个属性，
 * `system` 不单独占一个属性值——它只是「没有显式选择」时的默认来源。
 */

export const THEME_STORAGE_KEY = 'ra.theme'

export const THEME_MODES = ['system', 'light', 'dark'] as const

export type ThemeMode = typeof THEME_MODES[number]

export type ResolvedTheme = 'light' | 'dark'

/** 存量值不认识（脏数据、旧版本）时回退「跟随系统」，不把非法值当选择。 */
export function parseThemeMode(raw: string | null | undefined): ThemeMode {
  return (THEME_MODES as readonly string[]).includes(raw ?? '') ? raw as ThemeMode : 'system'
}

/**
 * 点击主题图标的循环顺序。
 *
 * 跟随系统时先切到「与当前观感相反」的一档，保证第一次点击一定能看到变化；
 * 之后在亮 / 暗之间往返，再点一下回到跟随系统。
 */
export function nextThemeMode(mode: ThemeMode, systemPrefersDark: boolean): ThemeMode {
  if (mode === 'light') return 'dark'
  if (mode === 'dark') return 'system'
  return systemPrefersDark ? 'light' : 'dark'
}

/** 跟随系统时取系统偏好，显式选择时以选择为准。 */
export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'light') return 'light'
  if (mode === 'dark') return 'dark'
  return systemPrefersDark ? 'dark' : 'light'
}

export function themeModeLabel(mode: ThemeMode): string {
  if (mode === 'light') return '亮色'
  if (mode === 'dark') return '暗色'
  return '跟随系统'
}

/** 图标按「选择」而不是按当前观感走：跟随系统用显示器，显式选择用太阳 / 月亮。 */
export function themeModeIcon(mode: ThemeMode): 'sun' | 'moon' | 'monitor' {
  if (mode === 'light') return 'sun'
  if (mode === 'dark') return 'moon'
  return 'monitor'
}

function storageOrNull(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // 某些浏览器在禁用存储时连访问 localStorage 都会抛错。
    return null
  }
}

/** 读取上次选择；读不到或读失败都按「跟随系统」处理。 */
export function readStoredThemeMode(
  storage?: Pick<Storage, 'getItem'> | null,
): ThemeMode {
  const target = storage ?? storageOrNull()
  if (!target) return 'system'
  try {
    return parseThemeMode(target.getItem(THEME_STORAGE_KEY))
  } catch {
    return 'system'
  }
}

/** 记住选择；写失败（隐私模式、配额满）只影响下次打开，不影响本次切换。 */
export function storeThemeMode(
  mode: ThemeMode,
  storage?: Pick<Storage, 'setItem'> | null,
): void {
  const target = storage ?? storageOrNull()
  if (!target) return
  try {
    target.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    // 忽略：本次切换已经在页面上生效。
  }
}

/** 把解析后的主题写到 `<html data-theme>`，CSS 的深色变量挂在这个属性上。 */
export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme
}