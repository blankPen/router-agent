import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CliIo } from '../../src/cli/index.js'

// 身份装配整体失败只发生在 CLI 的守护逻辑里（`resolveRuntimeIdentitySafely`），
// 且这个函数不导出。这里把解析器本身替换成必然失败，用 `ra simulate` 走到同一条兜底链路，
// 断言 error 事件确实带着事件名与 detail 落盘。
vi.mock('@router-agent/channel-feishu', async importOriginal => {
  const actual = await importOriginal<typeof import('@router-agent/channel-feishu')>()
  return {
    ...actual,
    resolveRuntimeIdentity: async () => {
      throw new Error('模拟身份装配失败：通讯录不可用')
    },
  }
})

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

function home(): string {
  return mkdtempSync(join(tmpdir(), 'ra-identity-failed-'))
}

/** 最小配置：模型段只为通过 simulate 的模型校验；准入设成 ignore，避免真的发起模型请求。 */
function writeConfig(dir: string): void {
  writeFileSync(join(dir, 'config.yaml'), JSON.stringify({
    llm: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test-key', model: 'test-model' },
    feishu: {
      appId: 'cli_a',
      allowed: ['ou_alice'],
      chats: [{ chat: 'oc_1', scope: 'mention' }],
    },
    policy: { admission: { unlistedAddressed: 'ignore' } },
  }), 'utf8')
}

describe('config:identity-resolve-failed', () => {
  it('身份装配整体失败时写 error 事件，事件名与 detail 都落盘', async () => {
    const dir = home()
    writeConfig(dir)
    // 动态导入：vi.mock 已生效，runCli 内部拿到的就是会抛错的身份解析器。
    const { runCli } = await import('../../src/cli/index.js')
    const output = io(dir)

    const code = await runCli([
      'simulate', '--text', '你好', '--chat', 'oc_1', '--actor', 'ou_unknown', '--dry-run', '--home', dir,
    ], output)

    // 装配失败不能挡住命令：simulate 仍然继续按原始配置跑。
    expect(code).toBe(0)

    const lines = readFileSync(join(dir, 'logs', 'router-agent.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { level: string; message: string; detail?: string })
    const failed = lines.find(line => line.message === 'config:identity-resolve-failed')
    expect(failed?.level).toBe('error')
    expect(failed?.detail).toContain('模拟身份装配失败')
  })
})
