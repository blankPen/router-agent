import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installAcpAgent, uninstallAcpAgent } from '@router-agent/runtime-acp'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'ra-acp-install-'))
}

/** 模拟 npm install：在 --prefix 下造出 bin 与 package.json。 */
async function fakeNpm(args: string[], opts: {
  onLine: (line: string) => void
}): Promise<number> {
  const prefixIndex = args.indexOf('--prefix')
  const prefix = args[prefixIndex + 1]!
  const spec = args.at(-1) ?? ''
  const [name, version = '0.0.0'] = spec.startsWith('@')
    ? [spec.slice(0, spec.lastIndexOf('@')), spec.slice(spec.lastIndexOf('@') + 1)]
    : [spec.slice(0, spec.lastIndexOf('@')), spec.slice(spec.lastIndexOf('@') + 1)]
  const binDir = join(prefix, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  const bin = join(binDir, 'codex-acp')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', 'utf8')
  chmodSync(bin, 0o755)
  const pkgDir = join(prefix, 'node_modules', name)
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version }), 'utf8')
  opts.onLine(`added ${name}@${version}`)
  return 0
}

describe('ACP 按需安装', () => {
  it('pinned 版本安装到 runtimes/<agent>，并写 manifest', async () => {
    const dir = home()
    const result = await installAcpAgent({ home: dir, agentId: 'acp-codex', runNpm: fakeNpm })
    expect(result.ok).toBe(true)
    expect(result.version).toBe('1.11.0')
    const target = join(dir, 'runtimes', 'codex')
    expect(existsSync(join(target, 'node_modules', '.bin', 'codex-acp'))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(target, 'ra-runtime.json'), 'utf8')) as { runtimeId: string; version: string }
    expect(manifest).toMatchObject({ runtimeId: 'acp-codex', version: '1.11.0' })
  })

  it('拒绝未知 agent / 不支持的版本', async () => {
    const dir = home()
    expect((await installAcpAgent({ home: dir, agentId: 'nope', runNpm: fakeNpm })).ok).toBe(false)
    expect((await installAcpAgent({ home: dir, agentId: 'acp-codex', version: '9.9.9', runNpm: fakeNpm })).ok).toBe(false)
  })

  it('npm 失败时不落地目标目录', async () => {
    const dir = home()
    const result = await installAcpAgent({
      home: dir,
      agentId: 'acp-codex',
      runNpm: async () => 1,
    })
    expect(result.ok).toBe(false)
    expect(existsSync(join(dir, 'runtimes', 'codex'))).toBe(false)
  })

  it('同一 agent 并发安装返回忙碌，不覆盖已有目录', async () => {
    const dir = home()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = installAcpAgent({
      home: dir,
      agentId: 'acp-codex',
      runNpm: async (args, opts) => {
        await gate
        return fakeNpm(args, opts)
      },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    const second = await installAcpAgent({ home: dir, agentId: 'acp-codex', runNpm: fakeNpm })
    expect(second.ok).toBe(false)
    expect(second.error).toContain('已有')
    release()
    expect((await first).ok).toBe(true)
  })

  it('卸载只删 managed 目录', async () => {
    const dir = home()
    expect((await installAcpAgent({ home: dir, agentId: 'acp-codex', runNpm: fakeNpm })).ok).toBe(true)
    const result = await uninstallAcpAgent({ home: dir, agentId: 'codex' })
    expect(result.ok).toBe(true)
    expect(existsSync(join(dir, 'runtimes', 'codex'))).toBe(false)
  })
})