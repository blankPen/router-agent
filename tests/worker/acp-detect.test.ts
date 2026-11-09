import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defaultConfig, type AppConfig } from '../../src/config.js'
import {
  checkAcpAgent,
  detectAcpAgents,
  readDetectionSnapshot,
  resolveAgentCommand,
  writeDetectionSnapshot,
} from '../../src/worker/runtimes/acp/detect.js'
import { acpAgentOf } from '../../src/worker/runtimes/acp/agents.js'

const fixture = fileURLToPath(new URL('../fixtures/fake-acp-agent.mjs', import.meta.url))

function home(): string {
  return mkdtempSync(join(tmpdir(), 'ra-acp-detect-'))
}

function fakeBin(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8')
  chmodSync(path, 0o755)
  return path
}

function config(): AppConfig {
  return defaultConfig()
}

describe('ACP 运行时探测', () => {
  it('PATH 上的 version 探测：ready / unverified / not-installed', async () => {
    const dir = home()
    const bin = join(dir, 'bin')
    fakeBin(bin, 'claude-agent-acp', 'echo 0.101.0')
    fakeBin(bin, 'opencode', 'echo 2.1.4')
    const snapshot = await detectAcpAgents({
      home: dir,
      env: { ...process.env, PATH: bin },
      config: config(),
      timeoutMs: 5_000,
    })
    const byId = new Map(snapshot.choices.map(choice => [choice.id, choice]))
    expect(byId.get('acp-claude')).toMatchObject({ status: 'ready', version: '0.101.0', source: 'path' })
    expect(byId.get('acp-opencode')).toMatchObject({ status: 'unverified', version: '2.1.4' })
    expect(byId.get('acp-gemini')).toMatchObject({ status: 'not-installed' })
    expect(byId.get('acp-gemini')?.reason).toContain('gemini')
  })

  it('managed 安装优先于 PATH，配置覆盖优先于 managed', async () => {
    const dir = home()
    const pathBin = join(dir, 'path-bin')
    fakeBin(pathBin, 'claude-agent-acp', 'echo 9.9.9')
    const managed = join(dir, 'runtimes', 'claude', 'node_modules', '.bin')
    fakeBin(managed, 'claude-agent-acp', 'echo 8.8.8')

    const cfg = config()
    const agent = acpAgentOf('acp-claude')!
    expect(resolveAgentCommand(agent, { home: dir, env: { ...process.env, PATH: pathBin }, config: cfg }))
      .toMatchObject({ source: 'managed' })

    const override = fakeBin(join(dir, 'custom'), 'my-claude-acp', 'echo 7.7.7')
    cfg.runtime.options = { 'acp-claude': { command: override } }
    const snapshot = await detectAcpAgents({
      home: dir,
      env: { ...process.env, PATH: pathBin },
      config: cfg,
      timeoutMs: 5_000,
    })
    const claude = snapshot.choices.find(choice => choice.id === 'acp-claude')
    expect(claude).toMatchObject({ status: 'ready', version: '7.7.7', source: 'config' })
  })

  it('配置指向不存在的命令时判 not-installed 并给出原因', async () => {
    const dir = home()
    const cfg = config()
    cfg.runtime.options = { 'acp-claude': { command: join(dir, 'nope') } }
    const snapshot = await detectAcpAgents({ home: dir, env: { ...process.env, PATH: '' }, config: cfg })
    const claude = snapshot.choices.find(choice => choice.id === 'acp-claude')
    expect(claude?.status).toBe('not-installed')
    expect(claude?.reason).toContain('不存在')
  })

  it('codex：缺 app-server 判 incompatible，登录失败判 needs-auth', async () => {
    const dir = home()
    const bin = join(dir, 'bin')
    fakeBin(bin, 'codex-acp', 'if [ "$1" = "version" ]; then echo 1.11.0; fi')
    fakeBin(bin, 'codex', 'case "$1" in --version) echo "codex-cli 0.166.0";; app-server) exit 1;; login) exit 1;; esac')

    const broken = await detectAcpAgents({ home: dir, env: { ...process.env, PATH: bin }, config: config(), timeoutMs: 5_000 })
    const brokenCodex = broken.choices.find(choice => choice.id === 'acp-codex')
    expect(brokenCodex?.status).toBe('incompatible')
    expect(brokenCodex?.reason).toContain('app-server')

    fakeBin(bin, 'codex', 'case "$1" in --version) echo "codex-cli 0.166.0";; app-server) exit 0;; login) exit 1;; esac')
    const unauthenticated = await detectAcpAgents({ home: dir, env: { ...process.env, PATH: bin }, config: config(), timeoutMs: 5_000 })
    const codex = unauthenticated.choices.find(choice => choice.id === 'acp-codex')
    expect(codex?.status).toBe('needs-auth')
    expect(codex?.loginHint).toContain('codex-acp login')

    fakeBin(bin, 'codex', 'case "$1" in --version) echo "codex-cli 0.166.0";; app-server) exit 0;; login) exit 0;; esac')
    const ready = await detectAcpAgents({ home: dir, env: { ...process.env, PATH: bin }, config: config(), timeoutMs: 5_000 })
    expect(ready.choices.find(choice => choice.id === 'acp-codex')?.status).toBe('ready')
  })

  it('探测缓存可读写', async () => {
    const dir = home()
    const snapshot = await detectAcpAgents({ home: dir, env: { ...process.env, PATH: '' }, config: config() })
    writeDetectionSnapshot(dir, snapshot)
    expect(readDetectionSnapshot(dir)).toEqual(snapshot)
  })

  it('checkAcpAgent 完成 initialize + session/new', async () => {
    const dir = home()
    const cfg = config()
    cfg.runtime.options = {
      'acp-claude': { command: process.execPath, args: [fixture] },
    }
    const result = await checkAcpAgent('acp-claude', { home: dir, env: { ...process.env }, config: cfg, timeoutMs: 5_000 })
    expect(result).toMatchObject({ ok: true, status: 'ready', protocolVersion: 1, loadSession: true })
  })
})