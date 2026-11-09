import { describe, expect, it } from 'vitest'
import { defaultConfig } from '../../src/config.js'
import type { CommandRunner } from '../../src/infra/process.js'
import { RuntimeRegistry, createRuntimes } from '../../src/worker/registry.js'
import { ACP_AGENTS } from '../../src/worker/runtimes/acp/agents.js'
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
      ['claude-code', fake('claude-code')],
    ]), 'orca')
    expect(registry.get('claude-code').id).toBe('claude-code')
    expect(() => registry.get('nope')).toThrow(WorkerRuntimeError)
    expect(registry.ids()).toEqual(['orca', 'claude-code'])
  })

  it('兼容旧 id：claude-cli 归一到 claude-code', () => {
    const registry = new RuntimeRegistry(new Map([
      ['orca', fake('orca')],
      ['claude-code', fake('claude-code')],
    ]), 'claude-cli')
    expect(registry.default().id).toBe('claude-code')
    expect(registry.get('claude-cli').id).toBe('claude-code')
    expect(registry.has('claude-cli')).toBe(true)
  })

  it('默认运行时未注册时启动失败', () => {
    expect(() => new RuntimeRegistry(new Map([['orca', fake('orca')]]), 'claude-code')).toThrow(/未注册/)
  })

  it('createRuntimes 注册 orca 与 claude-code，并校验默认值', () => {
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
    const claude = { ...config, runtime: { default: 'claude-code' } }
    expect(createRuntimes(claude, deps).default().id).toBe('claude-code')
    // 旧配置值仍可在启动时兼容。
    const legacy = { ...config, runtime: { default: 'claude-cli' } }
    expect(createRuntimes(legacy, deps).default().id).toBe('claude-code')
    const unknown = { ...config, runtime: { default: 'nope' } }
    expect(() => createRuntimes(unknown, deps)).toThrow(/未注册/)
  })

  it('注册全部 ACP 目录运行时；未安装时 start 抛 runtime:unavailable', async () => {
    const config = defaultConfig()
    config.runtime.default = 'acp-codex'
    const registry = createRuntimes(config, {
      home: '/tmp/ra-home',
      workersDir: '/tmp/ra-home/workers',
      spec: 'prompt' as const,
      orca: runner(),
      claude: runner(),
      git: runner(),
      env: { PATH: '' },
    })
    expect(registry.ids()).toEqual(expect.arrayContaining(ACP_AGENTS.map(agent => agent.runtimeId)))
    await expect(registry.get('acp-codex').start({
      ticket: {
        id: 'tk-1', title: 't', threadId: 't', source: 'feishu', chatId: 'c',
        repo: '/tmp/repo', branch: 'main', task: 't', stage: 'assigned',
      },
      assignment: { id: 'as-1', ticketId: 'tk-1', runtimeId: 'acp-codex', handle: '', workdir: '', status: 'pending', startedAt: '' },
      brief: { ticketId: 'tk-1', title: 't', scope: '', workBranch: 'ra/tk-1', contract: 'x' },
      tools: { fileAccess: 'read-write', shell: 'allow', allowNetwork: false },
    } as never)).rejects.toMatchObject({ code: 'runtime:unavailable' })
  })
})
