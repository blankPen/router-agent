import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLogger, type CliIo } from '../../src/cli/index.js'

function io(): CliIo {
  return { stdout: () => {}, stderr: () => {}, env: {} }
}

/** 建一个能写日志的 home；日志目录由调用方（ensureHome）负责创建。 */
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ra-logger-'))
  mkdirSync(join(dir, 'logs'), { recursive: true })
  return dir
}

function written(dir: string): Record<string, unknown> {
  const raw = readFileSync(join(dir, 'logs', 'router-agent.log'), 'utf8').trim()
  return JSON.parse(raw) as Record<string, unknown>
}

describe('服务日志行结构', () => {
  it('事件名拆成 domain 与 event，业务字段保持平铺', () => {
    const dir = home()
    createLogger(dir, io(), false).info('trigger:ingested', { id: 'trg-1', chat: 'oc_1' })

    expect(written(dir)).toMatchObject({
      level: 'info',
      domain: 'trigger',
      event: 'ingested',
      message: 'trigger:ingested',
      id: 'trg-1',
      chat: 'oc_1',
    })
  })

  it('从工单等可定位字段推出链路 ID', () => {
    const dir = home()
    createLogger(dir, io(), false).warn('worker:status-failed', { ticketId: 'tk-84', reason: '超时' })

    expect(written(dir)).toMatchObject({
      level: 'warn',
      domain: 'worker',
      event: 'status-failed',
      trace: 'tk-84',
    })
  })

  it('业务字段里的 message 改写成 detail，事件名不被冲掉', () => {
    const dir = home()
    createLogger(dir, io(), false).error('update:upgrade-failed', { message: 'npm ERR! code EACCES' })

    expect(written(dir)).toMatchObject({
      domain: 'update',
      event: 'upgrade-failed',
      message: 'update:upgrade-failed',
      detail: 'npm ERR! code EACCES',
    })
  })

  it('没有可定位字段时不写链路 ID', () => {
    const dir = home()
    createLogger(dir, io(), false).info('api:listening', { port: 8787 })

    expect(written(dir)).not.toHaveProperty('trace')
  })
})
