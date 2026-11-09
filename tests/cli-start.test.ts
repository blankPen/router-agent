import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli, type CliIo } from '../src/cli/index.js'

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

async function initHome(dir: string): Promise<void> {
  const output = io(dir)
  const code = await runCli(['init', '--home', dir, '--agents-dir', join(dir, '.claude/agents'), '--yes'], output)
  expect(code).toBe(0)
}

/** 占一个本机端口并起一个最小 /api/status 服务，模拟已就绪的 Router。 */
async function stubRouter(): Promise<{ port: number; server: Server; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/status')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('未能获取测试端口')
  return {
    port: address.port,
    server,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

const running: Array<() => Promise<void>> = []
afterEach(async () => {
  while (running.length > 0) await running.pop()!()
})

async function setupRunning(): Promise<{ dir: string; port: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'ra-cli-start-'))
  await initHome(dir)
  const stub = await stubRouter()
  running.push(stub.close)
  // 把端口改成测试端口，并把当前进程写成 pid：cmdStart 会走「已在运行」分支。
  writeFileSync(join(dir, 'config.yaml'), readFileSync(join(dir, 'config.yaml'), 'utf8').replace('port: 3083', `port: ${stub.port}`))
  writeFileSync(join(dir, 'router-agent.pid'), String(process.pid))
  return { dir, port: stub.port }
}

describe('ra start 打开 Web 初始化页', () => {
  it('服务已在运行时打开 #setup 并打印地址', async () => {
    const { dir, port } = await setupRunning()
    const output = io(dir)
    const opened: string[] = []
    output.openUrl = url => {
      opened.push(url)
      return true
    }

    expect(await runCli(['start', '--home', dir], output)).toBe(0)
    const url = `http://127.0.0.1:${port}/#setup`
    expect(opened).toEqual([url])
    expect(output.out.join('\n')).toContain(`Web 面板: ${url}`)
    expect(output.out.join('\n')).toContain('已在浏览器打开 Web 面板')
  })

  it('--no-open 只打印地址，不拉起浏览器', async () => {
    const { dir, port } = await setupRunning()
    const output = io(dir)
    const opened: string[] = []
    output.openUrl = url => {
      opened.push(url)
      return true
    }

    expect(await runCli(['start', '--no-open', '--home', dir], output)).toBe(0)
    expect(opened).toEqual([])
    expect(output.out.join('\n')).toContain(`Web 面板: http://127.0.0.1:${port}/#setup`)
  })
})