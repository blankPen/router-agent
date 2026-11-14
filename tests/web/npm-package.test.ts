import { describe, expect, it } from 'vitest'
import { npmPackageOf } from '../../src/web/client/npm-package.js'

describe('面板 npm 包名校验', () => {
  it('裸包名与 scope 包名都认，返回去掉空白的原名', () => {
    expect(npmPackageOf('my-event-source')).toBe('my-event-source')
    expect(npmPackageOf('@acme/event-source')).toBe('@acme/event-source')
    expect(npmPackageOf('  @acme/event-source  ')).toBe('@acme/event-source')
  })

  it('本地路径与 file: 协议都不认，面板只放行 npm 包', () => {
    expect(npmPackageOf('./local/event-x')).toBeUndefined()
    expect(npmPackageOf('/tmp/event-x')).toBeUndefined()
    expect(npmPackageOf('file:///tmp/event-x')).toBeUndefined()
  })

  it('空串与带空白的串都不是包名', () => {
    expect(npmPackageOf('')).toBeUndefined()
    expect(npmPackageOf('   ')).toBeUndefined()
    expect(npmPackageOf('my event source')).toBeUndefined()
  })
})
