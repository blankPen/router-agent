import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  describePluginLoadError,
  loadRuntimePlugins,
  pluginEntryOf,
} from '#runtime/plugins/loader.js'
import { defaultPluginLoader, resolvePluginSpecifier } from '#infra/plugin-loader.js'
import { channelPluginEntryOf, loadChannelPlugins, type ChannelPluginConfigView } from '#channel/plugins/loader.js'
import type { Logger } from '#infra/logger.js'
import type { RuntimePluginConfigView } from '#runtime/plugins/loader.js'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'ra-plugins-'))
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

describe('插件清单', () => {
  it('未配置时使用内置插件包名', () => {
    const config = defaultConfigShape()
    expect(pluginEntryOf(config, 'runtime', 'orca')).toBe('@router-agent/runtime-orca')
    expect(channelPluginEntryOf(config, 'feishu')).toBe('@router-agent/channel-feishu')
  })

  it('配置里的包名覆盖内置包名', () => {
    const config = defaultConfigShape({
      runtime: { default: 'orca', plugins: { orca: '/tmp/my-runtime/index.js' } },
      channels: { feishu: { plugin: '/tmp/my-channel/index.js' } },
    })
    expect(pluginEntryOf(config, 'runtime', 'orca')).toBe('/tmp/my-runtime/index.js')
    expect(channelPluginEntryOf(config, 'feishu')).toBe('/tmp/my-channel/index.js')
  })
})

describe('插件入口解析', () => {
  it('装在 RA_HOME/node_modules 的 ESM 包只声明 import 条件时也能解析', () => {
    const root = home()
    const pkgDir = join(root, 'node_modules', '@acme', 'runtime-esm')
    mkdirSync(join(pkgDir, 'dist'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@acme/runtime-esm',
      type: 'module',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    }), 'utf8')
    writeFileSync(join(pkgDir, 'dist', 'index.js'), 'export default { kind: "runtime" }\n', 'utf8')

    // 插件包是 ESM-only：只给 require.resolve 会抛 ERR_PACKAGE_PATH_NOT_EXPORTED。
    const resolved = resolvePluginSpecifier('@acme/runtime-esm', root, defaultPluginLoader())
    expect(resolved).toBe(`file://${join(pkgDir, 'dist', 'index.js')}`)
  })
})

describe('插件加载失败', () => {
  it('把解析失败整理成带包名与错的 detail', () => {
    const error = new Error('Cannot find package')
    ;(error as Error & { code?: string }).code = 'ERR_MODULE_NOT_FOUND'
    expect(describePluginLoadError('runtime', 'my-runtime', error)).toBe(
      'runtime 插件 my-runtime 加载失败：Cannot find package',
    )
  })
})

