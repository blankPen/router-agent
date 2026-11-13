import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Logger } from '#infra/logger.js'
import {
  installPluginPackage,
  installedPluginVersion,
  npmPackageNameOf,
  type NpmRunner,
} from '#infra/plugin-install.js'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'ra-plugin-install-'))
}

function loggerSink(): { logger: Logger; events: Array<{ message: string; fields?: Record<string, unknown> }> } {
  const events: Array<{ message: string; fields?: Record<string, unknown> }> = []
  const logger: Logger = {
    info: (message, fields) => { events.push({ message, ...(fields ? { fields } : {}) }) },
    warn: (message, fields) => { events.push({ message, ...(fields ? { fields } : {}) }) },
    error: (message, fields) => { events.push({ message, ...(fields ? { fields } : {}) }) },
  }
  return { logger, events }
}

/** 模拟 npm install：在 --prefix 下写出一个可被 require.resolve 找到的包。 */
function fakeNpm(options: { version?: string; code?: number; writePackage?: boolean } = {}): NpmRunner {
  return async (args, opts) => {
    const prefixIndex = args.indexOf('--prefix')
    const prefix = args[prefixIndex + 1]!
    const spec = args.at(-1) ?? ''
    const name = spec.slice(0, spec.lastIndexOf('@'))
    const version = options.version ?? spec.slice(spec.lastIndexOf('@') + 1)
    if (options.writePackage !== false) {
      const dir = join(prefix, 'node_modules', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, main: './index.js' }), 'utf8')
      writeFileSync(join(dir, 'index.js'), 'module.exports = { kind: "runtime" }\n', 'utf8')
    }
    opts.onLine(`added ${name}@${version}`)
    return options.code ?? 0
  }
}

describe('插件包名识别', () => {
  it('只接受纯 npm 包名，本地路径与 URL 一律拒绝', () => {
    expect(npmPackageNameOf('@acme/runtime-x')).toBe('@acme/runtime-x')
    expect(npmPackageNameOf('my-runtime')).toBe('my-runtime')
    expect(npmPackageNameOf('./my-runtime')).toBeUndefined()
    expect(npmPackageNameOf('/tmp/my-runtime')).toBeUndefined()
    expect(npmPackageNameOf('file:///tmp/my-runtime')).toBeUndefined()
    expect(npmPackageNameOf('@acme/runtime-x/dist/index.js')).toBeUndefined()
    expect(npmPackageNameOf('my runtime')).toBeUndefined()
    expect(npmPackageNameOf('')).toBeUndefined()
  })
})

describe('安装插件 npm 包', () => {
  it('装到 RA_HOME/node_modules，并按加载器路径校验能解析', async () => {
    const dir = home()
    const { logger, events } = loggerSink()
    const result = await installPluginPackage({
      home: dir,
      packageName: '@acme/runtime-x',
      version: '1.2.3',
      logger,
      runNpm: fakeNpm({ version: '1.2.3' }),
    })
    expect(result.ok).toBe(true)
    expect(result.version).toBe('1.2.3')
    expect(installedPluginVersion(dir, '@acme/runtime-x')).toBe('1.2.3')
    expect(result.log.join('\n')).toContain('安装完成')
    expect(events.map(event => event.message)).toEqual(['plugin:install-started', 'plugin:install-succeeded'])
    expect(events[1]?.fields).toMatchObject({ home: dir, package: '@acme/runtime-x', version: '1.2.3' })
  })

  it('npm 非零退出时返回失败并记录 detail', async () => {
    const dir = home()
    const { logger, events } = loggerSink()
    const result = await installPluginPackage({
      home: dir,
      packageName: 'missing-pkg',
      logger,
      runNpm: fakeNpm({ code: 7, writePackage: false }),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('退出码 7')
    expect(events.find(event => event.message === 'plugin:install-failed')?.fields).toMatchObject({
      package: 'missing-pkg',
    })
    expect(String(events.find(event => event.message === 'plugin:install-failed')?.fields?.detail)).toContain('added missing-pkg')
  })

  it('npm 成功但 node_modules 里没有包时按失败处理', async () => {
    const dir = home()
    const result = await installPluginPackage({
      home: dir,
      packageName: 'ghost-pkg',
      runNpm: fakeNpm({ writePackage: false }),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('不存在')
  })

  it('非法包名不会执行 npm', async () => {
    const dir = home()
    let called = 0
    const result = await installPluginPackage({
      home: dir,
      packageName: '../../etc/passwd',
      runNpm: async () => { called += 1; return 0 },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('不是合法的 npm 包名')
    expect(called).toBe(0)
  })

  it('同名包已有安装任务时直接返回忙', async () => {
    const dir = home()
    const lock = join(dir, '.plugin-install', '_acme_runtime-x.lock')
    mkdirSync(lock, { recursive: true })
    const result = await installPluginPackage({ home: dir, packageName: '@acme/runtime-x', runNpm: fakeNpm() })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('已有 @acme/runtime-x 安装任务在进行')
  })
})
