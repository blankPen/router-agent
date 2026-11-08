import { describe, expect, it } from 'vitest'
import { defaultConfig } from '../../src/config.js'
import type { CommandRunner } from '../../src/infra/process.js'
import { BackendRegistry, createBackends } from '../../src/worker/registry.js'
import { WorkerBackendError, type WorkerBackend } from '../../src/worker/port.js'

function runner(): CommandRunner {
  return { async run() { return { code: 0, stdout: '', stderr: '' } } }
}

function fake(id: string): WorkerBackend {
  return {
    id,
    capabilities: {
      agent: { liveStatus: false, processExit: false, output: false, activity: false, structuredInput: false, nudge: false },
      workspace: { cleanup: false, prLink: false, discovery: false },
    },
    async start() { return { handle: id, workdir: `/tmp/${id}` } },
    async deliver() { return { status: 'accepted', inputIds: [] } },
    async stop() {},
  }
}

describe('BackendRegistry', () => {
  it('按 id 取后端，未知 id 抛 backend:unknown', () => {
    const registry = new BackendRegistry(new Map([
      ['orca', fake('orca')],
      ['claude-cli', fake('claude-cli')],
    ]), 'orca')
    expect(registry.get('claude-cli').id).toBe('claude-cli')
    expect(() => registry.get('nope')).toThrow(WorkerBackendError)
    expect(registry.ids()).toEqual(['orca', 'claude-cli'])
  })

  it('默认后端未注册时启动失败', () => {
    expect(() => new BackendRegistry(new Map([['orca', fake('orca')]]), 'claude-cli')).toThrow(/未注册/)
  })

  it('createBackends 注册 orca 与 claude-cli，并校验默认值', () => {
    const config = defaultConfig()
    const deps = {
      home: '/tmp/ra-home',
      workersDir: '/tmp/ra-home/workers',
      spec: 'prompt' as const,
      orca: runner(),
      claude: runner(),
      git: runner(),
    }
    expect(createBackends(config, deps).default().id).toBe('orca')
    const claude = { ...config, backend: { default: 'claude-cli' } }
    expect(createBackends(claude, deps).default().id).toBe('claude-cli')
    const unknown = { ...config, backend: { default: 'nope' } }
    expect(() => createBackends(unknown, deps)).toThrow(/未注册/)
  })
})