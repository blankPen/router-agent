import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { CommandRunner } from '#infra/process.js'
import { AcpRuntime } from '@router-agent/runtime-acp'
import { decidePermission, shellAllowed } from '@router-agent/runtime-acp'
import type {
  AgentStatus,
  SessionSnapshot,
  ToolPolicy,
  WorkerContext,
  WorkerRef,
  WorkspaceProvider,
  WorkspaceRequest,
} from '#runtime/port.js'

const fixture = fileURLToPath(new URL('../fixtures/fake-acp-agent.mjs', import.meta.url))

class FakeWorkspace implements WorkspaceProvider {
  readonly id = 'fake-worktree'
  constructor(private readonly home: string) {}
  async create(req: WorkspaceRequest) {
    const workdir = req.workdir ?? join(this.home, 'worktrees', req.name)
    mkdirSync(workdir, { recursive: true })
    return { workspaceRef: workdir, workdir, branch: req.workBranch }
  }
  async inspect() {
    return null
  }
  async remove() {
    // 测试里不真正删目录。
  }
}

const git: CommandRunner = {
  async run() {
    return { code: 0, stdout: 'git version 2.45.0\n', stderr: '' }
  },
}

const DEFAULT_TOOLS: ToolPolicy = { fileAccess: 'read-write', shell: 'allowlist', shellAllow: ['ra report'], allowNetwork: false }

function runtimeFor(home: string): AcpRuntime {
  return new AcpRuntime({
    command: process.execPath,
    args: [fixture],
    workersDir: join(home, 'workers'),
    home,
    git,
    initializeTimeoutMs: 5_000,
    workspaceProvider: new FakeWorkspace(home),
  })
}

