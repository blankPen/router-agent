import { describe, expect, it } from 'vitest'
import { defaultConfig } from '../../src/config.js'
import type { CommandRunner } from '../../src/infra/process.js'
import { RuntimeRegistry, createRuntimes } from '../../src/worker/registry.js'
import { WorkerRuntimeError, type WorkerRuntime } from '../../src/worker/port.js'

function runner(): CommandRunner {
  return { async run() { return { code: 0, stdout: '', stderr: '' } } }
}

function fake(id: string): WorkerRuntime {
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

describe('RuntimeRegistry', () => {
  it('按 id 取运行时，未知 id 抛 runtime:unknown', () => {
    const registry = new RuntimeRegistry(new Map([
      ['orca', fake('orca')],
      ['claude-cli', fake('claude-cli')],
    ]), 'orca')
    expect(registry.get('claude-cli').id).toBe('claude-cli')
    expect(() => registry.get('nope')).toThrow(WorkerRuntimeError)
    expect(registry.ids()).toEqual(['orca', 'claude-cli'])
  })

  it('默认运行时未注册时启动失败', () => {
    expect(() => new RuntimeRegistry(new Map([['orca', fake('orca')]]), 'claude-cli')).toThrow(/未注册/)
  })

  it('createRuntimes 注册 orca 与 claude-cli，并校验默认值', () => {
    const config = defaultConfig()
    const deps = {
      home: '/tmp/ra-home',
      workersDir: '/tmp/ra-home/workers',
      spec: 'prompt' as const,
      orca: runner(),
      claude: runner(),
      git: runner(),
    }
    expect(createRuntimes(config, deps).default().id).toBe('orca')
    const claude = { ...config, runtime: { default: 'claude-cli' } }
    expect(createRuntimes(claude, deps).default().id).toBe('claude-cli')
    const unknown = { ...config, runtime: { default: 'nope' } }
    expect(() => createRuntimes(unknown, deps)).toThrow(/未注册/)
  })
})