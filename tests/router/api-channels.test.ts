import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { createApiServer, type ApiServer } from '../../src/router/api.js'
import { defaultConfig, policyOf, type AppConfig } from '../../src/config.js'
import { ChannelRegistry } from '#channel/registry.js'
import type { ChannelAdapter, ChannelCapabilities } from '#channel/port.js'

function call(server: ApiServer, method: string, path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const address = server.server.address() as AddressInfo
    const req = request({ host: '127.0.0.1', port: address.port, path, method }, res => {
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

const CAPABILITIES: ChannelCapabilities = {
  threadReply: true,
  ack: true,
  richText: true,
  documents: true,
  directory: true,
  attachmentsIn: true,
  attachmentsOut: false,
  idempotency: true,
  maxTextLength: 3500,
  directMessage: true,
}

/** 只实现内核要求的最小适配器：面板只关心 id / kind / 能力。 */
function fakeAdapter(id: string, kind: string): ChannelAdapter {
  return {
    id,
    kind,
    capabilities: CAPABILITIES,
    normalize: () => ({}),
    send: async () => ({}),
  }
}

describe('渠道注册表接口', () => {
  let store: Store
  let engine: Engine
  let server: ApiServer
  let config: AppConfig
  let events: { event: string; [key: string]: unknown }[]

  beforeEach(async () => {
    store = new Store(':memory:')
    config = defaultConfig()
    let n = 0
    engine = new Engine({ store, policy: policyOf(config), clock: { now: () => '2026-11-12T10:00:00.000Z' }, ids: { next: p => `${p}_${++n}` } })
    events = []
  })

  afterEach(async () => {
    await server?.close()
    store.close()
  })

  it('列出内核已注册的渠道实例', async () => {
    const channels = new ChannelRegistry()
    channels.register(fakeAdapter('feishu', 'feishu'))
    channels.register(fakeAdapter('slack', 'slack'))
    server = await createApiServer({ engine, store, config, channels, onEvent: event => events.push(event) })

    const res = await call(server, 'GET', '/api/channels')
    expect(res.status).toBe(200)
    expect(res.json.channels.map((item: { id: string }) => item.id)).toEqual(['feishu', 'slack'])
    expect(res.json.channels[0].kind).toBe('feishu')
    expect(res.json.channels[0].capabilities.threadReply).toBe(true)
    expect(events.some(event => event.event === 'api:channels')).toBe(true)
  })

  it('没有注入注册表时返回空列表，不报错', async () => {
    server = await createApiServer({ engine, store, config })
    const res = await call(server, 'GET', '/api/channels')
    expect(res.status).toBe(200)
    expect(res.json.channels).toEqual([])
  })

  it('配置快照带上热配置路径，面板据此标注立即生效', async () => {
    server = await createApiServer({ engine, store, config })
    const res = await call(server, 'GET', '/api/config')
    expect(res.status).toBe(200)
    expect(res.json.hotPaths).toContain('policy.')
    expect(res.json.hotPaths).toContain('feishu.allowed')
  })
})
