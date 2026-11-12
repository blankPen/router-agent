import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultConfig, type AppConfig } from '../../src/config.js'
import { AcpRuntimeAdmin, InstallStartError } from '../../src/worker/runtimes/acp/admin.js'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'ra-acp-admin-'))
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

describe('内置运行时探测', () => {
  it('orca 可用时返回版本与来源，其余内置项保持可见', async () => {
    const dir = home()
    const bin = join(dir, 'bin')
    fakeBin(bin, 'orca', 'echo 1.2.3')
    const admin = new AcpRuntimeAdmin({ home: dir, env: { ...process.env, PATH: bin }, config: config() })
    const snapshot = await admin.detect()
    const byId = new Map(snapshot.choices.map(choice => [choice.id, choice]))
    expect(byId.get('orca')).toMatchObject({ status: 'ready', version: '1.2.3', source: 'path' })
    expect(byId.get('claude-code')).toMatchObject({ status: 'not-installed' })
    expect(byId.get('acp')).toMatchObject({ status: 'not-installed', installable: false })
    expect(byId.get('acp')?.reason).toContain('runtime.options.acp.command')
    // ACP 目录项仍然保留，内置项不能把动态度量吞掉。
    expect(byId.has('acp-claude')).toBe(true)
  })

  it('herdr：CLI 装好且服务端在跑时判 ready', async () => {
    const dir = home()
    const bin = join(dir, 'bin')
    fakeBin(bin, 'herdr', 'case "$1" in --version) echo "herdr 0.9.5";; status) echo "status: running";; esac')
    const admin = new AcpRuntimeAdmin({ home: dir, env: { ...process.env, PATH: bin }, config: config() })
    const snapshot = await admin.detect()
    const herdr = snapshot.choices.find(choice => choice.id === 'herdr')
    expect(herdr).toMatchObject({ status: 'ready', version: '0.9.5' })
    expect(herdr?.cli?.label).toBe('Herdr CLI')
  })

  it('herdr：服务端没跑时自动拉起来并判 ready', async () => {
    const dir = home()
    const bin = join(dir, 'bin')
    const marker = join(dir, 'herdr-server.pid')
    // 模拟真 Herdr：`herdr server` 起来之后，`status server` 才会报 running。
    fakeBin(bin, 'herdr', [
      'case "$1" in',
      '  --version) echo "herdr 0.9.5";;',
      `  server) echo $$ > "${marker}";;`,
      `  status) if [ -f "${marker}" ]; then echo "status: running"; else echo "status: not running"; fi;;`,
      'esac',
    ].join('\n'))
    const admin = new AcpRuntimeAdmin({ home: dir, env: { ...process.env, PATH: bin }, config: config() })
    const snapshot = await admin.detect()
    const herdr = snapshot.choices.find(choice => choice.id === 'herdr')
    expect(herdr).toMatchObject({ status: 'ready', version: '0.9.5' })
  })

  it('herdr：服务端拉不起来时判 unverified 并说明原因', async () => {
    const dir = home()
    const bin = join(dir, 'bin')
    fakeBin(bin, 'herdr', 'case "$1" in --version) echo "herdr 0.9.5";; status) echo "status: not running";; esac')
    const admin = new AcpRuntimeAdmin({
      home: dir,
      env: { ...process.env, PATH: bin },
      config: config(),
      herdrServerTimeoutMs: 60,
    })
    const snapshot = await admin.detect()
    const herdr = snapshot.choices.find(choice => choice.id === 'herdr')
    expect(herdr?.status).toBe('unverified')
    expect(herdr?.reason).toContain('herdr server')
  })

  it('herdr：没装 CLI 时判 not-installed', async () => {
    const dir = home()
    const admin = new AcpRuntimeAdmin({ home: dir, env: { ...process.env, PATH: join(dir, 'empty') }, config: config() })
    const snapshot = await admin.detect()
    expect(snapshot.choices.find(choice => choice.id === 'herdr')).toMatchObject({ status: 'not-installed' })
  })

  it('claude-code 缺少 git 时判 incompatible 并给出依赖项', async () => {
    const dir = home()
    const bin = join(dir, 'bin')
    fakeBin(bin, 'claude', 'echo 2.0.0')
    const admin = new AcpRuntimeAdmin({ home: dir, env: { ...process.env, PATH: bin }, config: config() })
    const snapshot = await admin.detect()
    const claude = snapshot.choices.find(choice => choice.id === 'claude-code')
    expect(claude?.status).toBe('incompatible')
    expect(claude?.reason).toContain('git')
    expect(claude?.requires?.[0]).toMatchObject({ label: 'Git CLI', ok: false })
  })

  it('check 内置运行时只做版本/依赖探测，不会透出 ACP 未知 Agent', async () => {
    const dir = home()
    const bin = join(dir, 'bin')
    fakeBin(bin, 'orca', 'echo 3.4.5')
    const admin = new AcpRuntimeAdmin({ home: dir, env: { ...process.env, PATH: bin }, config: config() })
    await admin.detect()
    const checked = await admin.check('orca')
    expect(checked).toMatchObject({
      ok: true,
      choice: { id: 'orca', status: 'ready', version: '3.4.5' },
    })
    expect(checked.detail).toContain('3.4.5')
    // check 不应该丢掉已探测到的其它 choice。
    expect(admin.snapshot()?.choices.some(choice => choice.id === 'acp-claude')).toBe(true)
  })

  it('内置运行时不允许在线安装', async () => {
    const dir = home()
    const admin = new AcpRuntimeAdmin({ home: dir, env: { ...process.env, PATH: join(dir, 'bin') }, config: config() })
    expect(() => admin.startInstall('orca')).toThrow(InstallStartError)
  })

  it('codex-app 优先探测 Codex CLI，并支持真实 initialize 握手', async () => {
    const dir = home()
    const bin = join(dir, 'bin')
    fakeBin(bin, 'codex', [
      'case "$1" in',
      '  --version) echo "codex-cli 0.166.0"; exit 0;;',
      '  app-server)',
      '    if [ "$2" = "--help" ]; then exit 0; fi',
      '    read line',
      '    echo \'{"id":1,"result":{"userAgent":"fake-codex/0.166.0"}}\'',
      '    exit 0;;',
      'esac',
      'exit 1',
    ].join('\n'))
    const admin = new AcpRuntimeAdmin({ home: dir, env: { ...process.env, PATH: bin }, config: config() })
    const snapshot = await admin.detect()
    const codex = snapshot.choices.find(choice => choice.id === 'codex-app')
    expect(codex).toMatchObject({ status: 'ready', version: '0.166.0', source: 'path', command: join(bin, 'codex') })

    const checked = await admin.check('codex-app')
    expect(checked.ok).toBe(true)
    expect(checked.detail).toContain('initialize 握手通过')
    expect(checked.choice).toMatchObject({ id: 'codex-app', status: 'ready' })
  })
})

