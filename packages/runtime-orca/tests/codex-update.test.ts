import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexVersionCachePath, dismissCodexUpdatePrompt } from '@router-agent/runtime-orca'

function codexHome(): string {
  return mkdtempSync(join(tmpdir(), 'ra-codex-home-'))
}

describe('Codex 版本更新提示', () => {
  it('把当前最新版本记成已忽略，等价于用户选「Skip until next version」', () => {
    const home = codexHome()
    const path = join(home, 'version.json')
    writeFileSync(path, JSON.stringify({ latest_version: '0.167.2', last_checked_at: '2026-11-12T08:41:06.242779Z' }))

    const result = dismissCodexUpdatePrompt({ CODEX_HOME: home })

    expect(result).toMatchObject({ status: 'dismissed', latestVersion: '0.167.2', path })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      latest_version: '0.167.2',
      dismissed_version: '0.167.2',
    })
  })

  it('已经忽略过这一版就不再改文件', () => {
    const home = codexHome()
    const path = join(home, 'version.json')
    const content = JSON.stringify({ latest_version: '0.167.2', dismissed_version: '0.167.2' })
    writeFileSync(path, content)

    const result = dismissCodexUpdatePrompt({ CODEX_HOME: home })

    expect(result.status).toBe('already-dismissed')
    expect(readFileSync(path, 'utf8')).toBe(content)
  })

  it('没有版本缓存时不造文件：不知道最新版本，写进去只会是猜的值', () => {
    const home = codexHome()

    const result = dismissCodexUpdatePrompt({ CODEX_HOME: home })

    expect(result.status).toBe('no-cache')
    expect(existsSync(join(home, 'version.json'))).toBe(false)
  })

  it('缓存损坏时报告原因，不覆盖用户的文件', () => {
    const home = codexHome()
    const path = join(home, 'version.json')
    writeFileSync(path, '{ broken')

    const result = dismissCodexUpdatePrompt({ CODEX_HOME: home })

    expect(result.status).toBe('failed')
    expect(result.reason).toContain('Codex 版本缓存读取失败')
    expect(readFileSync(path, 'utf8')).toBe('{ broken')
  })

  it('版本缓存路径跟随 CODEX_HOME，缺省落在 HOME 下', () => {
    expect(codexVersionCachePath({ CODEX_HOME: '/tmp/codex-home' })).toBe('/tmp/codex-home/version.json')
    expect(codexVersionCachePath({ HOME: '/tmp/me' })).toBe('/tmp/me/.codex/version.json')
  })
})