function context(home: string, tools: ToolPolicy = DEFAULT_TOOLS, contract = '# 工单\n请执行'): WorkerContext {
  return {
    ticket: {
      id: 'tk-1', title: '测试 ACP 运行时', threadId: 't', source: 'feishu', chatId: 'c',
      mandateId: 'm', stage: 'todo', repo: '/tmp/repo', branch: 'main',
      prNumber: 0, prUrl: '', prState: 'none', createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
    },
    assignment: {
      id: 'as-1', ticketId: 'tk-1', runtimeId: 'acp', handle: '', workdir: '',
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

async function waitIdle(rt: AcpRuntime, home: string, handle: string): Promise<AgentStatus> {
  return waitFor(async () => {
    const status = await rt.status(ref(home, handle))
    return status?.alive && status.acceptingInput ? status : null
  })
}

async function snapshotWith(rt: AcpRuntime, home: string, handle: string, needle: string): Promise<SessionSnapshot> {
  return waitFor(async () => {
    const snapshot = await rt.activity({ ref: ref(home, handle), opts: { maxEvents: 100 } })
    return snapshot?.events.some(event => event.text.includes(needle)) ? snapshot : null
  })
}

describe('AcpRuntime', () => {
  it('start 完成握手与首轮，deliver 追加一轮，stop 关闭进程', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-acp-'))
    const rt = runtimeFor(home)
    try {
      const started = await rt.start(context(home))
      expect(started.handle).toMatch(/^sess_/)
      expect(started.sessionId).toBe(started.handle)

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
    const home = mkdtempSync(join(tmpdir(), 'ra-acp-busy-'))
    const rt = runtimeFor(home)
    try {
      const started = await rt.start(context(home))
      await waitIdle(rt, home, started.handle)

      const first = await rt.deliver(ref(home, started.handle), [{ id: 'in_slow', kind: 'followup', text: 'SLOW' }])
      expect(first.status).toBe('accepted')

      const second = await rt.deliver(ref(home, started.handle), [{ id: 'in_next', kind: 'followup', text: '下一步' }])
      expect(second).toEqual({ status: 'queued', inputIds: ['in_next'], reason: 'acp:busy' })
    } finally {
      await rt.stop({ handle: '', ticketId: 'tk-1', workdir: join(home, 'worktrees', 'ra-tk-1-demo') }, 'cleanup')
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('权限请求按 worker.tools 放行或拒绝', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-acp-perm-'))
    const denyTools: ToolPolicy = { fileAccess: 'read-write', shell: 'allowlist', shellAllow: ['ra report'], allowNetwork: false }
    const deny = runtimeFor(home)
    try {
      const started = await deny.start(context(home, denyTools))
      await waitIdle(deny, home, started.handle)
      await deny.deliver(ref(home, started.handle), [{ id: 'in_deny', kind: 'followup', text: 'PERMISSION:rm -rf /' }])
      await snapshotWith(deny, home, started.handle, 'permission:reject-once')
      await deny.stop(ref(home, started.handle), 'deny-done')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }

    const allowHome = mkdtempSync(join(tmpdir(), 'ra-acp-perm-allow-'))
    const allowTools: ToolPolicy = { fileAccess: 'read-write', shell: 'allow', allowNetwork: false }
    const allow = runtimeFor(allowHome)
    try {
      const started = await allow.start(context(allowHome, allowTools))
      await waitIdle(allow, allowHome, started.handle)
      await allow.deliver(ref(allowHome, started.handle), [{ id: 'in_allow', kind: 'followup', text: 'PERMISSION:rm -rf /' }])
      await snapshotWith(allow, allowHome, started.handle, 'permission:allow-once')
      await allow.stop(ref(allowHome, started.handle), 'allow-done')
    } finally {
      rmSync(allowHome, { recursive: true, force: true })
    }
  })

  it('进程退出后，具备 loadSession 的 Agent 可以用 session/load 恢复', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-acp-resume-'))
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

  it('重启后 reattach 直接接回会话，status 用活动日志时间而不是启动时间', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-acp-reattach-'))
    const rt = runtimeFor(home)
    const started = await rt.start(context(home))
    await snapshotWith(rt, home, started.handle, '收到：# 工单')
    await waitIdle(rt, home, started.handle)
    const meta = JSON.parse(readFileSync(join(home, 'workers', 'tk-1', 'meta.json'), 'utf8')) as { startedAt: string }
    await rt.stop(ref(home, started.handle), 'simulate-restart')

    // 新实例模拟 ra 进程重启：内存会话为空，只剩磁盘上的 meta 与活动日志。
    const restarted = runtimeFor(home)
    try {
      const before = await restarted.status(ref(home, started.handle))
      expect(before?.alive).toBe(false)
      expect(before?.acceptingInput).toBe(true)
      expect(Date.parse(before!.lastActivityAt!)).toBeGreaterThan(Date.parse(meta.startedAt))

      expect(await restarted.reattach(ref(home, started.handle))).toBe(true)
      const after = await restarted.status(ref(home, started.handle))
      expect(after?.alive).toBe(true)
      expect(after?.acceptingInput).toBe(true)
    } finally {
      await restarted.stop({ handle: '', ticketId: 'tk-1', workdir: join(home, 'worktrees', 'ra-tk-1-demo') }, 'cleanup')
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('ACP 权限策略', () => {
  const options = [
    { optionId: 'allow-once', kind: 'allow_once' },
    { optionId: 'reject-once', kind: 'reject_once' },
  ]

  it('读/搜索放行，写类看 fileAccess', () => {
    const readOnly: ToolPolicy = { fileAccess: 'read-only', shell: 'deny', allowNetwork: false }
    expect(decidePermission(readOnly, { toolCallId: '1', kind: 'read' }, options)?.kind).toBe('allow_once')
    expect(decidePermission(readOnly, { toolCallId: '2', kind: 'edit' }, options)?.kind).toBe('reject_once')
    const writable: ToolPolicy = { fileAccess: 'read-write', shell: 'deny', allowNetwork: false }
    expect(decidePermission(writable, { toolCallId: '3', kind: 'edit' }, options)?.kind).toBe('allow_once')
  })

  it('execute 按 shell 策略与命令前缀判断', () => {
    const allowlist: ToolPolicy = { fileAccess: 'read-write', shell: 'allowlist', shellAllow: ['ra report', 'git'], allowNetwork: false }
    expect(decidePermission(allowlist, { toolCallId: '1', kind: 'execute', rawInput: { command: 'ra report --state ready' } }, options)?.kind).toBe('allow_once')
    expect(decidePermission(allowlist, { toolCallId: '2', kind: 'execute', rawInput: { command: 'rm -rf /' } }, options)?.kind).toBe('reject_once')
    expect(shellAllowed(allowlist, 'git status')).toBe(true)
    expect(shellAllowed(allowlist, 'gitea clone')).toBe(false)
  })

  it('网络请求只在 allowNetwork 时放行；未知工具按只读拒绝', () => {
    const offline: ToolPolicy = { fileAccess: 'read-only', shell: 'deny', allowNetwork: false }
    expect(decidePermission(offline, { toolCallId: '1', kind: 'fetch' }, options)?.kind).toBe('reject_once')
    expect(decidePermission(offline, { toolCallId: '2', kind: 'other' }, options)?.kind).toBe('reject_once')
    const online: ToolPolicy = { fileAccess: 'read-write', shell: 'deny', allowNetwork: true }
    expect(decidePermission(online, { toolCallId: '3', kind: 'fetch' }, options)?.kind).toBe('allow_once')
  })
})