describe('自定义 acp 运行时', () => {
  it('未配置命令时不可用，配置后进入待验证', async () => {
    const dir = home()
    const bin = join(dir, 'bin')
    const acpBin = fakeBin(bin, 'my-acp', 'exit 0')
    const cfg = config()
    const env = { ...process.env, PATH: bin }

    const missing = await new AcpRuntimeAdmin({ home: dir, env, config: cfg }).detect()
    expect(missing.choices.find(choice => choice.id === 'acp')?.status).toBe('not-installed')

    cfg.runtime.options = { acp: { command: acpBin } }
    const admin = new AcpRuntimeAdmin({ home: dir, env, config: cfg })
    const detected = await admin.detect()
    expect(detected.choices.find(choice => choice.id === 'acp')).toMatchObject({
      status: 'unverified',
      source: 'config',
      command: acpBin,
    })
    expect(await admin.check('acp')).toMatchObject({ ok: true, choice: { id: 'acp', status: 'unverified' } })
  })

  it('配置了不存在的命令时判 not-installed', async () => {
    const dir = home()
    const cfg = config()
    cfg.runtime.options = { acp: { command: join(dir, 'nope') } }
    const snapshot = await new AcpRuntimeAdmin({
      home: dir,
      env: { ...process.env, PATH: join(dir, 'bin') },
      config: cfg,
    }).detect()
    const acp = snapshot.choices.find(choice => choice.id === 'acp')
    expect(acp?.status).toBe('not-installed')
    expect(acp?.reason).toContain('找不到命令')
  })
})
