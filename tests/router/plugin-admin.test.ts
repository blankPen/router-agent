import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultConfig, policyOf } from '../../src/config.js'
import { Engine } from '../../src/core/engine.js'
import { Store } from '../../src/store/db.js'
import { createApiServer, type ApiServer } from '../../src/router/api.js'
import { PluginInstallStartError, PluginPackageAdmin } from '../../src/router/plugin-admin.js'
import type { NpmRunner } from '#infra/plugin-install.js'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'ra-plugin-admin-'))
}

/** 模拟 npm install：写到 --prefix 下的 node_modules。 */
function fakeNpm(options: { wait?: Promise<void> } = {}): NpmRunner {
  return async (args, opts) => {
    if (options.wait) await options.wait
    const prefixIndex = args.indexOf('--prefix')
    const prefix = args[prefixIndex + 1]!
    const spec = args.at(-1) ?? ''
    const name = spec.slice(0, spec.lastIndexOf('@'))
    const version = spec.slice(spec.lastIndexOf('@') + 1)
    const dir = join(prefix, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, main: './index.js' }), 'utf8')
    writeFileSync(join(dir, 'index.js'), 'module.exports = { kind: "runtime" }\n', 'utf8')
    opts.onLine(`added ${name}@${version}`)
    return 0
  }
}

async function waitJob(admin: PluginPackageAdmin, jobId: string): Promise<ReturnType<PluginPackageAdmin['installJob']>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = admin.installJob(jobId)
    if (job && job.status !== 'running') return job
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  }
  throw new Error(`任务 ${jobId} 没有结束`)
}

