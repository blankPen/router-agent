/**
 * 面板地址的拼装：只本机时给回环地址，对外开放时列出局域网地址并带上令牌。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultConfig, loadConfig, writeConfig, type AppConfig } from '../../src/config.js'
import { ensureServerToken, panelUrlList, panelUrls } from '../../src/cli/panel-url.js'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'ra-home-panel-'))
}

describe('面板地址', () => {
  it('只监听本机时给回环地址，不带令牌', () => {
    const config = defaultConfig()
    expect(panelUrls(config, '#setup')).toEqual(['http://127.0.0.1:3083/#setup'])
  })

  it('对外开放时带上令牌，地址里含 token 参数', () => {
    const config = defaultConfig()
    config.server.host = '0.0.0.0'
    config.server.token = 'lan-token'
    const urls = panelUrls(config, '#setup')
    expect(urls.length).toBeGreaterThan(1)
    expect(urls.every(url => url.includes('token=lan-token'))).toBe(true)
    expect(urls.every(url => url.endsWith('#setup'))).toBe(true)
  })

  it('指定监听 IP 时只给这个地址与回环地址', () => {
    const config = defaultConfig()
    config.server.host = '192.168.31.121'
    config.server.token = 'lan-token'
    const urls = panelUrls(config)
    expect(urls).toContain('http://192.168.31.121:3083/?token=lan-token')
    expect(urls).toContain('http://127.0.0.1:3083/?token=lan-token')
  })

  it('对外开放且没配令牌时生成一个并落盘', () => {
    const dir = home()
    const config: AppConfig = loadConfig(dir)
    config.server.host = '0.0.0.0'
    const token = ensureServerToken(dir, config)
    expect(token).not.toBe('')
    expect(loadConfig(dir).server.token).toBe(token)
  })

  it('已经配过令牌时不会换掉', () => {
    const dir = home()
    const config: AppConfig = loadConfig(dir)
    config.server.host = '0.0.0.0'
    config.server.token = 'kept-token'
    writeConfig(dir, config)
    expect(ensureServerToken(dir, loadConfig(dir))).toBe('kept-token')
    expect(loadConfig(dir).server.token).toBe('kept-token')
  })

  it('只监听本机时不生成令牌', () => {
    const dir = home()
    const config: AppConfig = loadConfig(dir)
    expect(ensureServerToken(dir, config)).toBe('')
    expect(loadConfig(dir).server.token).toBe('')
  })

  it('panelUrlList 会先把令牌准备好再给地址', () => {
    const dir = home()
    const config: AppConfig = loadConfig(dir)
    config.server.host = '0.0.0.0'
    const urls = panelUrlList(dir, config, '#setup')
    expect(urls[0]).toContain('token=')
  })
})
