import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, type CliIo } from '../../src/cli/index.js'

function io(): CliIo & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    stdout: line => out.push(line),
    stderr: line => err.push(line),
    env: { RA_HOME: join(tmpdir(), 'ra-node-cli') },
  }
}

function homeWith(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ra-node-cli-'))
  writeFileSync(join(dir, 'config.yaml'), yaml, 'utf8')
  return dir
}

describe('多设备节点 CLI', () => {
  it('ra nodes 在中心没启动时也能列出登记的设备', async () => {
    const dir = homeWith(`
nodes:
  enabled: true
  devices:
    - id: macbook-air
      name: MacBook Air
      token: "secret-air"
      projects:
        - name: router-agent
          key: router-agent
`)
    const output = io()
    expect(await runCli(['nodes', '--home', dir, '--port', '1'], output)).toBe(0)
    expect(output.out.join('\n')).toContain('macbook-air')
    expect(output.out.join('\n')).toContain('离线')
    expect(output.out.join('\n')).toContain('router-agent')
  })

  it('ra nodes --json 输出结构化节点状态', async () => {
    const dir = homeWith(`
nodes:
  enabled: true
  devices:
    - id: macbook-air
      token: "secret-air"
`)
    const output = io()
    expect(await runCli(['nodes', '--home', dir, '--port', '1', '--json'], output)).toBe(0)
    const parsed = JSON.parse(output.out.join('\n')) as { nodes: Array<{ nodeId: string }> }
    expect(parsed.nodes[0]!.nodeId).toBe('macbook-air')
  })

  it('ra node 缺少节点密钥时说明缺什么', async () => {
    const dir = homeWith(`
nodes:
  enabled: true
  nodeId: macbook-air
  server: "http://127.0.0.1:3083"
`)
    const output = io()
    expect(await runCli(['node', '--home', dir], output)).toBe(2)
    expect(output.err.join('\n')).toContain('nodes.token')
  })

  it('ra node 未启用多设备时直接说明', async () => {
    const dir = homeWith('server:\n  port: 3083\n')
    const output = io()
    expect(await runCli(['node', '--home', dir], output)).toBe(2)
    expect(output.err.join('\n')).toContain('nodes.enabled')
  })

  it('ra relay 缺少接入密钥时拒绝启动', async () => {
    const dir = homeWith('server:\n  port: 3083\n')
    const output = io()
    expect(await runCli(['relay', '--home', dir], output)).toBe(2)
    expect(output.err.join('\n')).toContain('中继密钥')
  })
})