describe('runtime 插件加载', () => {
  it('目录型插件按 entry 解析入口', async () => {
    const root = home()
    const dir = join(root, 'entry-runtime')
    mkdirSync(join(dir, 'build'), { recursive: true })
    writeFileSync(join(dir, 'index.mjs'), 'export default { kind: "runtime" }\n', 'utf8')
    writeFileSync(join(dir, 'build', 'plugin.mjs'), [
      'export default {',
      '  kind: "runtime",',
      '  meta: { id: "entry-runtime", name: "Entry Runtime", label: "entry-runtime", hint: "entry" },',
      '  create() { return { id: "entry-runtime", capabilities: { agent: { liveStatus: false, processExit: false, output: false, activity: false, structuredInput: false, nudge: false }, workspace: { cleanup: false, prLink: false, discovery: false } }, async start() { return { handle: "h", workdir: "/tmp/w" } }, async deliver() { return { status: "accepted", inputIds: [] } }, async stop() {} } },',
      '}',
    ].join('\n'), 'utf8')
    const config = defaultConfigShape({
      runtime: {
        default: 'entry-runtime',
        plugins: { 'entry-runtime': { path: './entry-runtime', entry: 'build/plugin.mjs' } },
      },
    })
    const result = await loadRuntimePlugins(config, {
      home: root,
      workersDir: join(root, 'workers'),
      logger: loggerSink().logger,
    })
    expect(result.registry.default().id).toBe('entry-runtime')
  })

  it('createAll 注册的实例 id 进入 loadedIds，供配置校验使用', async () => {
    const root = home()
    const dir = join(root, 'multi-runtime')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.mjs'), [
      'const runtime = id => ({ id, capabilities: { agent: { liveStatus: false, processExit: false, output: false, activity: false, structuredInput: false, nudge: false }, workspace: { cleanup: false, prLink: false, discovery: false } }, async start() { return { handle: id, workdir: "/tmp/w" } }, async deliver() { return { status: "accepted", inputIds: [] } }, async stop() {} })',
      'export default {',
      '  kind: "runtime",',
      '  meta: { id: "multi", name: "Multi", label: "multi", hint: "多实例" },',
      '  create() { return runtime("multi-a") },',
      '  createAll() { return [runtime("multi-a"), runtime("multi-b")] },',
      '}',
    ].join('\n'), 'utf8')
    const config = defaultConfigShape({
      runtime: { default: 'multi-b', plugins: { multi: './multi-runtime/index.mjs' } },
    })
    const result = await loadRuntimePlugins(config, {
      home: root,
      workersDir: join(root, 'workers'),
      logger: loggerSink().logger,
    })
    expect(result.registry.default().id).toBe('multi-b')
    expect(result.ids).toEqual(expect.arrayContaining(['multi-a', 'multi-b']))
    expect(result.loadedIds.multi).toEqual(['multi-a', 'multi-b'])
  })

  it('加载配置指定的本地插件，并保留默认运行时', async () => {
    const root = home()
    const dir = join(root, 'my-runtime')
    mkdirSync(dir, { recursive: true })
    const entry = join(dir, 'index.mjs')
    writeFileSync(entry, [
      'export default {',
      '  kind: "runtime",',
      '  meta: { id: "my-runtime", name: "My Runtime", label: "my-runtime", hint: "测试运行时" },',
      '  create() { return { id: "my-runtime", capabilities: { agent: { liveStatus: false, processExit: false, output: false, activity: false, structuredInput: false, nudge: false }, workspace: { cleanup: false, prLink: false, discovery: false } }, async start() { return { handle: "h", workdir: "/tmp/w" } }, async deliver() { return { status: "accepted", inputIds: [] } }, async stop() {} } },',
      '}',
    ].join('\n'), 'utf8')
    const { logger, events } = loggerSink()
    const config = defaultConfigShape({
      runtime: {
        default: 'my-runtime',
        plugins: { 'my-runtime': './my-runtime/index.mjs' },
      },
    })
    const result = await loadRuntimePlugins(config, {
      home: root,
      workersDir: join(root, 'workers'),
      logger,
    })
    expect(result.registry.default().id).toBe('my-runtime')
    expect(result.metas.map(meta => meta.id)).toContain('my-runtime')
    expect(events.map(event => event.message)).toContain('plugin:loaded')
  })

  it('配置 id 与插件声明 id 不一致时，面板身份仍按配置 id 回链', async () => {
    const root = home()
    const dir = join(root, 'renamed')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.mjs'), [
      'export default {',
      '  kind: "runtime",',
      '  meta: { id: "declared", name: "Declared", label: "declared", hint: "声明 id" },',
      '  create() { return { id: "renamed", capabilities: { agent: { liveStatus: false, processExit: false, output: false, activity: false, structuredInput: false, nudge: false }, workspace: { cleanup: false, prLink: false, discovery: false } }, async start() { return { handle: "h", workdir: "/tmp/w" } }, async deliver() { return { status: "accepted", inputIds: [] } }, async stop() {} } },',
      '}',
    ].join('\n'), 'utf8')
    const { logger, events } = loggerSink()
    const result = await loadRuntimePlugins(
      defaultConfigShape({ runtime: { default: 'renamed', plugins: { renamed: './renamed/index.mjs' } } }),
      { home: root, workersDir: join(root, 'workers'), logger },
    )
    expect(result.metas.map(meta => meta.id)).toContain('renamed')
    expect(result.loadedIds.renamed).toEqual(['renamed'])
    expect(events.some(event => event.message === 'plugin:id-mismatch' && event.fields?.declared === 'declared')).toBe(true)
  })

  it('插件加载失败时记录 error 并继续启动内置运行时', async () => {
    const root = home()
    const { logger, events } = loggerSink()
    const config = defaultConfigShape({
      runtime: { default: 'my-runtime', plugins: { 'my-runtime': './missing.mjs' } },
    })
    const result = await loadRuntimePlugins(config, {
      home: root,
      workersDir: join(root, 'workers'),
      logger,
      builtins: [],
    }).catch(error => error as Error)
    expect(result).toBeInstanceOf(Error)
    expect(String(result)).toContain('没有可用的 runtime 插件')
    const failure = events.find(event => event.message === 'plugin:load-failed')
    expect(failure?.fields).toMatchObject({ kind: 'runtime', id: 'my-runtime' })
    expect(String(failure?.fields?.detail)).toContain('加载失败')
  })
})

