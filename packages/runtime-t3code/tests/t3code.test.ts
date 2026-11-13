import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner } from '#infra/process.js'
import type { Logger } from '#infra/logger.js'
import type { WorkerContext, WorkerRef } from '@router-agent/runtime'
import {
  extractJson,
  isServerDown,
  isThreadGone,
  parseThreadSend,
  parseThreadShow,
  parseThreadStart,
  phaseOfThread,
  projectAdd,
  threadSend,
  threadShow,
  threadStart,
  T3CodeRuntime,
} from '../src/index.js'

interface Call {
  argv: string[]
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv }
}

function scripted(handler: (argv: string[], opts?: Call['opts']) => CommandResult): CommandRunner & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    async run(argv, opts) {
      calls.push({ argv, ...(opts ? { opts } : {}) })
      return handler(argv, opts)
    },
  }
}

function gitRunner(): CommandRunner & { calls: Call[] } {
  return scripted(argv => {
    if (argv[0] === 'check-ref-format') return { code: 0, stdout: '', stderr: '' }
    if (argv[0] === 'show-ref') return { code: 1, stdout: '', stderr: '' }
    if (argv[0] === 'worktree' && argv[1] === 'add') return { code: 0, stdout: '', stderr: '' }
    if (argv[0] === 'rev-parse') return { code: 0, stdout: 'ra/tk-1-demo\n', stderr: '' }
    if (argv[0] === 'worktree' && argv[1] === 'remove') return { code: 0, stdout: '', stderr: '' }
    if (argv[0] === 'branch') return { code: 0, stdout: '', stderr: '' }
    if (argv[0] === '--version') return { code: 0, stdout: 'git version 2.45.0\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  })
}

const THREAD_ID = 'mcp:11111111-1111-1111-1111-111111111111'
const THREAD_JSON = JSON.stringify({
  thread: {
    threadId: THREAD_ID,
    projectId: 'p-1',
    title: '测试工单',
    status: 'completed',
    providerInstanceId: 'codex',
    model: 'gpt-5.4',
    activeRunId: null,
    latestRunId: 'run-1',
    pendingRequestCount: 0,
    worktreePath: null,
    branch: null,
    createdAt: '2026-11-12T19:01:12.177Z',
    updatedAt: '2026-11-12T19:01:20.419Z',
    itemCount: 2,
  },
  messages: [
    { role: 'user', runId: 'run-1', text: '派工' },
    { role: 'assistant', runId: 'run-1', text: '干完了' },
  ],
})

interface FakeState {
  /** 服务端是否答话；false 时所有命令都报「服务端没起」。 */
  serverUp: boolean
  /** 线程是否还在。 */
  threadGone: boolean
  threadStatus: string
  pendingRequestCount: number
}

/** 服务端在跑：探针线程查不到，但服务端答了话。 */
function t3Runner(state: Partial<FakeState> = {}): CommandRunner & { calls: Call[]; state: FakeState } {
  const merged: FakeState = { serverUp: true, threadGone: false, threadStatus: 'completed', pendingRequestCount: 0, ...state }
  const runner = scripted(argv => {
    const [command, sub] = argv
    if (command === 'thread' && sub === 'show') {
      if (!merged.serverUp) {
        return { code: 1, stdout: '', stderr: 'No running T3 Code server uses /Users/admin/.t3. Start T3 Code, then retry.\n' }
      }
      if (merged.threadGone) {
        return { code: 1, stdout: '', stderr: `Thread ${THREAD_ID} is no longer available.\n` }
      }
      const payload = JSON.parse(THREAD_JSON) as { thread: Record<string, unknown> }
      payload.thread.status = merged.threadStatus
      payload.thread.pendingRequestCount = merged.pendingRequestCount
      return { code: 0, stdout: JSON.stringify(payload), stderr: '' }
    }
    if (command === 'thread' && sub === 'start') {
      if (!merged.serverUp) {
        return { code: 1, stdout: '', stderr: 'No running T3 Code server uses /Users/admin/.t3. Start T3 Code, then retry.\n' }
      }
      return { code: 0, stdout: JSON.stringify({ threadId: THREAD_ID, projectId: 'p-1', runId: 'run-1' }), stderr: '' }
    }
    if (command === 'thread' && sub === 'send') {
      if (!merged.serverUp) {
        return { code: 1, stdout: '', stderr: 'No running T3 Code server uses /Users/admin/.t3. Start T3 Code, then retry.\n' }
      }
      if (merged.threadGone) {
        return { code: 1, stdout: '', stderr: `Thread ${THREAD_ID} is no longer available.\n` }
      }
      return { code: 0, stdout: JSON.stringify({ threadId: THREAD_ID, messageId: 'm-1', runId: 'run-2', status: 'starting', delivery: 'started' }), stderr: '' }
    }
    if (command === 'project' && sub === 'add') {
      return { code: 0, stdout: 'Added project p-1 (demo) at /tmp/worktree.\n', stderr: '' }
    }
    if (command === 'project' && sub === 'remove') {
      return { code: 0, stdout: 'Removed project p-1.\n', stderr: '' }
    }
    if (command === '--version') {
      return { code: 0, stdout: 't3/0.1.9\n', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  })
  return Object.assign(runner, { state: merged })
}


interface LogEvent {
  level: 'info' | 'warn' | 'error'
  message: string
  fields: Record<string, unknown>
}

function recordingLogger(): Logger & { events: LogEvent[] } {
  const events: LogEvent[] = []
  const push = (level: LogEvent['level']) => (message: string, fields?: Record<string, unknown>) => {
    events.push({ level, message, fields: fields ?? {} })
  }
  return {
    events,
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: () => {},
  } as Logger & { events: LogEvent[] }
}

function context(home: string): WorkerContext {
  return {
    ticket: {
      id: 'tk-1', title: '测试 T3 适配器', threadId: 't', source: 'feishu', chatId: 'c',
      mandateId: 'm', stage: 'todo', repo: '/tmp/repo', branch: 'main',
      prNumber: 0, prUrl: '', prState: 'none', createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z',
    },
    assignment: {
      id: 'as-1', ticketId: 'tk-1', runtimeId: 't3code', handle: '', workdir: '',
      status: 'pending', startedAt: '2026-11-12T00:00:00.000Z',
    },
    workdir: join(home, 'worktrees', 'ra-tk-1-demo'),
    brief: { ticketId: 'tk-1', title: '测试', scope: '测试', workBranch: 'ra/tk-1-demo', contract: '# 工单\n工作目录：(由运行时决定)\n请执行' },
    report: { statePath: join(home, 'workers', 'tk-1', 'state.json'), eventsPath: join(home, 'workers', 'tk-1', 'events.log') },
    tools: { fileAccess: 'read-write', shell: 'allowlist', shellAllow: ['ra report'], allowNetwork: false },
  }
}

function ref(home: string, over: Partial<WorkerRef> = {}): WorkerRef {
  return { handle: THREAD_ID, ticketId: 'tk-1', workdir: join(home, 'worktrees', 'ra-tk-1-demo'), ...over }
}

describe('T3 Code CLI 封装', () => {
  it('threadStart 带上项目、消息与关日志参数', () => {
    const argv = threadStart({ project: '/tmp/wt', message: '干活', provider: 'codex', model: 'gpt-5.4' })
    expect(argv.slice(0, 4)).toEqual(['thread', 'start', '/tmp/wt', '干活'])
    expect(argv).toContain('--provider')
    expect(argv).toContain('codex')
    expect(argv).toContain('--model')
    expect(argv).toContain('gpt-5.4')
    expect(argv).toContain('--json')
    expect(argv).toContain('--log-level')
    expect(argv).toContain('none')
  })

  it('threadShow / threadSend 不带多余参数', () => {
    expect(threadShow({ thread: 't1' })).toEqual(['thread', 'show', 't1', '--json', '--log-level', 'none'])
    expect(threadSend({ thread: 't1', message: 'hi' })).toEqual(['thread', 'send', 't1', 'hi', '--json', '--log-level', 'none'])
    expect(projectAdd({ path: '/tmp/wt' })).toEqual(['project', 'add', '/tmp/wt', '--log-level', 'none'])
  })

  it('extractJson 跳过 CLI 启动时打印的迁移日志', () => {
    const stdout = [
      '[02:59:02.382] INFO (#28): Migrations ran successfully {',
      "  migrations: ['1_OrchestrationEvents'],",
      '}',
      '{"threadId":"t1"}',
    ].join('\n')
    expect(extractJson(stdout)).toEqual({ threadId: 't1' })
    expect(extractJson('not json at all')).toBeNull()
  })

  it('parseThreadShow 读出线程状态与消息', () => {
    const shown = parseThreadShow(THREAD_JSON)
    expect(shown?.thread.status).toBe('completed')
    expect(shown?.thread.pendingRequestCount).toBe(0)
    expect(shown?.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(shown?.messages[1]?.text).toBe('干完了')
  })

  it('parseThreadStart / parseThreadSend 解析真实 CLI 输出', () => {
    expect(parseThreadStart('{"threadId":"t1","projectId":"p1","runId":"r1"}')).toEqual({ threadId: 't1', projectId: 'p1', runId: 'r1' })
    expect(parseThreadSend('{"threadId":"t1","runId":"r2","delivery":"queued"}')?.delivery).toBe('queued')
    expect(parseThreadStart('{"oops":1}')).toBeNull()
  })

  it('区分服务端没起与线程没了', () => {
    expect(isServerDown('No running T3 Code server uses /Users/admin/.t3. Start T3 Code, then retry.')).toBe(true)
    expect(isServerDown('Could not reach the T3 Code server at http://127.0.0.1:3773. fetch failed')).toBe(true)
    expect(isServerDown('Thread mcp:x is no longer available.')).toBe(false)
    expect(isThreadGone('Thread mcp:x is no longer available.')).toBe(true)
  })

  it('phaseOfThread 把 T3 状态映射到中立阶段', () => {
    expect(phaseOfThread('running', 0)).toBe('running')
    expect(phaseOfThread('preparing', 0)).toBe('running')
    expect(phaseOfThread('waiting', 1)).toBe('blocked')
    expect(phaseOfThread('waiting', 0)).toBe('running')
    expect(phaseOfThread('completed', 0)).toBe('exited')
    expect(phaseOfThread('failed', 0)).toBe('exited')
    expect(phaseOfThread('idle', 0)).toBe('exited')
  })
})

describe('T3CodeRuntime', () => {
  it('start 登记 worktree 项目并用线程 id 当 handle', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-t3-'))
    const t3 = t3Runner()
    const runtime = new T3CodeRuntime({ t3, git: gitRunner(), home, workersDir: join(home, 'workers'), provider: 'codex', model: 'gpt-5.4' })
    const started = await runtime.start(context(home))
    expect(started.handle).toBe(THREAD_ID)
    expect(started.sessionId).toBe(THREAD_ID)
    expect(started.branch).toBe('ra/tk-1-demo')
    const added = t3.calls.find(call => call.argv[0] === 'project' && call.argv[1] === 'add')
    expect(added?.argv[2]).toBe(join(home, 'worktrees', 'ra-tk-1-demo'))
    const started_call = t3.calls.find(call => call.argv[0] === 'thread' && call.argv[1] === 'start')
    expect(started_call?.argv).toContain('--provider')
    expect(started_call?.argv).toContain('codex')
    // 契约正文直接进线程，workdir 占位符替换成实际目录。
    expect(started_call?.argv[3]).toContain(join(home, 'worktrees', 'ra-tk-1-demo'))
    const meta = JSON.parse(readFileSync(join(home, 'workers', 'tk-1', 'meta.json'), 'utf8')) as { handle: string }
    expect(meta.handle).toBe(THREAD_ID)
  })

  it('start 在服务端缺席时拉起 t3 serve 后继续派工', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-t3-'))
    const t3 = t3Runner({ serverUp: false })
    const spawned: string[][] = []
    const runtime = new T3CodeRuntime({
      t3,
      git: gitRunner(),
      home,
      workersDir: join(home, 'workers'),
      serverTimeoutMs: 2_000,
      // 模拟服务端起来：探测到在跑之后派工才能继续。
      spawnServer: (_bin, args) => { spawned.push(args); t3.state.serverUp = true },
    })
    const started = await runtime.start(context(home))
    expect(spawned[0]?.[0]).toBe('serve')
    expect(spawned[0]).toContain('--no-browser')
    expect(started.handle).toBe(THREAD_ID)
  })

  it('start 在服务端拉不起来时拒绝派工', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-t3-'))
    const t3 = t3Runner({ serverUp: false })
    const runtime = new T3CodeRuntime({
      t3,
      git: gitRunner(),
      home,
      workersDir: join(home, 'workers'),
      serverTimeoutMs: 50,
      spawnServer: () => {},
    })
    await expect(runtime.start(context(home))).rejects.toMatchObject({ code: 'runtime:unavailable' })
  })

  it('start 在 provider 与 model 不成对时拒绝派工并说明怎么改', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-t3-'))
    const t3 = t3Runner()
    const runtime = new T3CodeRuntime({ t3, git: gitRunner(), home, workersDir: join(home, 'workers'), provider: 'codex' })
    await expect(runtime.start(context(home))).rejects.toMatchObject({
      code: 'agent:launch-failed',
      reason: expect.stringContaining('runtime.options.t3code.model'),
    })
    // 校验不过就不该建检出、也不该调 T3。
    expect(t3.calls.some(call => call.argv[0] === 'thread' && call.argv[1] === 'start')).toBe(false)
  })

  it('start 失败回滚时先删 T3 项目再回收 worktree', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-t3-'))
    const t3 = t3Runner()
    const order: string[] = []
    const git = scripted(argv => {
      order.push(`${argv[0]} ${argv[1]}`)
      return gitRunner().run(argv)
    })
    const failing = scripted(argv => {
      order.push(`${argv[0]} ${argv[1]}`)
      if (argv[0] === 'thread' && argv[1] === 'start') {
        return { code: 1, stdout: '', stderr: 'boom\n' }
      }
      return t3.run(argv)
    })
    const runtime = new T3CodeRuntime({ t3: failing, git, home, workersDir: join(home, 'workers') })
    await expect(runtime.start(context(home))).rejects.toMatchObject({ code: 'agent:launch-failed' })
    const removeProject = order.indexOf('project remove')
    const removeWorktree = order.findIndex(item => item.startsWith('worktree remove'))
    expect(removeProject).toBeGreaterThanOrEqual(0)
    expect(removeWorktree).toBeGreaterThan(removeProject)
  })

  it('deliver 把追问投进线程并认领输入', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-t3-'))
    const t3 = t3Runner()
    const runtime = new T3CodeRuntime({ t3, git: gitRunner(), home, workersDir: join(home, 'workers') })
    await runtime.start(context(home))
    const receipt = await runtime.deliver(ref(home), [{ id: 'in_1', kind: 'text', text: '补充要求' }], { attempt: 1 })
    expect(receipt.status).toBe('accepted')
    const sent = t3.calls.filter(call => call.argv[0] === 'thread' && call.argv[1] === 'send')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.argv[3]).toContain('in_1')
    expect(sent[0]?.argv[3]).toContain('补充要求')
  })

  it('deliver 同一批输入不重复投递，显式重投放行', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-t3-'))
    const t3 = t3Runner()
    const runtime = new T3CodeRuntime({ t3, git: gitRunner(), home, workersDir: join(home, 'workers') })
    await runtime.start(context(home))
    const inputs = [{ id: 'in_1', kind: 'text' as const, text: '补充要求' }]
    await runtime.deliver(ref(home), inputs, { attempt: 1 })
    await runtime.deliver(ref(home), inputs, { attempt: 1 })
    const sent = t3.calls.filter(call => call.argv[0] === 'thread' && call.argv[1] === 'send')
    expect(sent).toHaveLength(1)
    await runtime.deliver(ref(home), inputs, { attempt: 1, redeliver: true })
    expect(t3.calls.filter(call => call.argv[0] === 'thread' && call.argv[1] === 'send')).toHaveLength(2)
  })

  it('deliver 在服务端没起时排队，线程没了时拒绝', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-t3-'))
    const t3 = t3Runner()
    const runtime = new T3CodeRuntime({ t3, git: gitRunner(), home, workersDir: join(home, 'workers') })
    await runtime.start(context(home))
    t3.state.serverUp = false
    const queued = await runtime.deliver(ref(home), [{ id: 'in_1', kind: 'text', text: 'x' }], { attempt: 1 })
    expect(queued.status).toBe('queued')

    const gone = t3Runner()
    const goneRuntime = new T3CodeRuntime({ t3: gone, git: gitRunner(), home, workersDir: join(home, 'workers') })
    await goneRuntime.start(context(home))
    gone.state.threadGone = true
    const rejected = await goneRuntime.deliver(ref(home), [{ id: 'in_2', kind: 'text', text: 'x' }], { attempt: 1 })
    expect(rejected.status).toBe('rejected')
  })

  it('status 把线程状态映射成阶段', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-t3-'))
    const runtime = new T3CodeRuntime({ t3: t3Runner({ threadStatus: 'running' }), git: gitRunner(), home, workersDir: join(home, 'workers') })
    await runtime.start(context(home))
    const running = await runtime.status(ref(home))
    expect(running?.phase).toBe('running')
    expect(running?.alive).toBe(true)

    const blockedRuntime = new T3CodeRuntime({ t3: t3Runner({ threadStatus: 'waiting', pendingRequestCount: 1 }), git: gitRunner(), home, workersDir: join(home, 'workers') })
    await blockedRuntime.start(context(home))
    const blocked = await blockedRuntime.status(ref(home))
    expect(blocked?.phase).toBe('blocked')
    expect(blocked?.acceptingInput).toBe(true)
    // 跑动中的线程算忙，退出后才重新接受输入。
    expect(running?.acceptingInput).toBe(false)
  })

  it('status 在线程没了时判为 lost，读不到时返回 null', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-t3-'))
    const t3 = t3Runner()
    const runtime = new T3CodeRuntime({ t3, git: gitRunner(), home, workersDir: join(home, 'workers') })
    await runtime.start(context(home))
    t3.state.threadGone = true
    expect((await runtime.status(ref(home)))?.phase).toBe('lost')
    t3.state.threadGone = false
    t3.state.serverUp = false
    expect(await runtime.status(ref(home))).toBeNull()
  })

  it('output 读回线程消息', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-t3-'))
    const runtime = new T3CodeRuntime({ t3: t3Runner(), git: gitRunner(), home, workersDir: join(home, 'workers') })
    await runtime.start(context(home))
    const output = await runtime.output(ref(home))
    expect(output?.lines).toEqual(['[user] 派工', '[assistant] 干完了'])
    expect(output?.status).toBe('exited')
  })

  it('removeWorkspace 先删 T3 项目再回收 worktree', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-t3-'))
    const t3 = t3Runner()
    const git = gitRunner()
    const runtime = new T3CodeRuntime({ t3, git, home, workersDir: join(home, 'workers') })
    await runtime.start(context(home))
    await runtime.removeWorkspace({ ticketId: 'tk-1', workdir: join(home, 'worktrees', 'ra-tk-1-demo'), repo: '/tmp/repo' })
    const removed = t3.calls.find(call => call.argv[0] === 'project' && call.argv[1] === 'remove')
    expect(removed?.argv).toContain('--force')
    expect(git.calls.some(call => call.argv[0] === 'worktree' && call.argv[1] === 'remove')).toBe(true)
  })

  it('日志记下派工成功与服务端掉线', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-t3-'))
    const logger = recordingLogger()
    const t3 = t3Runner()
    const runtime = new T3CodeRuntime({ t3, git: gitRunner(), home, workersDir: join(home, 'workers'), logger })
    await runtime.start(context(home))
    expect(logger.events.some(event => event.message === 't3code:thread-started' && event.fields.threadId === THREAD_ID)).toBe(true)
    t3.state.serverUp = false
    await runtime.deliver(ref(home), [{ id: 'in_1', kind: 'text', text: 'x' }], { attempt: 1 })
    const down = logger.events.find(event => event.message === 't3code:server-down')
    expect(down?.level).toBe('warn')
    expect(down?.fields.ticketId).toBe('tk-1')
    await runtime.stop(ref(home), '工单关闭')
    expect(logger.events.some(event => event.message === 't3code:stop-no-cancel')).toBe(true)
  })

  it('doctor 报出 CLI 与服务端状态', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-t3-'))
    const runtime = new T3CodeRuntime({ t3: t3Runner({ serverUp: false }), git: gitRunner(), home, workersDir: join(home, 'workers') })
    const checks = await runtime.doctor()
    expect(checks.map(check => check.name)).toEqual(['T3 Code CLI', 'T3 Code 服务端', 'git worktree'])
    expect(checks[0]?.status).toBe('ok')
    expect(checks[1]?.status).toBe('fail')
  })
})
