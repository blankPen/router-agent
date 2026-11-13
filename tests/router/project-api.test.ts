import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { createApiServer, type ApiServer } from '../../src/router/api.js'
import { ProjectSetupError, type PreparedProject, type ProjectSetupPort } from '../../src/router/project-setup.js'
import type { ProjectScanPort } from '../../src/router/project-scan.js'
import { defaultConfig, policyOf, type AppConfig } from '../../src/config.js'

function call(server: ApiServer, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
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
        resolve({ status: res.statusCode ?? 0, json })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function prepared(overrides: Partial<PreparedProject> = {}): PreparedProject {
  return {
    path: '/tmp/project',
    name: 'project',
    isGit: true,
    branch: 'main',
    detached: false,
    remoteUrl: 'git@host:group/project.git',
    repo: '/tmp/project',
    ...overrides,
  }
}

describe('项目登记 API', () => {
  let store: Store
  let engine: Engine
  let config: AppConfig

  beforeEach(() => {
    store = new Store(':memory:')
    config = defaultConfig()
    engine = new Engine({ store, policy: policyOf(config) })
  })

  afterEach(() => {
    store.close()
  })

  async function start(projectSetup?: ProjectSetupPort, projectScan?: ProjectScanPort): Promise<ApiServer> {
    return createApiServer({ engine, store, config, ...(projectSetup ? { projectSetup } : {}), ...(projectScan ? { projectScan } : {}) })
  }

  it('未注入 projectSetup 时端点返回 404', async () => {
    const server = await start()
    try {
      const res = await call(server, 'POST', '/api/projects/pick-directory', {})
      expect(res.status).toBe(404)
      expect(res.json.error).toBe('project-setup-not-available')
    } finally {
      await server.close()
    }
  })

  it('本地目录选择透传取消状态', async () => {
    const server = await start({
      pickDirectory: async () => ({ canceled: true, path: '' }),
      inspectDirectory: async () => prepared(),
      prepareLocal: async () => prepared(),
      cloneRepository: async () => prepared(),
    })
    try {
      const res = await call(server, 'POST', '/api/projects/pick-directory', {})
      expect(res.status).toBe(200)
      expect(res.json).toEqual({ canceled: true, path: '' })
    } finally {
      await server.close()
    }
  })

  it('inspect / register / clone 校验入参并转发当前运行时', async () => {
    const runtimes: string[] = []
    const server = await start({
      pickDirectory: async () => ({ canceled: false, path: '/tmp/project' }),
      inspectDirectory: async path => prepared({ path }),
      prepareLocal: async (path, runtimeId) => {
        runtimes.push(runtimeId)
        return prepared({ path, repo: `path:${path}`, orca: { registered: true, repo: `path:${path}`, displayName: 'project' } })
      },
      cloneRepository: async (url, runtimeId) => {
        runtimes.push(runtimeId)
        return prepared({ path: '/tmp/home/repos/project', repo: '/tmp/home/repos/project', remoteUrl: url })
      },
    })
    try {
      const inspect = await call(server, 'POST', '/api/projects/inspect', { path: '/tmp/project' })
      expect(inspect.status).toBe(200)
      expect(inspect.json.path).toBe('/tmp/project')

      const missingPath = await call(server, 'POST', '/api/projects/inspect', {})
      expect(missingPath.status).toBe(400)
      expect(missingPath.json.error).toBe('path-required')

      const register = await call(server, 'POST', '/api/projects/register', { path: '/tmp/project', runtimeId: 'claude-code' })
      expect(register.status).toBe(200)
      expect(register.json.repo).toBe('path:/tmp/project')
      expect(register.json.orca.registered).toBe(true)

      const clone = await call(server, 'POST', '/api/projects/clone', { url: 'git@host:group/project.git' })
      expect(clone.status).toBe(200)
      expect(clone.json.remoteUrl).toBe('git@host:group/project.git')

      const missingUrl = await call(server, 'POST', '/api/projects/clone', {})
      expect(missingUrl.status).toBe(400)
      expect(missingUrl.json.error).toBe('url-required')

      const invalidRuntime = await call(server, 'POST', '/api/projects/register', { path: '/tmp/project', runtimeId: 'nope' })
      expect(invalidRuntime.status).toBe(400)
      expect(invalidRuntime.json.error).toBe('invalid-runtime')

      expect(runtimes).toEqual(['claude-code', config.runtime.default])
    } finally {
      await server.close()
    }
  })

  it('可预期的登记错误返回 400 与错误码', async () => {
    const server = await start({
      pickDirectory: async () => { throw new ProjectSetupError('picker-failed', '无法打开目录选择框') },
      inspectDirectory: async () => { throw new ProjectSetupError('path-not-found', '目录不存在') },
      prepareLocal: async () => { throw new ProjectSetupError('not-a-git-repo', '不是 Git 仓库') },
      cloneRepository: async () => { throw new ProjectSetupError('clone-failed', 'git clone 失败', { url: 'x' }) },
    })
    try {
      const pick = await call(server, 'POST', '/api/projects/pick-directory', {})
      expect(pick.status).toBe(400)
      expect(pick.json.error).toBe('picker-failed')

      const inspect = await call(server, 'POST', '/api/projects/inspect', { path: '/missing' })
      expect(inspect.status).toBe(400)
      expect(inspect.json.error).toBe('path-not-found')

      const register = await call(server, 'POST', '/api/projects/register', { path: '/tmp/plain' })
      expect(register.status).toBe(400)
      expect(register.json.error).toBe('not-a-git-repo')

      const clone = await call(server, 'POST', '/api/projects/clone', { url: 'git@host:a/b.git' })
      expect(clone.status).toBe(400)
      expect(clone.json).toMatchObject({ error: 'clone-failed', url: 'x' })
    } finally {
      await server.close()
    }
  })

  it('扫描本地项目：未注入扫描器时返回 404', async () => {
    const server = await start()
    try {
      const res = await call(server, 'POST', '/api/projects/scan', {})
      expect(res.status).toBe(404)
      expect(res.json.error).toBe('project-scan-not-available')
    } finally {
      await server.close()
    }
  })

  it('扫描本地项目：失败时返回 500 并记 project:scan-failed', async () => {
    const warns: Array<{ message: string; extra?: Record<string, unknown> }> = []
    const server = await createApiServer({
      engine,
      store,
      config,
      logger: { info: () => {}, error: () => {}, warn: (message, extra) => warns.push({ message, extra }) },
      projectScan: { scan: async () => { throw new Error('会话目录读不了') } },
    })
    try {
      const res = await call(server, 'POST', '/api/projects/scan', {})
      expect(res.status).toBe(500)
      expect(res.json.error).toBe('project-scan-failed')
      expect(warns[0]?.message).toBe('project:scan-failed')
      expect(warns[0]?.extra?.detail).toBe('会话目录读不了')
    } finally {
      await server.close()
    }
  })

  it('扫描本地项目：返回候选清单并记录事件', async () => {
    const events: any[] = []
    const server = await createApiServer({
      engine,
      store,
      config,
      onEvent: event => events.push(event),
      projectScan: {
        scan: async () => [
          {
            path: '/Users/me/alpha',
            name: 'alpha',
            sources: ['claude'],
            lastActiveAt: '2026-01-02T00:00:00.000Z',
            isGit: true,
          },
        ],
      },
    })
    try {
      const res = await call(server, 'POST', '/api/projects/scan', {})
      expect(res.status).toBe(200)
      expect(res.json.projects).toHaveLength(1)
      expect(res.json.projects[0].path).toBe('/Users/me/alpha')
      expect(events.some(event => event.event === 'project:scanned')).toBe(true)
    } finally {
      await server.close()
    }
  })
})