describe('channel 插件加载', () => {
  it('createAll 注册多个通道实例，且按 entry 加载', async () => {
    const root = home()
    const dir = join(root, 'multi-channel')
    mkdirSync(join(dir, 'build'), { recursive: true })
    writeFileSync(join(dir, 'build', 'plugin.mjs'), [
      'const adapter = id => ({ id, kind: "multi", capabilities: {}, normalize() { return { dropped: "no" } }, async send() { return {} } })',
      'export default {',
      '  kind: "channel",',
      '  meta: { id: "multi", name: "Multi", hint: "多实例通道" },',
      '  create() { return adapter("chat-a") },',
      '  createAll() { return [adapter("chat-a"), adapter("chat-b")] },',
      '}',
    ].join('\n'), 'utf8')
    const result = await loadChannelPlugins({
      home: root,
      channels: { multi: { path: './multi-channel', entry: 'build/plugin.mjs' } },
    }, { home: root, logger: loggerSink().logger, builtins: [] })
    expect(result.registry.list().map(adapter => adapter.id)).toEqual(['chat-a', 'chat-b'])
    expect(result.loadedIds.multi).toEqual(['chat-a', 'chat-b'])
  })

  it('目录没有默认入口时，从 package.json 的 exports 找入口', async () => {
    const root = home()
    const dir = join(root, 'manifest-channel')
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'manifest-channel',
      type: 'module',
      exports: { '.': { import: './dist/entry.mjs' } },
    }), 'utf8')
    writeFileSync(join(dir, 'dist', 'entry.mjs'), [
      'export default {',
      '  kind: "channel",',
      '  meta: { id: "manifest", name: "Manifest", hint: "清单入口" },',
      '  create() { return { id: "manifest", kind: "manifest", capabilities: {}, normalize() { return { dropped: "no" } }, async send() { return {} } } },',
      '}',
    ].join('\n'), 'utf8')
    const result = await loadChannelPlugins({
      home: root,
      channels: { manifest: './manifest-channel' },
    }, { home: root, logger: loggerSink().logger, builtins: [] })
    expect(result.registry.get('manifest')?.id).toBe('manifest')
  })

  it('加载配置指定的本地通道插件并注册', async () => {
    const root = home()
    const dir = join(root, 'my-channel')
    mkdirSync(dir, { recursive: true })
    const entry = join(dir, 'index.mjs')
    writeFileSync(entry, [
      'export default {',
      '  kind: "channel",',
      '  meta: { id: "my-channel", name: "My Channel", hint: "测试通道" },',
      '  create() { return { id: "my-channel", kind: "my-channel", capabilities: {}, normalize() { return { dropped: "no" } }, async send() { return {} } } },',
      '}',
    ].join('\n'), 'utf8')
    const { logger } = loggerSink()
    const config = defaultConfigShape({
      channels: { 'my-channel': { plugin: './my-channel/index.mjs' } },
    })
    const result = await loadChannelPlugins(config, { home: root, logger })
    expect(result.registry.get('my-channel')?.id).toBe('my-channel')
    expect(result.metas.map(meta => meta.id)).toContain('my-channel')
  })
})

function defaultConfigShape(over: Record<string, unknown> = {}): RuntimePluginConfigView & ChannelPluginConfigView {
  return {
    home: '',
    runtime: { default: 'orca' },
    channels: { feishu: {} },
    ...over,
  } as never
}
