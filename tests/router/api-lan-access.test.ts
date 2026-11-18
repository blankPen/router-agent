/**
 * 端到端：从局域网地址访问面板。
 *
 * 监听 0.0.0.0 时，用本机的局域网 IP 请求应该和回环地址一样能通，
 * 但必须带令牌——内网穿透的流量也是从 127.0.0.1 进来的，不能按来源 IP 放行。
 */
import { describe, expect, it } from 'vitest'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { createApiServer } from '../../src/router/api.js'
import { defaultConfig, policyOf } from '../../src/config.js'

function lanAddress(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if ((entry.family === 'IPv4' || (entry.family as unknown as number) === 4) && !entry.internal) return entry.address
    }
  }
  return '127.0.0.1'
}

function call(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: lanAddress(), port, path, method: 'GET', headers }, res => {
      let data = ''
      res.on('data', chunk => { data += String(chunk) })
      res.on('end', () => {
        let json: any = null
        try { json = data ? JSON.parse(data) : null } catch { json = data }
        resolve({ status: res.statusCode ?? 0, json })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

describe('局域网访问面板', () => {
  it('监听 0.0.0.0 时，局域网地址带上令牌就能访问', async () => {
    const config = defaultConfig()
    config.server.host = '0.0.0.0'
    config.server.token = 'lan-secret-token'
    const store = new Store(':memory:')
    const engine = new Engine({ store, policy: policyOf(config), ids: { next: p => `${p}_1` } })
    const server = await createApiServer({ engine, store, config, port: 0 })
    const port = (server.server.address() as AddressInfo).port

    const denied = await call(port, '/api/status')
    expect(denied.status).toBe(401)

    const allowed = await call(port, '/api/status', { 'x-ra-token': 'lan-secret-token' })
    expect(allowed.status).toBe(200)

    await server.close()
  })
})
