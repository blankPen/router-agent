/**
 * 面板就绪探测：开放访问时也要带令牌。
 *
 * 监听 0.0.0.0 时服务端要求每个 API 请求带 x-ra-token，
 * 探测请求漏带令牌就会被 401 拒掉，ra start 只会一直说「面板暂未就绪」。
 */
import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { panelReady } from '../src/cli/index.js'

const TOKEN = 'lan-secret-token'

/** 起一个按令牌放行的最小面板服务，记录收到的请求头。 */
async function stubPanel(): Promise<{ server: Server; port: number; seen: Array<string | undefined> }> {
  const seen: Array<string | undefined> = []
  const server = createServer((req, res) => {
    seen.push(req.headers['x-ra-token'] as string | undefined)
    if (req.headers['x-ra-token'] !== TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'token-required' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port, seen }
}

describe('面板就绪探测', () => {
  it('开放访问时探测请求带上访问令牌，服务就绪被正确识别', async () => {
    const { server, port, seen } = await stubPanel()
    try {
      // 面板地址栏里带的是 ?token=…，探测时必须转成请求头。
      const panelUrl = `http://127.0.0.1:${port}/?token=${TOKEN}#setup`
      expect(await panelReady(panelUrl)).toBe(true)
      expect(seen[0]).toBe(TOKEN)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('探测失败时不抛异常，返回未就绪', async () => {
    expect(await panelReady('http://127.0.0.1:1/?token=x#setup')).toBe(false)
  })
})
