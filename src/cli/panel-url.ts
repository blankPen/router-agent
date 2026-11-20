/**
 * 面板访问地址的拼装。
 *
 * 只监听回环地址时给本机地址；对外开放时列出本机所有 IPv4，
 * 并把访问令牌带上——面板前端从地址栏取到令牌后放进请求头。
 */
import { networkInterfaces } from 'node:os'
import { generateServerToken, isLoopbackHost, writeConfig, type AppConfig } from '../config.js'

/** 本机的局域网 IPv4（跳过回环与内部网卡）。 */
export function lanAddresses(): string[] {
  const out: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      out.push(entry.address)
    }
  }
  return out
}

/**
 * 面板地址列表；`hash` 是要打开的页签（如 `#setup`）。
 *
 * 令牌以查询参数带上：面板前端从地址栏取走令牌存进 sessionStorage，
 * 随后把地址栏里的明文抹掉，之后的请求自动带上 x-ra-token。
 */
export function panelUrls(config: AppConfig, hash = ''): string[] {
  const { host, port, token } = config.server
  const query = token ? `?token=${encodeURIComponent(token)}` : ''
  if (isLoopbackHost(host)) return [`http://127.0.0.1:${port}/${query}${hash}`]
  const hosts = host === '0.0.0.0' ? lanAddresses() : [host]
  // 本机地址也留着：自己在机器上调试时用回环地址更快。
  return [...hosts, '127.0.0.1'].map(address => `http://${address}:${port}/${query}${hash}`)
}

/**
 * 保证对外开放时一定有令牌，并把它落盘。
 *
 * 开着口子的面板必须带令牌，否则同一局域网里的任何人都能改配置、停工单。
 * 令牌必须持久化：每次启动换一个的话，已经发出去的地址会突然失效。
 */
export function ensureServerToken(home: string, config: AppConfig): string {
  if (!isLoopbackHost(config.server.host) && !config.server.token) {
    config.server.token = generateServerToken()
    writeConfig(home, config)
  }
  return config.server.token
}

/** 面板地址列表；对外开放时先确保有令牌。 */
export function panelUrlList(home: string, config: AppConfig, hash = ''): string[] {
  ensureServerToken(home, config)
  return panelUrls(config, hash)
}

/** CLI 自己请求面板 API 时带的鉴权头。 */
export function tokenHeader(config: AppConfig): Record<string, string> {
  return config.server.token ? { 'x-ra-token': config.server.token } : {}
}
