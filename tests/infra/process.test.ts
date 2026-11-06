import { describe, expect, it } from 'vitest'
import { realRunner } from '../../src/infra/process.js'

describe('realRunner', () => {
  it('支持通过 stdin 传入敏感内容，避免出现在 argv', async () => {
    const runner = realRunner('cat')
    const res = await runner.run([], { input: 'super-secret\n' })
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('super-secret\n')
  })

  it('命令不存在时返回 127 而不是抛错', async () => {
    const runner = realRunner('definitely-not-a-command-ra')
    const res = await runner.run([])
    expect(res.code).toBe(127)
    expect(res.stderr.length).toBeGreaterThan(0)
  })

  it('返回码与 stderr 原样透出', async () => {
    const runner = realRunner('sh')
    const res = await runner.run(['-c', 'echo oops >&2; exit 3'])
    expect(res.code).toBe(3)
    expect(res.stderr).toContain('oops')
  })
})