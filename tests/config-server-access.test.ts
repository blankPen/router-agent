/**
 * 面板对外访问的配置口径：监听地址 + 访问令牌。
 *
 * 默认仍只监听 127.0.0.1；改成 0.0.0.0 / 局域网 IP 后，非本机请求必须带令牌。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyConfigPatch,
  defaultConfig,
  ensureHome,
  loadConfig,
  publicConfig,
  setConfigValue,
  writeConfig,
} from '../src/config.js'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'ra-home-net-'))
}

describe('面板监听地址与访问令牌', () => {
  it('默认只监听 127.0.0.1，不带令牌', () => {
    const cfg = loadConfig(home())
    expect(cfg.server.host).toBe('127.0.0.1')
    expect(cfg.server.token).toBe('')
  })

  it('host 可配置为 0.0.0.0 并落盘', () => {
    const dir = home()
    ensureHome(dir)
    writeFileSync(join(dir, 'config.yaml'), ['server:', '  host: 0.0.0.0', '  port: 3083'].join('\n'))
    expect(loadConfig(dir).server.host).toBe('0.0.0.0')

    const cfg = loadConfig(home())
    expect(setConfigValue(cfg, 'server.host', '0.0.0.0')).toBe(true)
    expect(cfg.server.host).toBe('0.0.0.0')
    writeConfig(dir, cfg)
    expect(loadConfig(dir).server.host).toBe('0.0.0.0')
  })

  it('host 非法时回退到 127.0.0.1 而不是崩溃', () => {
    const dir = home()
    ensureHome(dir)
    writeFileSync(join(dir, 'config.yaml'), ['server:', '  host: "not a host"'].join('\n'))
    expect(loadConfig(dir).server.host).toBe('127.0.0.1')
  })

  it('面板可以写入令牌，落盘后不下发明文', () => {
    const dir = home()
    ensureHome(dir)
    const cfg = defaultConfig()
    const result = applyConfigPatch(cfg, { 'server.token': 'lan-secret-token' })
    expect(result.errors).toEqual([])
    expect(result.changed).toEqual(['server.token'])
    expect(cfg.server.token).toBe('lan-secret-token')

    const published = publicConfig(cfg) as { server: Record<string, unknown> }
    expect(published.server.token).toBeUndefined()
    expect(published.server.tokenSet).toBe(true)
    expect(JSON.stringify(published)).not.toContain('lan-secret-token')

    writeConfig(dir, cfg)
    expect(loadConfig(dir).server.token).toBe('lan-secret-token')
  })

  it('回传空令牌表示保持原值，没有令牌时拒绝空串', () => {
    const cfg = defaultConfig()
    // 还没配过令牌：空串没有意义，直接拒绝。
    expect(applyConfigPatch(cfg, { 'server.token': '' }).errors).toHaveLength(1)
    expect(applyConfigPatch(cfg, { 'server.token': 123 }).errors).toHaveLength(1)

    cfg.server.token = 'kept-token'
    const kept = applyConfigPatch(cfg, { 'server.token': '' })
    expect(kept.errors).toEqual([])
    expect(kept.changed).toEqual([])
    expect(cfg.server.token).toBe('kept-token')
  })
})
