/**
 * 面板访问令牌的存取。
 *
 * 面板开放到局域网时，服务端要求每个 API 请求带 `x-ra-token`。
 * 令牌来自打开面板的地址栏（`?token=...`），存进 sessionStorage 后随请求发出。
 */

const STORAGE_KEY = 'router-agent.token'
const PARAM = 'token'

/**
 * 从地址栏取令牌：取到就把参数从 URL 上摘掉。
 *
 * 摘掉是为了不让明文令牌留在地址栏、浏览器历史与 referer 里。
 */
export function takeTokenFromUrl(href: string): { token: string; url: string } {
  const url = new URL(href)
  const token = url.searchParams.get(PARAM)
  if (!token) return { token: '', url: href }
  url.searchParams.delete(PARAM)
  return { token, url: url.toString() }
}

/** 记住令牌；只在当前标签页有效，不写进长期存储。 */
export function setToken(token: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, token)
  } catch {
    // 隐私模式下没有 sessionStorage：令牌退化成「每次从地址栏取」，不影响本机使用。
  }
}

/** 当前令牌；没有就是空串（说明服务端没开鉴权）。 */
export function getToken(): string {
  // 首次打开面板时地址栏里就有令牌，而 React 的子组件 effect 可能先于父组件跑：
  // 这里直接兜住 URL 里的令牌，避免第一轮请求因为拿不到令牌而被拒。
  const fromUrl = takeTokenFromUrl(window.location.href).token
  if (fromUrl) return fromUrl
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

/** 请求头：服务端开了鉴权时带上令牌。 */
export function tokenHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { 'x-ra-token': token } : {}
}

/** 面板启动时调用：从地址栏取令牌并记住，随后把地址栏里的明文抹掉。 */
export function captureTokenFromUrl(): void {
  const { token, url } = takeTokenFromUrl(window.location.href)
  if (!token) return
  setToken(token)
  window.history.replaceState(null, '', url)
}
