import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultConfig } from '../../src/config.js'
import type { CommandRunner } from '#infra/process.js'
import {
  codexAppOptionsOf,
  detectCodexBinary,
  probeCodexHandshake,
  resolveCodexBinary,
} from '@router-agent/runtime-codex'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'ra-codex-detect-'))
}

function touch(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '#!/bin/sh\nexit 0\n', 'utf8')
  chmodSync(path, 0o755)
  return path
}

describe('Codex 二进制发现', () => {
  it('优先使用 Codex App bundle，其次 PATH', () => {
    const dir = home()
    const app = touch(join(dir, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'))
    const pathBin = touch(join(dir, 'bin', 'codex'))
    const byApp = resolveCodexBinary({ home: dir, env: { PATH: join(dir, 'bin') }, platform: 'darwin' })
    expect(byApp).toMatchObject({ command: app, source: 'app' })

    const noApp = resolveCodexBinary({ home: join(dir, 'empty'), env: { PATH: join(dir, 'bin') }, platform: 'darwin' })
    expect(noApp).toMatchObject({ command: pathBin, source: 'path' })
  })

  it('显式配置 > 环境变量 > App > PATH', () => {
    const dir = home()
    const explicit = touch(join(dir, 'explicit', 'codex'))
    const envBin = touch(join(dir, 'env', 'codex'))
    const app = touch(join(dir, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'))
    const pathBin = touch(join(dir, 'bin', 'codex'))

    expect(resolveCodexBinary({ home: dir, command: explicit, env: { CODEX_BIN: envBin, PATH: join(dir, 'bin') }, platform: 'darwin' }))
      .toMatchObject({ command: explicit, source: 'config' })
    expect(resolveCodexBinary({ home: dir, env: { CODEX_BIN: envBin, PATH: join(dir, 'bin') }, platform: 'darwin' }))
      .toMatchObject({ command: envBin, source: 'env' })
    expect(resolveCodexBinary({ home: dir, env: { PATH: join(dir, 'bin') }, platform: 'darwin' }))
      .toMatchObject({ command: app, source: 'app' })
    expect(resolveCodexBinary({ home: dir, env: { PATH: join(dir, 'bin') }, platform: 'linux' }))
      .toMatchObject({ command: pathBin, source: 'path' })
  })

  it('都找不到时返回 missing + 安装提示', () => {
    const dir = home()
    const result = resolveCodexBinary({ home: dir, env: { PATH: join(dir, 'bin') }, platform: 'darwin' })
    expect(result).toMatchObject({ source: 'missing' })
    expect(result.installHint).toContain('Codex App')
    expect(result.installUrl).toContain('chatgpt.com/codex')
    expect(result.reason).toContain('未找到')
  })

  it('逐个探测候选，跳过不兼容版本', async () => {
    const dir = home()
    const broken = touch(join(dir, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'))
    const good = touch(join(dir, 'bin', 'codex'))
    const runner = (bin: string): CommandRunner => ({
      async run(argv) {
        if (bin === broken) return { code: 1, stdout: '', stderr: 'bad version' }
        if (argv[0] === '--version') return { code: 0, stdout: 'codex-cli 0.166.0\n', stderr: '' }
        return { code: 0, stdout: 'app-server help', stderr: '' }
      },
    })
    const result = await detectCodexBinary({
      home: dir,
      env: { PATH: join(dir, 'bin') },
      platform: 'darwin',
      runner,
    })
    expect(result).toMatchObject({ command: good, source: 'path', compatible: true, version: '0.166.0' })
  })
})

describe('codex-app 配置', () => {
  it('默认 full + never + 联网', () => {
    expect(codexAppOptionsOf(defaultConfig())).toMatchObject({
      permissions: 'full',
      approvalPolicy: 'never',
      network: true,
    })
  })

  it('读取 runtime.options.codex-app.env，只保留字符串值', () => {
    const config = defaultConfig()
    config.runtime.options = {
      'codex-app': {
        env: { CODEX_HOME: '/tmp/codex-home', COUNT: 7, FLAG: true },
      },
    }
    expect(codexAppOptionsOf(config).env).toEqual({ CODEX_HOME: '/tmp/codex-home' })
  })

  it('支持 workspace / on-request / 模型与显式命令', () => {
    const config = defaultConfig()
    config.runtime.options = {
      'codex-app': {
        command: '/opt/codex',
        model: 'gpt-6.1-sol',
        modelProvider: 'ep',
        permissions: 'workspace',
        approvalPolicy: 'on-request',
        network: false,
      },
    }
    expect(codexAppOptionsOf(config)).toMatchObject({
      command: '/opt/codex',
      model: 'gpt-6.1-sol',
      modelProvider: 'ep',
      permissions: 'workspace',
      approvalPolicy: 'on-request',
      network: false,
    })
  })
})

describe('probeCodexHandshake', () => {
  it('initialize 成功返回 userAgent；无响应超时失败', async () => {
    const dir = home()
    const ok = touch(join(dir, 'ok-codex'))
    writeFileSync(ok, '#!/bin/sh\nread line\necho \'{"id":1,"result":{"userAgent":"fake/0.0.0"}}\'\n', 'utf8')
    chmodSync(ok, 0o755)
    const success = await probeCodexHandshake({ command: ok, cwd: dir, timeoutMs: 1_000 })
    expect(success).toMatchObject({ ok: true, userAgent: 'fake/0.0.0' })

    const silent = touch(join(dir, 'silent-codex'))
    writeFileSync(silent, '#!/bin/sh\nsleep 5\n', 'utf8')
    chmodSync(silent, 0o755)
    const timeout = await probeCodexHandshake({ command: silent, cwd: dir, timeoutMs: 200 })
    expect(timeout.ok).toBe(false)
    expect(timeout.reason).toContain('超时')
  })
})