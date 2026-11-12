import { describe, expect, it } from 'vitest'
import {
  UpdateService,
  type LatestVersionResult,
  type UpgradeResult,
} from '../../src/update/index.js'
import type { Logger } from '../../src/infra/logger.js'

function captureLogger(): { logger: Logger; events: { level: string; message: string; extra: Record<string, unknown> }[] } {
  const events: { level: string; message: string; extra: Record<string, unknown> }[] = []
  const push = (level: string) => (message: string, extra: Record<string, unknown> = {}) => {
    events.push({ level, message, extra })
  }
  return { events, logger: { info: push('info'), warn: push('warn'), error: push('error') } }
}

function upgradeResult(over: Partial<UpgradeResult> = {}): UpgradeResult {
  return { ok: true, command: 'npm install -g router-agent@latest', code: 0, stdout: '', stderr: '', ...over }
}

function latest(version: string): LatestVersionResult {
  return { version, checkedAt: '2026-11-09T10:00:00.000Z' }
}

describe('UpdateService', () => {
  it('检查到新版本后标记 hasUpdate，并记录检查事件', async () => {
    const { logger, events } = captureLogger()
    const service = new UpdateService({
      current: '0.3.0',
      logger,
      fetchLatest: async () => latest('0.4.0'),
    })

    const snapshot = await service.check()

    expect(snapshot).toMatchObject({
      current: '0.3.0',
      latest: '0.4.0',
      hasUpdate: true,
      phase: 'idle',
      error: null,
      checkedAt: '2026-11-09T10:00:00.000Z',
    })
    expect(events).toEqual([
      { level: 'info', message: 'update:checked', extra: { current: '0.3.0', latest: '0.4.0', hasUpdate: true } },
    ])
  })

  it('缓存期内不重复请求 registry，force 才重新检查', async () => {
    let calls = 0
    let now = 1_000_000
    const service = new UpdateService({
      current: '0.3.0',
      now: () => now,
      fetchLatest: async () => {
        calls += 1
        return latest('0.4.0')
      },
    })

    await service.check()
    now += 60_000
    await service.check()
    expect(calls).toBe(1)

    await service.check(true)
    expect(calls).toBe(2)
  })

  it('检查失败写 warn 日志并保留可读原因，失败后按较短间隔重试', async () => {
    const { logger, events } = captureLogger()
    let calls = 0
    let now = 1_000_000
    const service = new UpdateService({
      current: '0.3.0',
      logger,
      now: () => now,
      fetchLatest: async () => {
        calls += 1
        throw new Error('connect ECONNREFUSED')
      },
    })

    const snapshot = await service.check()
    expect(snapshot.error).toBe('check-failed')
    expect(snapshot.message).toContain('ECONNREFUSED')
    expect(events.at(-1)).toMatchObject({ level: 'warn', message: 'update:check-failed' })
    expect(events.at(-1)?.extra.message).toContain('ECONNREFUSED')

    // 30 分钟内的普通 check 走失败缓存，不再打 registry。
    now += 10 * 60_000
    await service.check()
    expect(calls).toBe(1)
    now += 25 * 60_000
    await service.check()
    expect(calls).toBe(2)
  })

  it('升级成功后进入 updated，安装版本与运行版本分开记录', async () => {
    const { logger, events } = captureLogger()
    const installed: string[] = []
    const service = new UpdateService({
      current: '0.3.0',
      logger,
      isGlobalInstall: () => true,
      fetchLatest: async () => latest('0.4.0'),
      runUpgrade: async ({ version }) => {
        installed.push(version)
        return upgradeResult()
      },
    })

    const snapshot = await service.upgrade()

    expect(installed).toEqual(['0.4.0'])
    expect(snapshot).toMatchObject({
      current: '0.3.0',
      latest: '0.4.0',
      installedVersion: '0.4.0',
      hasUpdate: false,
      phase: 'updated',
      error: null,
    })
    expect(events.map(event => event.message)).toContain('update:upgrade-started')
    expect(events.at(-1)?.message).toBe('update:upgraded')
    expect(events.at(-1)?.extra).toMatchObject({ from: '0.3.0', to: '0.4.0' })
  })

  it('安装失败写 error 日志，并把 npm 错误摘要留给面板', async () => {
    const { logger, events } = captureLogger()
    const service = new UpdateService({
      current: '0.3.0',
      logger,
      isGlobalInstall: () => true,
      fetchLatest: async () => latest('0.4.0'),
      runUpgrade: async () => upgradeResult({ ok: false, code: 1, stderr: 'npm ERR! code EACCES permission denied' }),
    })

    const snapshot = await service.upgrade()

    expect(snapshot).toMatchObject({ phase: 'failed', error: 'install-failed', hasUpdate: true })
    expect(snapshot.message).toContain('permission denied')
    expect(events.at(-1)).toMatchObject({ level: 'error', message: 'update:upgrade-failed' })
    expect(events.at(-1)?.extra).toMatchObject({ from: '0.3.0', to: '0.4.0', code: 1 })
  })

  it('安装超时时写明是超时，不退化成「npm 退出码 1」', async () => {
    const { logger, events } = captureLogger()
    const service = new UpdateService({
      current: '0.3.0',
      logger,
      isGlobalInstall: () => true,
      fetchLatest: async () => latest('0.4.0'),
      runUpgrade: async () => upgradeResult({
        ok: false,
        code: 1,
        stdout: '',
        stderr: '',
        timedOut: true,
        signal: 'SIGKILL',
        timeoutMs: 300_000,
      }),
    })

    const snapshot = await service.upgrade()

    expect(snapshot).toMatchObject({ phase: 'failed', error: 'install-timeout' })
    expect(snapshot.message).toContain('超时')
    expect(snapshot.message).toContain('SIGKILL')
    expect(events.at(-1)).toMatchObject({ level: 'error', message: 'update:upgrade-failed' })
    expect(events.at(-1)?.extra).toMatchObject({ timedOut: true, signal: 'SIGKILL', timeoutMs: 300_000 })
  })

  it('源码 / link 运行默认拒绝全局安装，force 才继续', async () => {
    const { logger, events } = captureLogger()
    let installed = 0
    const service = new UpdateService({
      current: '0.3.0',
      logger,
      isGlobalInstall: () => false,
      fetchLatest: async () => latest('0.4.0'),
      runUpgrade: async () => {
        installed += 1
        return upgradeResult()
      },
    })

    const refused = await service.upgrade()
    expect(refused).toMatchObject({ phase: 'failed', error: 'not-global-install' })
    expect(installed).toBe(0)
    expect(events.at(-1)).toMatchObject({ level: 'warn', message: 'update:skipped' })

    const forced = await service.upgrade({ force: true })
    expect(forced.phase).toBe('updated')
    expect(installed).toBe(1)
  })

  it('已是最新版本时不执行 npm', async () => {
    let installed = 0
    const service = new UpdateService({
      current: '0.3.0',
      fetchLatest: async () => latest('0.3.0'),
      runUpgrade: async () => {
        installed += 1
        return upgradeResult()
      },
    })

    const snapshot = await service.upgrade()
    expect(snapshot.phase).toBe('idle')
    expect(snapshot.message).toContain('已是最新版本')
    expect(installed).toBe(0)
  })

  it('检查失败时不会继续安装', async () => {
    let installed = 0
    const service = new UpdateService({
      current: '0.3.0',
      fetchLatest: async () => {
        throw new Error('offline')
      },
      runUpgrade: async () => {
        installed += 1
        return upgradeResult()
      },
    })

    const snapshot = await service.upgrade()
    expect(snapshot.error).toBe('check-failed')
    expect(installed).toBe(0)
  })
})
