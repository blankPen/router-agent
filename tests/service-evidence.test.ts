import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store/db.js'
import { Engine } from '../src/core/engine.js'
import { RouterService } from '../src/service.js'
import { defaultConfig, policyOf, type AppConfig } from '../src/config.js'
import type { WorkerRuntime } from '#runtime/port.js'
import type { PrInfo } from '../src/sources/github.js'
import { ReportRejectedError, type UiEvidenceMode } from '#runtime/evidence-gate.js'
import { parseStateFile, type WorkerStateFile } from '#runtime/report-poller.js'

class GatePrTracker {
  body: string | undefined = ''
  calls: { repo: string; number: number }[] = []
  async view(repo: string, number: number): Promise<PrInfo | null> {
    this.calls.push({ repo, number })
    return {
      number,
      url: `https://github.com/o/r/pull/${number}`,
      state: 'open',
      title: 't',
      branch: 'b',
      ...(this.body !== undefined ? { body: this.body } : {}),
    }
  }
  async findByBranch() {
    return null
  }
}

const runtime = {
  id: 'orca',
  capabilities: { agent: {}, workspace: {} },
} as unknown as WorkerRuntime

const TICKET_ID = 'tk_1'
const ASSIGNMENT_ID = 'as_1'

function makeService(mode: UiEvidenceMode, opts: { workdirExists?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ra-gate-'))
  const workdir = opts.workdirExists === false
    ? join(home, 'missing-workdir')
    : mkdtempSync(join(tmpdir(), 'ra-gate-wt-'))
  const config: AppConfig = { ...defaultConfig(), home }
  config.worker.evidence.ui = mode
  const store = new Store(':memory:')
  const engine = new Engine({ store, policy: policyOf(config), clock: { now: () => '2026-11-06T10:00:00.000Z' } })
  store.insertMandate({
    id: 'md_1',
    ticketId: TICKET_ID,
    policyVersion: 'v1',
    strength: 'explicit',
    scope: '改登录超时',
    rules: [],
    actorId: 'ou_alice',
    actorName: 'Alice',
    source: 'feishu',
    chatId: 'oc_dev',
    threadId: 'feishu:oc_dev:om_root',
    createdAt: '2026-11-06T09:59:00.000Z',
  })
  store.insertTicket({
    id: TICKET_ID,
    title: '改登录超时',
    threadId: 'feishu:oc_dev:om_root',
    source: 'feishu',
    chatId: 'oc_dev',
    mandateId: 'md_1',
    stage: 'running',
    repo: 'o/r',
    branch: 'main',
    prNumber: 0,
    prUrl: '',
    prState: 'none',
    createdAt: '2026-11-06T09:59:00.000Z',
    updatedAt: '2026-11-06T09:59:00.000Z',
  })
  store.insertAssignment({
    id: ASSIGNMENT_ID,
    ticketId: TICKET_ID,
    runtimeId: 'orca',
    handle: 'h1',
    workdir,
    status: 'running',
    startedAt: '2026-11-06T09:59:00.000Z',
  })
  const prTracker = new GatePrTracker()
  const logs: { level: string; message: string; extra?: Record<string, unknown> }[] = []
  const git = {
    async run(argv: string[]) {
      if (argv[0] === 'merge-base') return { code: 0, stdout: 'abc\n', stderr: '' }
      return { code: 0, stdout: 'src/web/app.tsx\n', stderr: '' }
    },
  }
  const service = new RouterService({
    config,
    store,
    engine,
    runtime,
    decisionEngine: { assess: async () => ({ proposal: {} }) as never, reply: async () => '' } as never,
    prTracker: prTracker as never,
    git,
    clock: { now: () => '2026-11-06T10:00:10.000Z' },
    logger: {
      info: (message, extra) => logs.push({ level: 'info', message, ...(extra ? { extra } : {}) }),
      warn: (message, extra) => logs.push({ level: 'warn', message, ...(extra ? { extra } : {}) }),
      error: (message, extra) => logs.push({ level: 'error', message, ...(extra ? { extra } : {}) }),
    },
    agentLoopOptions: { batchWindowMs: 0 },
  })
  return { service, store, prTracker, logs }
}

function readyState(over: Partial<WorkerStateFile> = {}): WorkerStateFile {
  return {
    ticketId: TICKET_ID,
    assignmentId: ASSIGNMENT_ID,
    turn: 1,
    state: 'ready',
    summary: '完成',
    prNumber: 7,
    prUrl: 'https://github.com/o/r/pull/7',
    ackedInputs: [],
    updatedAt: '2026-11-06T10:00:09.000Z',
    ...over,
  }
}

const GOOD_BODY = '### Before\n![b](https://example.com/b.png)\n\n### After\n![a](https://example.com/a.png)'

describe('RouterService UI 证据门禁', () => {
  let ctx: ReturnType<typeof makeService>

  beforeEach(() => {
    ctx = makeService('enforce')
  })

  it('enforce：缺证据时拒绝 ready，不落报告并记 evidence-missing', async () => {
    ctx.prTracker.body = '### After\n![a](https://example.com/a.png)'
    await expect(ctx.service.ingestWorkerState(readyState({ uiChange: true }))).rejects.toBeInstanceOf(ReportRejectedError)
    expect(ctx.store.latestReport(TICKET_ID)).toBeNull()
    const log = ctx.logs.find(item => item.message === 'report:evidence-missing')
    expect(log).toMatchObject({ level: 'warn', extra: { ticketId: TICKET_ID, mode: 'enforce', action: 'reject', reason: 'missing-labels' } })
  })

  it('enforce：证据完整时正常落报告', async () => {
    ctx.prTracker.body = GOOD_BODY
    await ctx.service.ingestWorkerState(readyState({ uiChange: true }))
    expect(ctx.store.latestReport(TICKET_ID)).toMatchObject({ state: 'ready', turn: 1 })
  })

  it('enforce：blocked 不受门禁影响', async () => {
    ctx.prTracker.body = ''
    await ctx.service.ingestWorkerState(readyState({ state: 'blocked', summary: '无法截图', uiChange: true }))
    expect(ctx.store.latestReport(TICKET_ID)).toMatchObject({ state: 'blocked' })
  })

  it('warn：缺证据只记日志，仍然放行 ready', async () => {
    const warnCtx = makeService('warn')
    warnCtx.prTracker.body = ''
    await warnCtx.service.ingestWorkerState(readyState({ uiChange: true }))
    expect(warnCtx.store.latestReport(TICKET_ID)).toMatchObject({ state: 'ready' })
    expect(warnCtx.logs.find(item => item.message === 'report:evidence-missing')?.level).toBe('warn')
  })

  it('无法推断 UI（workdir 不存在）时降级放行并记 evidence-unverified', async () => {
    const unverified = makeService('enforce', { workdirExists: false })
    unverified.prTracker.body = ''
    await unverified.service.ingestWorkerState(readyState())
    expect(unverified.store.latestReport(TICKET_ID)).toMatchObject({ state: 'ready' })
    expect(unverified.logs.find(item => item.message === 'report:evidence-unverified')).toMatchObject({
      level: 'warn',
      extra: { ticketId: TICKET_ID, unverified: 'workdir-missing' },
    })
  })
})

describe('state.json 的 ui_change 解析', () => {
  it('保留显式声明，缺省时不出现在字段里', () => {
    const base = { ticket_id: TICKET_ID, state: 'ready', summary: '完成' }
    expect(parseStateFile(JSON.stringify({ ...base, ui_change: true })).state.uiChange).toBe(true)
    expect(parseStateFile(JSON.stringify({ ...base, ui_change: false })).state.uiChange).toBe(false)
    expect(parseStateFile(JSON.stringify(base)).state.uiChange).toBeUndefined()
  })
})
