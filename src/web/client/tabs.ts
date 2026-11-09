/**
 * 面板页签与 URL hash 的映射。
 *
 * `ra start` 会把浏览器打开到 `#setup`，刷新页面时也靠 hash 保持当前页签。
 */
export const TABS = ['setup', 'tickets', 'logs', 'config', 'sources'] as const

export type Tab = typeof TABS[number]

/** 从 hash 解析页签；不认识的值返回 null，由调用方回退默认页。 */
export function tabFromHash(hash: string): Tab | null {
  const value = hash.replace(/^#/, '').trim()
  return (TABS as readonly string[]).includes(value) ? value as Tab : null
}

/** 页签对应的 hash（始终带 `#`）。 */
export function hashForTab(tab: Tab): string {
  return `#${tab}`
}