function call(server: ApiServer, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolvePromise, reject) => {
    const address = server.server.address() as AddressInfo
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request({
      host: '127.0.0.1',
      port: address.port,
      path,
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, res => {
      let data = ''
      res.on('data', chunk => { data += String(chunk) })
      res.on('end', () => {
        let json: any = null
        try { json = data ? JSON.parse(data) : null } catch { json = data }
        resolvePromise({ status: res.statusCode ?? 0, json })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

describe('插件包安装任务', () => {
  it('安装配置里声明的 npm 包并记录任务日志', async () => {
    const dir = home()
    const config = defaultConfig()
    config.runtime.plugins = { 'my-runtime': '@acme/runtime-x' }
    const admin = new PluginPackageAdmin({ home: dir, config, env: {}, runNpm: fakeNpm() })
    const job = admin.startInstall('runtime', 'my-runtime')
    expect(job).toMatchObject({ kind: 'runtime', pluginId: 'my-runtime', packageName: '@acme/runtime-x', status: 'running' })
    const finished = await waitJob(admin, job.id)
    expect(finished?.status).toBe('ok')
    expect(finished?.phase).toBe('succeeded')
    expect(finished?.installedVersion).toBe('latest')
    expect(finished?.lines?.join('\n')).toContain('added @acme/runtime-x')
  })

  it('本地路径、未声明、禁用与内置包都拒绝启动安装', () => {
    const dir = home()
    const config = defaultConfig()
    config.runtime.plugins = {
      local: './local-runtime',
      disabled: { plugin: '@acme/runtime-x', enabled: false },
    }
    const admin = new PluginPackageAdmin({ home: dir, config, env: {}, runNpm: fakeNpm() })
    expect(() => admin.startInstall('runtime', 'local')).toThrow(PluginInstallStartError)
    expect(() => admin.startInstall('runtime', 'missing')).toThrow(/没有 runtime 插件/)
    expect(() => admin.startInstall('runtime', 'disabled')).toThrow(/禁用/)
    expect(() => admin.startInstall('runtime', 'orca')).toThrow(/自带的内置包/)
  })


  it('配置里没有该插件时，可按请求体里的包名直接安装', async () => {
    const dir = home()
    const admin = new PluginPackageAdmin({ home: dir, config: defaultConfig(), env: {}, runNpm: fakeNpm() })
    const job = admin.startInstall('runtime', 'my-runtime', { packageName: '@acme/runtime-x' })
    expect(job).toMatchObject({ kind: 'runtime', pluginId: 'my-runtime', packageName: '@acme/runtime-x', status: 'running' })
    const finished = await waitJob(admin, job.id)
    expect(finished?.status).toBe('ok')
  })

  it('请求体里的包名不是 npm 包时拒绝启动', () => {
    const admin = new PluginPackageAdmin({ home: home(), config: defaultConfig(), env: {}, runNpm: fakeNpm() })
    expect(() => admin.startInstall('runtime', 'my-runtime', { packageName: './local' })).toThrow(/不是 npm 包/)
  })

  it('同一次安装进行中再次启动会返回忙', async () => {
    const dir = home()
    const config = defaultConfig()
    config.runtime.plugins = { 'my-runtime': '@acme/runtime-x' }
    let release!: () => void
    const gate = new Promise<void>(resolvePromise => { release = resolvePromise })
    const admin = new PluginPackageAdmin({ home: dir, config, env: {}, runNpm: fakeNpm({ wait: gate }) })
    const first = admin.startInstall('runtime', 'my-runtime')
    expect(() => admin.startInstall('runtime', 'my-runtime')).toThrow(/正在安装/)
    release()
    const finished = await waitJob(admin, first.id)
    expect(finished?.status).toBe('ok')
    // 完成以后可以再次启动。
    expect(() => admin.startInstall('runtime', 'my-runtime')).not.toThrow()
  })

  it('channel 插件走同一套安装逻辑', async () => {
    const dir = home()
    const config = defaultConfig()
    config.channels = { slack: 'slack-channel' }
    const admin = new PluginPackageAdmin({ home: dir, config, env: {}, runNpm: fakeNpm() })
    const job = admin.startInstall('channel', 'slack')
    const finished = await waitJob(admin, job.id)
    expect(finished?.status).toBe('ok')
  })
})

describe('插件安装 API', () => {
  const closers: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()?.()
  })

  it('POST 启动安装、GET 轮询任务结果', async () => {
    const dir = home()
    const config = defaultConfig()
    config.runtime.plugins = { 'my-runtime': '@acme/runtime-x' }
    const store = new Store(':memory:')
    const engine = new Engine({ store, policy: policyOf(config) })
    const admin = new PluginPackageAdmin({ home: dir, config, env: {}, runNpm: fakeNpm() })
    const server = await createApiServer({ engine, store, config, pluginAdmin: admin })
    closers.push(async () => { await server.close(); store.close() })

    const started = await call(server, 'POST', '/api/plugins/install', { kind: 'runtime', id: 'my-runtime' })
    expect(started.status).toBe(202)
    expect(started.json).toMatchObject({ ok: true, jobId: started.json.id, pluginId: 'my-runtime', packageName: '@acme/runtime-x' })

    let job = await call(server, 'GET', `/api/plugins/install/${started.json.jobId}`)
    for (let attempt = 0; attempt < 100 && job.json.status === 'running'; attempt += 1) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
      job = await call(server, 'GET', `/api/plugins/install/${started.json.jobId}`)
    }
    expect(job.status).toBe(200)
    expect(job.json.status).toBe('ok')
  })


  it('POST 带 packageName 可为未保存的插件启动安装', async () => {
    const dir = home()
    const store = new Store(':memory:')
    const config = defaultConfig()
    const engine = new Engine({ store, policy: policyOf(config) })
    const admin = new PluginPackageAdmin({ home: dir, config, env: {}, runNpm: fakeNpm() })
    const server = await createApiServer({ engine, store, config, pluginAdmin: admin })
    closers.push(async () => { await server.close(); store.close() })

    const started = await call(server, 'POST', '/api/plugins/install', { kind: 'runtime', id: 'my-runtime', packageName: '@acme/runtime-x' })
    expect(started.status).toBe(202)
    expect(started.json).toMatchObject({ ok: true, packageName: '@acme/runtime-x' })
  })

  it('未知插件与非法 kind 返回 400', async () => {
    const store = new Store(':memory:')
    const config = defaultConfig()
    const engine = new Engine({ store, policy: policyOf(config) })
    const admin = new PluginPackageAdmin({ home: home(), config, env: {}, runNpm: fakeNpm() })
    const server = await createApiServer({ engine, store, config, pluginAdmin: admin })
    closers.push(async () => { await server.close(); store.close() })

    const unknown = await call(server, 'POST', '/api/plugins/install', { id: 'missing' })
    expect(unknown.status).toBe(400)
    expect(unknown.json.error).toBe('unknown-plugin')

    const invalidKind = await call(server, 'POST', '/api/plugins/install', { kind: 'agent', id: 'x' })
    expect(invalidKind.status).toBe(400)
    expect(invalidKind.json.error).toBe('invalid-kind')
  })

  it('没有注入 pluginAdmin 时端点返回 404', async () => {
    const store = new Store(':memory:')
    const config = defaultConfig()
    const engine = new Engine({ store, policy: policyOf(config) })
    const server = await createApiServer({ engine, store, config })
    closers.push(async () => { await server.close(); store.close() })
    const started = await call(server, 'POST', '/api/plugins/install', { id: 'x' })
    expect(started.status).toBe(404)
  })
})
