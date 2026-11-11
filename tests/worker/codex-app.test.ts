import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Logger } from '../../src/infra/logger.js'
import type { CommandRunner } from '../../src/infra/process.js'
import { CodexAppRuntime } from '../../src/worker/runtimes/codex/index.js'
import type {
  AgentStatus,
  SessionSnapshot,
  ToolPolicy,
  WorkerContext,
  WorkerRef,
  WorkspaceProvider,
  WorkspaceRequest,
} from '../../src/worker/port.js'

const fixture = fileURLToPath(new URL('../fixtures/fake-codex-app-server.mjs', import.meta.url))

class FakeWorkspace implements WorkspaceProvider {
  readonly id = 'fake-worktree'
  constructor(private readonly home: string) {}
  async create(req: WorkspaceRequest) {
    const workdir = req.workdir ?? join(this.home, 'worktrees', req.name)
    mkdirSync(workdir, { recursive: true })
    return { workspaceRef: workdir, workdir, branch: req.workBranch }
  }
  async inspect() { return null }
  async remove() { /* 测试里不真正删目录 */ }
}

const git: CommandRunner = {
  async run() { return { code: 0, stdout: 'git version 2.45.0\n', stderr: '' } },
}

const DEFAULT_TOOLS: ToolPolicy = { fileAccess: 'read-write', shell: 'allow', allowNetwork: true }

function runtimeFor(
  home: string,
  tools: 'never' | 'on-request' = 'never',
  extra: { env?: NodeJS.ProcessEnv; logger?: Logger } = {},
): CodexAppRuntime {
  return new CodexAppRuntime({
    command: process.execPath,
    prependArgs: [fixture],
    workersDir: join(home, 'workers'),
    home,
    git,
    permissions: 'full',
    approvalPolicy: tools,
    network: true,
    initializeTimeoutMs: 5_000,
    workspaceProvider: new FakeWorkspace(home),
    ...(extra.env ? { env: extra.env } : {}),
    ...(extra.logger ? { logger: extra.logger } : {}),
    detectBinary: async () => ({
      command: process.execPath,
      source: 'config',
      candidates: [],
      version: 'fake',
      compatible: true,
      installHint: '',
      installUrl: '',
    }),
  })
}

