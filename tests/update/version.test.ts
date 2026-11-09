import { describe, expect, it } from 'vitest'
import { compareVersions, isNewer, parseVersion } from '../../src/update/version.js'

describe('版本号解析', () => {
  it('接受 v 前缀、预发布与构建元数据', () => {
    expect(parseVersion('v1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: [] })
    expect(parseVersion('0.4.0-beta.2')?.prerelease).toEqual(['beta', '2'])
    expect(parseVersion('1.0.0+build.5')?.prerelease).toEqual([])
  })

  it('拒绝缺段、非数字与空预发布标识', () => {
    for (const bad of ['', '0.3', 'abc', '1.2.x', '1.2.3-']) expect(parseVersion(bad)).toBeNull()
  })
})

describe('版本优先级', () => {
  it('按 major / minor / patch 逐段比较', () => {
    expect(compareVersions('0.3.0', '0.3.1')).toBe(-1)
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })

  it('预发布版低于同版本正式版', () => {
    expect(compareVersions('0.4.0-beta', '0.4.0')).toBe(-1)
    expect(compareVersions('0.4.0', '0.4.0-rc.1')).toBe(1)
  })

  it('预发布标识按 SemVer 规则排序', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1)
    expect(compareVersions('1.0.0-2', '1.0.0-alpha')).toBe(-1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
  })

  it('不合法版本返回 null', () => {
    expect(compareVersions('latest', '1.0.0')).toBeNull()
  })
})

describe('isNewer', () => {
  it('只有更高版本才算新版本', () => {
    expect(isNewer('0.4.0', '0.3.0')).toBe(true)
    expect(isNewer('0.3.0', '0.3.0')).toBe(false)
    expect(isNewer('0.2.9', '0.3.0')).toBe(false)
    expect(isNewer('not-a-version', '0.3.0')).toBe(false)
    expect(isNewer(null, '0.3.0')).toBe(false)
  })
})