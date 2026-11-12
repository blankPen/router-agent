import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Ticket } from '#core/model.js'
import { buildNeutralContract, buildWorkerPrompt } from '#runtime/spec/index.js'
import { bundledWorkerSpecPath, readWorkerSpec, workerSpecPath } from '#runtime/spec/reader.js'

const ticket = {
  id: 'tk-1',
  title: '调整登录超时',
  threadId: 't',
  source: 'feishu',
  chatId: 'c',
  mandateId: 'm',
  stage: 'running',
  repo: 'demo/repo',
  branch: 'main',
  prNumber: 0,
  prUrl: '',
  prState: 'none',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as Ticket

const base = {
  mandateScope: '只改登录超时',
  statePath: '/tmp/s.json',
  eventsPath: '/tmp/e.log',
  repo: 'demo/repo',
}

describe('Worker 规范模板（runtime 包自带）', () => {
  it('不传 home 时读取随包模板', () => {
    expect(readWorkerSpec(undefined, 'prompt-mode.md')).toContain('ra report')
    expect(bundledWorkerSpecPath('contract.md')).toContain('spec/contract.md')
  })

  it('home 下有覆盖文件时优先用覆盖内容', () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-spec-'))
    mkdirSync(join(home, 'specs', 'worker'), { recursive: true })
    writeFileSync(workerSpecPath(home, 'prompt-mode.md'), '自定义手册：{{title}} / {{scope}}', 'utf8')
    expect(buildWorkerPrompt({ ...base, ticket, home })).toBe('自定义手册：调整登录超时 / 只改登录超时')
  })

  it('中立契约走同一套覆盖机制', () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-spec-'))
    mkdirSync(join(home, 'specs', 'worker'), { recursive: true })
    writeFileSync(workerSpecPath(home, 'contract.md'), '契约 {{ticketId}} @ {{workBranch}}', 'utf8')
    expect(buildNeutralContract({
      ticketId: 'tk-1',
      title: '调整登录超时',
      scope: '只改登录超时',
      repo: 'demo/repo',
      workBranch: 'ra/tk-1',
      statePath: '/tmp/s.json',
      eventsPath: '/tmp/e.log',
      home,
    })).toBe('契约 tk-1 @ ra/tk-1')
  })

  it('覆盖文件读不到时回落到内置模板', () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-spec-'))
    expect(readWorkerSpec(home, 'contract.md')).toContain('ra report')
  })
})
