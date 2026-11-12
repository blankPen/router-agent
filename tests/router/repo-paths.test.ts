import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRepoPathResolver } from '../../src/router/repo-paths.js'
import type { CommandRunner } from '../../src/infra/process.js'

describe('项目路径解析', () => {
  it('orca 查询带超时，卡住也不能拖死 intake 的串行处理', async () => {
    const calls: { argv: string[]; timeoutMs?: number }[] = []
    const orca: CommandRunner = {
      async run(argv, opts) {
        calls.push({ argv, timeoutMs: opts?.timeoutMs })
        return { code: 0, stdout: '[]', stderr: '' }
      },
    }
    const resolve = createRepoPathResolver({ orca })
    await resolve('name:dsh/router-agent')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv).toEqual(['repo', 'list', '--json'])
    expect(calls[0]?.timeoutMs).toBeGreaterThan(0)
  })

  it('orca 查询失败时退化：解析不到路径，按纯对话分析处理', async () => {
    const orca: CommandRunner = {
      async run() {
        throw new Error('orca unavailable')
      },
    }
    const resolve = createRepoPathResolver({ orca })
    expect(await resolve('name:dsh/router-agent')).toBeUndefined()
  })

  it('path: 与绝对路径不需要 orca 也能解析', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ra-repo-'))
    try {
      const resolve = createRepoPathResolver()
      expect(await resolve(`path:${root}`)).toBe(root)
      expect(await resolve(root)).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