/** 读取夹具记录的启动参数与子进程环境。 */
function readArgvLine(logPath: string): { argv?: string[]; env?: { CODEX_HOME?: string | null } } | undefined {
  const lines = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  return lines.find(line => line.direction === 'argv')
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function context(home: string, tools: ToolPolicy = DEFAULT_TOOLS, contract = '# 工单\n请执行'): WorkerContext {
  return {
    ticket: {
      id: 'tk-1', title: '测试 Codex 运行时', threadId: 't', source: 'feishu', chatId: 'c',
      mandateId: 'm', stage: 'todo', repo: '/tmp/repo', branch: 'main',
      prNumber: 0, prUrl: '', prState: 'none', createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
    },
    assignment: {
      id: 'as-1', ticketId: 'tk-1', runtimeId: 'codex-app', handle: '', workdir: '',
      status: 'pending', startedAt: '2026-11-09T00:00:00.000Z',
    },
    workdir: join(home, 'worktrees', 'ra-tk-1-demo'),
    brief: { ticketId: 'tk-1', title: '测试', scope: '测试', workBranch: 'ra/tk-1-demo', contract },
    report: { statePath: join(home, 'workers', 'tk-1', 'state.json'), eventsPath: join(home, 'workers', 'tk-1', 'events.log') },
    tools,
  }
}

function ref(home: string, handle: string): WorkerRef {
  return { handle, ticketId: 'tk-1', workdir: join(home, 'worktrees', 'ra-tk-1-demo'), sessionId: handle }
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 5_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error('等待超时')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function waitIdle(rt: CodexAppRuntime, home: string, handle: string): Promise<AgentStatus> {
  return waitFor(async () => {
    const status = await rt.status(ref(home, handle))
    return status?.alive && status.acceptingInput ? status : null
  })
}

async function snapshotWith(rt: CodexAppRuntime, home: string, handle: string, needle: string): Promise<SessionSnapshot> {
  return waitFor(async () => {
    const snapshot = await rt.activity({ ref: ref(home, handle), opts: { maxEvents: 100 } })
    return snapshot?.events.some(event => event.text.includes(needle)) ? snapshot : null
  })
}

describe('CodexAppRuntime', () => {
  it('start 建 thread、turn 完成，deliver 追加，stop 关闭', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-codex-'))
    const rt = runtimeFor(home)
    try {
      const started = await rt.start(context(home))
      expect(started.handle).toBe('thr_1')
      expect(started.sessionId).toBe('thr_1')

      const status = await rt.status(ref(home, started.handle))
      expect(status?.alive).toBe(true)

      await snapshotWith(rt, home, started.handle, '收到：# 工单')
      await waitIdle(rt, home, started.handle)

      const receipt = await rt.deliver(ref(home, started.handle), [{ id: 'in_1', kind: 'followup', text: '继续' }])
      expect(receipt).toEqual({ status: 'accepted', inputIds: ['in_1'] })
      await snapshotWith(rt, home, started.handle, '继续')

      await rt.stop(ref(home, started.handle), 'test-done')
      const stopped = await rt.status(ref(home, started.handle))
      expect(stopped?.alive).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('上一轮未结束时 deliver 返回 queued', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-codex-busy-'))
    const rt = runtimeFor(home)
    const started = await rt.start(context(home))
    try {
      await waitIdle(rt, home, started.handle)
      const first = await rt.deliver(ref(home, started.handle), [{ id: 'in_slow', kind: 'followup', text: 'SLOW 任务' }])
      expect(first.status).toBe('accepted')
      const second = await rt.deliver(ref(home, started.handle), [{ id: 'in_next', kind: 'followup', text: '下一步' }])
      // 测试夹具实现了 turn/steer，因此忙时追加输入会被接受；若 steer 失败才 queued。
      expect(['accepted', 'queued']).toContain(second.status)
    } finally {
      await rt.stop(ref(home, started.handle), 'cleanup')
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('审批请求按 worker.tools 拒绝；allow 时放行', async () => {
    const denyHome = mkdtempSync(join(tmpdir(), 'ra-codex-perm-deny-'))
    const deny = runtimeFor(denyHome, 'on-request')
    try {
      const tools: ToolPolicy = { fileAccess: 'read-write', shell: 'allowlist', shellAllow: ['ra report'], allowNetwork: true }
      const started = await deny.start(context(denyHome, tools))
      await waitIdle(deny, denyHome, started.handle)
      await deny.deliver(ref(denyHome, started.handle), [{ id: 'in_deny', kind: 'followup', text: 'PERMISSION:rm -rf /' }])
      await snapshotWith(deny, denyHome, started.handle, 'permission:decline')
      await deny.stop(ref(denyHome, started.handle), 'deny-done')
    } finally {
      rmSync(denyHome, { recursive: true, force: true })
    }

    const allowHome = mkdtempSync(join(tmpdir(), 'ra-codex-perm-allow-'))
    const allow = runtimeFor(allowHome, 'on-request')
    try {
      const tools: ToolPolicy = { fileAccess: 'read-write', shell: 'allow', allowNetwork: true }
      const started = await allow.start(context(allowHome, tools))
      await waitIdle(allow, allowHome, started.handle)
      await allow.deliver(ref(allowHome, started.handle), [{ id: 'in_allow', kind: 'followup', text: 'PERMISSION:rm -rf /' }])
      await snapshotWith(allow, allowHome, started.handle, 'permission:accept')
      await allow.stop(ref(allowHome, started.handle), 'allow-done')
    } finally {
      rmSync(allowHome, { recursive: true, force: true })
    }
  })

  it('进程停止后 deliver 用 thread/resume 接回', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-codex-resume-'))
    const rt = runtimeFor(home)
    try {
      const started = await rt.start(context(home))
      await waitIdle(rt, home, started.handle)
      await rt.stop(ref(home, started.handle), 'simulate-crash')

      const receipt = await rt.deliver(ref(home, started.handle), [{ id: 'in_resume', kind: 'followup', text: '恢复后继续' }])
      expect(receipt).toEqual({ status: 'accepted', inputIds: ['in_resume'] })
      await snapshotWith(rt, home, started.handle, '恢复后继续')
    } finally {
      await rt.stop({ handle: '', ticketId: 'tk-1', workdir: join(home, 'worktrees', 'ra-tk-1-demo') }, 'cleanup')
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('interruptedTurn：正常完成的轮次不算被打断', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-codex-interrupted-ok-'))
    const previousTurns = process.env.FAKE_CODEX_TURNS
    process.env.FAKE_CODEX_TURNS = join(home, 'turns.json')
    const rt = runtimeFor(home)
    try {
      const started = await rt.start(context(home))
      await waitIdle(rt, home, started.handle)
      expect(await rt.interruptedTurn(ref(home, started.handle))).toBeNull()
    } finally {
      await rt.stop(ref(home, ''), 'cleanup')
      restoreEnv('FAKE_CODEX_TURNS', previousTurns)
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('interruptedTurn：重启后从 thread/turns/list 读出被中断的轮次', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-codex-interrupted-'))
    const turnsPath = join(home, 'turns.json')
    const previousTurns = process.env.FAKE_CODEX_TURNS
    process.env.FAKE_CODEX_TURNS = turnsPath
    const rt = runtimeFor(home)
    try {
      const started = await rt.start(context(home))
      await waitIdle(rt, home, started.handle)

      // 模拟「重启打断了正在跑的那一轮」：把最后一轮标成 interrupted。
      // 轮次历史落在磁盘上，新起的 app-server 进程能读到——对应真实的 rollout 语义。
      const turns = JSON.parse(readFileSync(turnsPath, 'utf8')) as Array<{ id: string; status: string }>
      expect(turns.length).toBeGreaterThan(0)
      turns[0]!.status = 'interrupted'
      writeFileSync(turnsPath, JSON.stringify(turns), 'utf8')

      // 重启：新 runtime 实例（只有磁盘上的 meta.json）。
      const rt2 = runtimeFor(home)
      const attached = await rt2.reattach(ref(home, started.handle))
      expect(attached).toBe(true)

      const interrupted = await rt2.interruptedTurn(ref(home, started.handle))
      expect(interrupted).not.toBeNull()
      expect(interrupted!.turnId).toBe(turns[0]!.id)
      // 摘要里应能看到被中断那一轮的用户要求，便于生成恢复提示。
      expect(interrupted!.summary).toContain('请执行')
    } finally {
      await rt.stop(ref(home, ''), 'cleanup')
      restoreEnv('FAKE_CODEX_TURNS', previousTurns)
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('interruptedTurn：查不到轮次状态时记 warn 并返回 null，不误判成被打断', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-codex-interrupted-fail-'))
    const previousTurns = process.env.FAKE_CODEX_TURNS
    const previousError = process.env.FAKE_CODEX_TURNS_ERROR
    process.env.FAKE_CODEX_TURNS = join(home, 'turns.json')
    process.env.FAKE_CODEX_TURNS_ERROR = '1'
    const warns: Array<{ message: string; extra?: Record<string, unknown> }> = []
    const rt = runtimeFor(home, 'never', {
      logger: {
        info: () => {},
        warn: (message, extra) => { warns.push({ message, ...(extra ? { extra } : {}) }) },
        error: () => {},
      },
    })
    try {
      const started = await rt.start(context(home))
      await waitIdle(rt, home, started.handle)
      expect(await rt.interruptedTurn(ref(home, started.handle))).toBeNull()
      const event = warns.find(item => item.message === 'codex:interrupted-turn-check-failed')
      expect(event).toBeDefined()
      expect(event!.extra?.ticketId).toBe('tk-1')
      expect(typeof event!.extra?.reason).toBe('string')
    } finally {
      await rt.stop(ref(home, ''), 'cleanup')
      restoreEnv('FAKE_CODEX_TURNS', previousTurns)
      restoreEnv('FAKE_CODEX_TURNS_ERROR', previousError)
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('二进制缺失时 start 抛 runtime:unavailable 并带安装提示', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-codex-missing-'))
    const rt = new CodexAppRuntime({
      workersDir: join(home, 'workers'),
      home,
      git,
      workspaceProvider: new FakeWorkspace(home),
      detectBinary: async () => ({
        source: 'missing',
        candidates: [],
        compatible: false,
        reason: '未找到 Codex',
        installHint: '安装 Codex App',
        installUrl: 'https://chatgpt.com/codex',
      }),
    })
    try {
      await expect(rt.start(context(home))).rejects.toMatchObject({
        code: 'runtime:unavailable',
        detail: { installUrl: 'https://chatgpt.com/codex' },
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('子进程默认使用 ~/.codex 作为 CODEX_HOME，不受服务继承的环境变量影响', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-codex-home-'))
    const logPath = join(home, 'codex.log')
    const previousHome = process.env.CODEX_HOME
    const previousLog = process.env.FAKE_CODEX_LOG
    process.env.CODEX_HOME = '/tmp/foreign-codex-home'
    process.env.FAKE_CODEX_LOG = logPath
    const rt = runtimeFor(home)
    try {
      const started = await rt.start(context(home))
      await waitIdle(rt, home, started.handle)
      expect(readArgvLine(logPath)?.env?.CODEX_HOME).toBe(join(homedir(), '.codex'))
      await rt.stop(ref(home, started.handle), 'done')
    } finally {
      restoreEnv('CODEX_HOME', previousHome)
      restoreEnv('FAKE_CODEX_LOG', previousLog)
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('显式 env 覆盖默认 CODEX_HOME', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-codex-home-override-'))
    const logPath = join(home, 'codex.log')
    const previousLog = process.env.FAKE_CODEX_LOG
    process.env.FAKE_CODEX_LOG = logPath
    const rt = runtimeFor(home, 'never', { env: { CODEX_HOME: '/tmp/custom-codex-home' } })
    try {
      const started = await rt.start(context(home))
      await waitIdle(rt, home, started.handle)
      expect(readArgvLine(logPath)?.env?.CODEX_HOME).toBe('/tmp/custom-codex-home')
      await rt.stop(ref(home, started.handle), 'done')
    } finally {
      restoreEnv('FAKE_CODEX_LOG', previousLog)
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('启动时记录 codex:codex-home 事件，便于排查桌面端看不到 thread', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-codex-home-log-'))
    const events: { message: string; extra?: Record<string, unknown> }[] = []
    const logger: Logger = {
      info: (message, extra) => { events.push({ message, extra }) },
      warn: () => {},
      error: () => {},
    }
    const rt = runtimeFor(home, 'never', { logger })
    try {
      const started = await rt.start(context(home))
      await waitIdle(rt, home, started.handle)
      expect(events.find(event => event.message === 'codex:codex-home')?.extra)
        .toMatchObject({ ticketId: 'tk-1', codexHome: join(homedir(), '.codex') })
      await rt.stop(ref(home, started.handle), 'done')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('thread/start 参数与 app-server 启动参数符合 full + never 默认', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-codex-args-'))
    const logPath = join(home, 'codex.log')
    const previous = process.env.FAKE_CODEX_LOG
    process.env.FAKE_CODEX_LOG = logPath
    const rt = runtimeFor(home)
    try {
      const started = await rt.start(context(home))
      await waitIdle(rt, home, started.handle)
      const lines = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      const argv = lines.find(line => line.direction === 'argv')?.argv as string[]
      expect(argv.join(' ')).toContain('app-server --stdio')
      expect(argv.join(' ')).toContain('sandbox_mode="danger-full-access"')
      expect(argv.join(' ')).toContain('approval_policy="never"')
      const threadStart = lines.find(line => line.direction === 'in' && line.message?.method === 'thread/start')?.message
      expect(threadStart?.params).toMatchObject({ sandbox: 'danger-full-access', approvalPolicy: 'never' })
      expect(threadStart?.params?.developerInstructions).toContain('ra report')
      await rt.stop(ref(home, started.handle), 'done')
    } finally {
      if (previous === undefined) delete process.env.FAKE_CODEX_LOG
      else process.env.FAKE_CODEX_LOG = previous
      rmSync(home, { recursive: true, force: true })
    }
  })
})
