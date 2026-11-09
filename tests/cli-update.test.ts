import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, type CliIo } from '../src/cli/index.js'
import { PACKAGE_VERSION } from '../src/update/index.js'
import type { CommandResult, CommandRunner } from '../src/infra/process.js'

function io(): CliIo & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    stdout: line => out.push(line),
    stderr: line => err.push(line),
    env: { RA_HOME: join(tmpdir(), 'ra-cli-update-safety') },
  }
}

function home(): string {
  return mkdtempSync(join(tmpdir(), 'ra-update-'))
}

interface Registry {
  url: string
  hits: () => number
  close: () => Promise<void>
}

/** 本地假 registry：任意路径都返回 latest dist-tag。 */
async function registry(version: string): Promise<Registry> {
  let hits = 0
  const server = createServer((_req, res) => {
    hits += 1
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ name: 'router-agent', version }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/`,
    hits: () => hits,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

function npmRunner(result: Partial<CommandResult> = {}): CommandRunner & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    run: async argv => {
      calls.push(argv)
      return { code: 0, stdout: 'added 1 package', stderr: '', ...result }
    },
  }
}

describe('ra update', () => {
  it('--check --json 只输出版本快照、不打 registry 缓存', async () => {
    const reg = await registry('9.9.9')
    try {
      const output = io()
      const code = await runCli(['update', '--check', '--json', '--registry', reg.url, '--home', home()], output)

      expect(code).toBe(0)
      expect(output.out).toHaveLength(1)
      expect(JSON.parse(output.out[0]!)).toMatchObject({
        current: PACKAGE_VERSION,
        latest: '9.9.9',
        hasUpdate: true,
        phase: 'idle',
      })
      expect(reg.hits()).toBe(1)
    } finally {
      await reg.close()
    }
  })

  it('已是最新版本时明确提示', async () => {
    const reg = await registry(PACKAGE_VERSION)
    try {
      const output = io()
      const code = await runCli(['update', '--check', '--registry', reg.url, '--home', home()], output)
      expect(code).toBe(0)
      expect(output.out.join('\n')).toContain('已是最新版本')
    } finally {
      await reg.close()
    }
  })

  it('升级执行 npm install -g 并记录结果', async () => {
    const reg = await registry('9.9.9')
    try {
      const dir = home()
      const output = io()
      const npm = npmRunner()
      output.npm = npm

      const code = await runCli(['update', '--json', '--force', '--no-restart', '--registry', reg.url, '--home', dir], output)

      expect(code).toBe(0)
      expect(npm.calls).toEqual([
        ['install', '-g', 'router-agent@9.9.9', '--no-fund', '--no-audit', '--loglevel=error'],
      ])
      expect(JSON.parse(output.out[0]!)).toMatchObject({
        phase: 'updated',
        installedVersion: '9.9.9',
        hasUpdate: false,
      })
      // 日志落文件，JSON 输出不被污染。
      const log = readFileSync(join(dir, 'logs', 'router-agent.log'), 'utf8')
      expect(log).toContain('"message":"update:upgrade-started"')
      expect(log).toContain('"message":"update:upgraded"')
      expect(existsSync(join(dir, 'logs', 'router-agent.log'))).toBe(true)
    } finally {
      await reg.close()
    }
  })

  it('npm 安装失败时返回非 0 并带上错误摘要', async () => {
    const reg = await registry('9.9.9')
    try {
      const output = io()
      output.npm = npmRunner({ code: 1, stdout: '', stderr: 'npm ERR! code EACCES permission denied' })

      const code = await runCli(['update', '--force', '--no-restart', '--registry', reg.url, '--home', home()], output)

      expect(code).toBe(1)
      expect(output.err.join('\n')).toContain('安装失败')
      expect(output.err.join('\n')).toContain('permission denied')
    } finally {
      await reg.close()
    }
  })

  it('--no-restart 在未运行服务时直接提示跳过', async () => {
    const reg = await registry('9.9.9')
    try {
      const output = io()
      output.npm = npmRunner()

      const code = await runCli(['update', '--force', '--no-restart', '--registry', reg.url, '--home', home()], output)

      expect(code).toBe(0)
      expect(output.out.join('\n')).toContain('跳过重启')
    } finally {
      await reg.close()
    }
  })
})