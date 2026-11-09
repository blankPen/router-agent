/**
 * 面板「版本更新」提示：快照类型、忽略版本的本地存储与展示判断。
 *
 * 提示只在「有新版本且未被忽略」时出现；忽略状态留在浏览器 localStorage，
 * 换到更高版本后会再次提示，不需要用户手动清理。
 */

export type UpdatePhase = 'idle' | 'checking' | 'upgrading' | 'updated' | 'failed'

/** 与服务端 `/api/update` 返回保持一致。 */
export interface UpdateSnapshot {
  current: string
  latest: string | null
  installedVersion: string | null
  hasUpdate: boolean
  checkedAt: string | null
  phase: UpdatePhase
  error: string | null
  message: string | null
}

export const UPDATE_SKIPPED_KEY = 'router-agent.updateSkipped'

/** 空字符串 / 纯空白视为「没有忽略任何版本」。 */
export function parseSkippedVersion(raw: string | null | undefined): string | null {
  const value = raw?.trim()
  return value ? value : null
}

export function readSkippedVersion(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return parseSkippedVersion(window.localStorage.getItem(UPDATE_SKIPPED_KEY))
  } catch {
    return null
  }
}

export function writeSkippedVersion(version: string | null): void {
  if (typeof window === 'undefined') return
  try {
    if (version) window.localStorage.setItem(UPDATE_SKIPPED_KEY, version)
    else window.localStorage.removeItem(UPDATE_SKIPPED_KEY)
  } catch {
    // 无痕模式 / 禁用存储时写不进去，只影响本次会话，不阻断更新。
  }
}

/** 是否值得展示更新提示；忽略过同一个版本就不再打扰。 */
export function hasPendingUpdate(snapshot: UpdateSnapshot | null, skippedVersion: string | null): boolean {
  return Boolean(snapshot?.hasUpdate && snapshot.latest && snapshot.latest !== parseSkippedVersion(skippedVersion))
}

/** 面板里本地推进的阶段：比服务端多一层「重启中 / 已重启」。 */
export type UpdateRunPhase = 'idle' | 'updating' | 'restarting' | 'done' | 'error'

export function updateBannerVisible(
  snapshot: UpdateSnapshot | null,
  skippedVersion: string | null,
  phase: UpdateRunPhase,
): boolean {
  if (phase !== 'idle') return true
  return hasPendingUpdate(snapshot, skippedVersion)
}