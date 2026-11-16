/**
 * ra start 在开放监听时：打印局域网地址、令牌落到配置里。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli, type CliIo } from '../../src/cli/index.js'
import { loadConfig } from '../../src/config.js'

function io(homeDir: string): CliIo & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    stdout: line => out.push(line),
    stderr: line => err.push(line),
    env: { RA_HOME: homeDir },
  }
}

const running: Array<() => Promise<void>> = []
afterEach(async () => {
  while (running.length > 0) await running.pop()!()
})

describe('ra start 的面板地址', () => {
  it('只监听本机时给回环地址', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ra-cli-net-'))
    await runCli(['init', '--home', dir, '--yes'], io(dir))
    // 假装服务已在运行，避免真的拉起进程。
    writeFileSync(join(dir, 'router-agent.pid'), String(process.pid))

    const output = io(dir)
    output.openUrl = () => true
    expect(await runCli(['start', '--no-open', '--home', dir], output)).toBe(0)
    expect(output.out.join('\n')).toContain('Web 面板: http://127.0.0.1:3083/#setup')
  })

  it('开放监听时打印局域网地址，并把令牌写进配置', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ra-cli-net-'))
    await runCli(['init', '--home', dir, '--yes'], io(dir))
    const configPath = join(dir, 'config.yaml')
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace(
      'host: 127.0.0.1',
      'host: 0.0.0.0',
    ))
    writeFileSync(join(dir, 'router-agent.pid'), String(process.pid))

    const output = io(dir)
    output.openUrl = () => true
    expect(await runCli(['start', '--no-open', '--home', dir], output)).toBe(0)

    const text = output.out.join('\n')
    expect(text).toMatch(/Web 面板: http:\/\/192\.168\.|Web 面板: http:\/\/10\.|Web 面板: http:\/\/172\./)
    expect(text).toContain('token=')

    // 令牌落到配置里：重启后地址依然有效。
    const token = loadConfig(dir).server.token
    expect(token).not.toBe('')
    expect(text).toContain(encodeURIComponent(token))
  })
})
