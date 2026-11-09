export type ForgeKind = 'github' | 'gitlab' | 'other'

export interface GitRemote {
  /** 小写主机名（不含端口）。 */
  host: string
  /** 命名空间路径，已去掉首尾斜杠与 `.git` 后缀，例如 group/subgroup/repo。 */
  path: string
  forge: ForgeKind
}

/**
 * 按主机名判断代码托管平台。
 * 自建 GitLab 的域名不一定带 gitlab，调用方对 `other` 应按 GitLab 再试一次。
 */
export function forgeOfHost(host: string): ForgeKind {
  // 允许 host:port；端口不影响平台判断。
  const value = host.trim().toLowerCase().replace(/:\d+$/, '')
  if (!value) return 'other'
  if (value === 'github.com' || value === 'www.github.com') return 'github'
  if (value.includes('gitlab')) return 'gitlab'
  return 'other'
}

/**
 * 解析常见 git remote，保留 host，避免把 GitLab 的 group/repo 当成 GitHub 的 owner/repo。
 * 支持 git@host:path、ssh://git@host/path、https://host/path、git://host/path。
 */
export function parseGitRemote(remote: string): GitRemote | null {
  const value = remote.trim()
  if (!value) return null
  let host = ''
  let pathname = ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      // host 保留端口，自建 GitLab 可能挂在非标准端口上。
      host = url.host
      pathname = url.pathname
    } catch {
      return null
    }
  } else {
    const scp = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/)
    if (!scp) return null
    host = scp[1] ?? ''
    pathname = scp[2] ?? ''
  }
  const path = pathname
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
  if (!host || !path) return null
  return { host: host.toLowerCase(), path, forge: forgeOfHost(host) }
}

export interface GitlabMergeRequestRef {
  host: string
  /** 命名空间 + 项目路径，例如 group/subgroup/repo。 */
  path: string
  iid: number
  url: string
}

/** 识别 GitLab MR 链接：https://host/group[/sub]/repo/-/merge_requests/12。 */
export function parseGitlabMergeRequestUrl(value: string): GitlabMergeRequestRef | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const match = url.pathname.match(/^\/(.+)\/-\/merge_requests\/(\d+)\/?$/)
  if (!match) return null
  const path = match[1] ?? ''
  const iid = Number(match[2])
  if (!path || !Number.isFinite(iid) || iid <= 0) return null
  return { host: url.host.toLowerCase(), path, iid, url: trimmed }
}

export function isGitlabMergeRequestUrl(value: string): boolean {
  return parseGitlabMergeRequestUrl(value) !== null
}
