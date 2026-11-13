import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PUBLISH_ORDER,
  assertPublisher,
  assertPackable,
  scopeDiagnostic,
  publishMode,
  syncManifest,
  syncRootDependencies,
  undeclaredDependencies,
} from '../../scripts/publish-packages.mjs'

describe('多包发布', () => {
  it('SDK 先于插件，插件先于根包', () => {
    expect(PUBLISH_ORDER.indexOf('core')).toBeLessThan(PUBLISH_ORDER.indexOf('runtime'))
    expect(PUBLISH_ORDER.indexOf('runtime')).toBeLessThan(PUBLISH_ORDER.indexOf('runtime-orca'))
    expect(PUBLISH_ORDER.indexOf('channel')).toBeLessThan(PUBLISH_ORDER.indexOf('channel-feishu'))
    // ACP 依赖 Codex / Herdr 的探测实现，必须排在这两个包之后。
    expect(PUBLISH_ORDER.indexOf('runtime-codex')).toBeLessThan(PUBLISH_ORDER.indexOf('runtime-acp'))
    expect(PUBLISH_ORDER.indexOf('runtime-herdr')).toBeLessThan(PUBLISH_ORDER.indexOf('runtime-acp'))
    expect(PUBLISH_ORDER).toContain('runtime-acp')
    // ACP 复用了 T3 的服务端探测实现，必须排在它之后。
    expect(PUBLISH_ORDER.indexOf('runtime-t3code')).toBeLessThan(PUBLISH_ORDER.indexOf('runtime-acp'))
    expect(PUBLISH_ORDER).toContain('runtime-t3code')
  })

  it('sync 模式只同步版本号，不会落到发布循环', () => {
    expect(publishMode(['--sync'])).toBe('sync')
    expect(publishMode(['--dry-run'])).toBe('dry-run')
    expect(publishMode([])).toBe('publish')
  })

  it('同步版本时只改内部包依赖，不动第三方依赖', () => {
    const pkg = {
      name: '@router-agent/runtime-orca',
      version: '0.0.0',
      dependencies: {
        '@router-agent/runtime': '0.0.0',
        'some-third-party': '^1.2.3',
      },
    }
    const next = syncManifest(pkg, '0.3.31')
    expect(next.version).toBe('0.3.31')
    expect(next.dependencies['@router-agent/runtime']).toBe('0.3.31')
    expect(next.dependencies['some-third-party']).toBe('^1.2.3')
  })

  it('根包依赖同步只覆盖内置插件，用户扩展包不动', () => {
    const pkg = {
      dependencies: {
        '@router-agent/runtime-orca': '0.0.0',
        '@someone/custom-runtime': '^1.0.0',
      },
    }
    const next = syncRootDependencies(pkg, '0.3.31')
    expect(next.dependencies['@router-agent/runtime-orca']).toBe('0.3.31')
    expect(next.dependencies['@someone/custom-runtime']).toBe('^1.0.0')
  })

  it('E404 诊断提示 token 权限与包作用域，而不是只说 Not Found', () => {
    const message = scopeDiagnostic(
      '@router-agent/runtime-orca',
      '{"error":{"code":"E404","summary":"Not Found"}}',
      'npm error 404 Not Found',
    )
    expect(message).toContain('NPM_TOKEN')
    expect(message).toContain('@router-agent/*')
    expect(message).toContain('Read and write')
  })

  it('token 用户不是根包维护者时，在发布前给出 E404 解释', () => {
    expect(() => assertPublisher('router-agent', 'someone', 'pengzhen <529629354@qq.com>'))
      .toThrow(/不是 router-agent 的维护者/)
  })

  it('维护者账号通过发布前校验', () => {
    expect(assertPublisher('router-agent', 'pengzhen', 'pengzhen <529629354@qq.com>')).toBe('pengzhen')
  })

  it('缺少 repository 的包不能发布，避免 provenance 关联不到源码', () => {
    expect(() => assertPackable('runtime-orca', {
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    })).toThrow(/repository/)
  })

  it('每个内置插件包都声明了源码用到的第三方依赖', () => {
    for (const name of PUBLISH_ORDER) {
      expect(undeclaredDependencies(fileURLToPath(new URL(`../../packages/${name}/`, import.meta.url)))).toEqual([])
    }
  })
})
