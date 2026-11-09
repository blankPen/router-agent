/**
 * 版本号解析与比较：判定 npm 上的最新版是否比当前运行版本新。
 *
 * 不引入 semver 依赖（只做「谁更新」这一个判断），但按 SemVer 2.0 的优先级规则实现，
 * 覆盖预发布版（`0.4.0-beta.2`）与构建元数据（`+sha`），避免把 beta 当成正式版。
 */

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** 预发布标识；空数组表示正式版。 */
  prerelease: string[]
}

/** 解析 `v1.2.3` / `1.2.3-beta.1` / `1.2.3+build`；不合法返回 null。 */
export function parseVersion(raw: string): ParsedVersion | null {
  const text = String(raw ?? '').trim()
  // 构建元数据（+ 之后）不参与优先级比较，解析时直接丢掉。
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text)
  if (!match) return null
  const prerelease = match[4] ? match[4].split('.') : []
  if (prerelease.some(item => item === '')) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  }
}

function comparePrerelease(a: string[], b: string[]): number {
  // 正式版（无预发布标识）优先级高于同版本的预发布版。
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index]!
    const right = b[index]!
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      const diff = Number(left) - Number(right)
      if (diff !== 0) return diff < 0 ? -1 : 1
      continue
    }
    // 数字标识优先级低于字母数字标识（SemVer 规则）。
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    if (left !== right) return left < right ? -1 : 1
  }
  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

/** `a` 小于 `b` 返回 -1，相等返回 0，大于返回 1；任一侧不合法返回 null。 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

/** `latest` 是否是比 `current` 更高的版本；不合法或同版本都返回 false。 */
export function isNewer(latest: string | null | undefined, current: string): boolean {
  if (!latest) return false
  return compareVersions(latest, current) === 1
}