/**
 * npm 包名校验。
 *
 * 面板只接受 npm 包名：本地路径、file: 协议一律不认，
 * 避免面板放行、服务端安装接口才拒绝。
 * 与 packages/infra/plugin-install.ts 的 npmPackageNameOf 保持同一口径。
 */
const NPM_PACKAGE_PATTERN = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i

/** 是合法 npm 包名就返回它，否则返回 undefined。 */
export function npmPackageOf(value: string): string | undefined {
  const text = value.trim()
  if (!text || text.startsWith('.') || text.startsWith('/') || text.startsWith('file:')) return undefined
  if (text.includes('\\') || /\s/.test(text)) return undefined
  return NPM_PACKAGE_PATTERN.test(text) ? text : undefined
}
