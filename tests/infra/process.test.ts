import { describe, expect, it } from 'vitest'
import { realRunner } from '#infra/process.js'

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

  it('超时时标记 timedOut 与信号，不让调用方误判成命令自身报错', async () => {
    const runner = realRunner('sh')
    const res = await runner.run(['-c', 'sleep 5'], { timeoutMs: 120 })
    expect(res.timedOut).toBe(true)
    expect(res.signal).toBe('SIGKILL')
    // 退出码是兜底值，真实原因在 timedOut / signal 里。
    expect(res.code).toBe(1)
  })

  it('正常退出不带 timedOut 标记', async () => {
    const runner = realRunner('sh')
    const res = await runner.run(['-c', 'exit 0'], { timeoutMs: 5_000 })
    expect(res.timedOut).toBe(false)
    expect(res.signal ?? null).toBe(null)
  })
})
