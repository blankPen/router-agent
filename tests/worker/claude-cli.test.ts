import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner } from '../../src/infra/process.js'
import { ClaudeCliRuntime, allowedToolsFrom } from '../../src/worker/runtimes/claude-cli/index.js'
import { WorkerRuntimeError, type WorkerContext, type WorkerRef } from '../../src/worker/port.js'
import { claudeProjectSlug } from '../../src/worker/orca/session.js'
import { parseGitHubRepo } from '../../src/worker/workspaces/git-worktree.js'

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

function context(home: string): WorkerContext {
  return {
    ticket: {
      id: 'tk-1', title: '测试 Claude 适配器', threadId: 't', source: 'feishu', chatId: 'c',
      mandateId: 'm', stage: 'accepted', repo: '/tmp/repo', branch: 'main',
      prNumber: 0, prUrl: '', prState: 'none', createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z',
    },
    assignment: {
      id: 'as-1', ticketId: 'tk-1', runtimeId: 'claude-cli', handle: '', workdir: '',
      status: 'pending', startedAt: '2026-11-08T00:00:00.000Z',
    },
    workdir: join(home, 'worktrees', 'ra-tk-1-demo'),
    brief: { ticketId: 'tk-1', title: '测试', scope: '测试', workBranch: 'ra/tk-1-demo', contract: '# 工单\n请执行' },
    report: { statePath: join(home, 'workers', 'tk-1', 'state.json'), eventsPath: join(home, 'workers', 'tk-1', 'events.log') },
    tools: { fileAccess: 'read-write', shell: 'allowlist', shellAllow: ['ra report'], allowNetwork: false },
  }
}

function ref(home: string, over: Partial<WorkerRef> = {}): WorkerRef {
  return { handle: 'e46aaf7e', ticketId: 'tk-1', workdir: join(home, 'worktrees', 'ra-tk-1-demo'), ...over }
}

describe('ClaudeCliRuntime', () => {
  it('claudeProjectSlug 把非字母数字都替换成短横线', () => {
    expect(claudeProjectSlug('/Users/admin/.trove')).toBe('-Users-admin--trove')
    expect(claudeProjectSlug('/tmp/中文 repo_1')).toBe('-tmp----repo-1')
  })

  it('parseGitHubRepo 支持 ssh / https 两种 origin', () => {
    expect(parseGitHubRepo('git@github.com:acme/web.git')).toBe('acme/web')
    expect(parseGitHubRepo('https://github.com/acme/web.git')).toBe('acme/web')
    expect(parseGitHubRepo('https://gitlab.com/acme/web.git')).toBeNull()
  })

  it('allowedToolsFrom 把 ToolPolicy 映射成命令级白名单', () => {
    const readOnly = allowedToolsFrom({ fileAccess: 'read-only', shell: 'deny', allowNetwork: false })
    expect(readOnly).not.toContain('Write')
    expect(readOnly).not.toContain('Bash')
    const rw = allowedToolsFrom({ fileAccess: 'read-write', shell: 'allowlist', shellAllow: ['ra report', 'pnpm'], allowNetwork: false })
    expect(rw).toContain('Write')
    expect(rw).toContain('Bash(ra report:*)')
    expect(rw).toContain('Bash(pnpm:*)')
  })

  it('start 用 claude --bg 启动并写 meta/brief', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const git = gitRunner()
    const agents = [{ id: 'e46aaf7e', kind: 'background', state: 'working', status: 'busy', sessionId: '11111111-1111-1111-1111-111111111111', pid: 42, startedAt: Date.now() }]
    const claude = scripted(argv => {
      if (argv[0] === '--bg') return { code: 0, stdout: 'backgrounded · e46aaf7e · ra-tk-1-demo\n', stderr: '' }
      if (argv[0] === 'agents') return { code: 0, stdout: JSON.stringify(agents), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = new ClaudeCliRuntime({ claude, git, home, workersDir: join(home, 'workers') })
    const started = await runtime.start(context(home))
    expect(started.handle).toBe('e46aaf7e')
    expect(started.sessionId).toBe('11111111-1111-1111-1111-111111111111')
    expect(started.branch).toBe('ra/tk-1-demo')
    const bg = claude.calls.find(call => call.argv[0] === '--bg')
    expect(bg?.argv).toContain('--name')
    expect(bg?.argv).toContain('--add-dir')
    expect(bg?.argv).toContain('--')
    expect(bg?.argv.at(-1)).toContain('brief.md')
    expect(bg?.argv).not.toContain('--resume')
  })

  it('working 时 deliver 返回 queued，不触发 --resume', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const git = gitRunner()
    const agents = [{ id: 'e46aaf7e', kind: 'background', state: 'working', status: 'busy', sessionId: 's1' }]
    const claude = scripted(argv => {
      if (argv[0] === 'agents') return { code: 0, stdout: JSON.stringify(agents), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = new ClaudeCliRuntime({ claude, git, home, workersDir: join(home, 'workers') })
    const receipt = await runtime.deliver(ref(home, { sessionId: 's1' }), [{ id: 'in_1', kind: 'followup', text: '补测试' }])
    expect(receipt.status).toBe('queued')
    expect(claude.calls.some(call => call.argv.includes('--resume'))).toBe(false)
  })

  it('done 时 deliver 用同一 session resume，且不带新 flags', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const git = gitRunner()
    const agents = [{ id: 'e46aaf7e', kind: 'background', state: 'done', status: 'idle', sessionId: 's1' }]
    const claude = scripted(argv => {
      if (argv[0] === 'agents') return { code: 0, stdout: JSON.stringify(agents), stderr: '' }
      if (argv[0] === '--bg') return { code: 0, stdout: 'backgrounded · e46aaf7e · ra-tk-1-demo\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = new ClaudeCliRuntime({ claude, git, home, workersDir: join(home, 'workers') })
    // 先写 meta，模拟 start 时没来得及捕获 sessionId
    mkdirSync(join(home, 'workers', 'tk-1'), { recursive: true })
    writeFileSync(join(home, 'workers', 'tk-1', 'meta.json'), JSON.stringify({
      ticketId: 'tk-1', assignmentId: 'as-1', runtime: 'claude-cli', handle: 'e46aaf7e',
      workdir: join(home, 'worktrees', 'ra-tk-1-demo'), repo: '/tmp/repo', branch: 'main',
      workBranch: 'ra/tk-1-demo', status: 'running',
    }))
    const receipt = await runtime.deliver(ref(home), [{ id: 'in_2', kind: 'followup', text: '补测试' }], { attempt: 1 })
    expect(receipt.status).toBe('accepted')
    const resume = claude.calls.find(call => call.argv.includes('--resume'))
    expect(resume?.argv.slice(0, 5)).toEqual(['--bg', '--resume', 's1', '--', expect.stringContaining('input-')])
    expect(resume?.argv).not.toContain('--model')
    expect(resume?.argv).not.toContain('--permission-mode')
  })

  it('resume 产生副本时抛错，不静默切换', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const git = gitRunner()
    const agents = [{ id: 'e46aaf7e', kind: 'background', state: 'done', status: 'idle', sessionId: 's1' }]
    const claude = scripted(argv => {
      if (argv[0] === 'agents') return { code: 0, stdout: JSON.stringify(agents), stderr: '' }
      if (argv[0] === '--bg') return { code: 0, stdout: 'note: started a copy as 95c4c910\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = new ClaudeCliRuntime({ claude, git, home, workersDir: join(home, 'workers') })
    mkdirSync(join(home, 'workers', 'tk-1'), { recursive: true })
    writeFileSync(join(home, 'workers', 'tk-1', 'meta.json'), JSON.stringify({
      ticketId: 'tk-1', assignmentId: 'as-1', runtime: 'claude-cli', handle: 'e46aaf7e',
      workdir: join(home, 'worktrees', 'ra-tk-1-demo'), repo: '/tmp/repo', branch: 'main',
      workBranch: 'ra/tk-1-demo', sessionId: 's1', status: 'running',
    }))
    await expect(runtime.deliver(ref(home), [{ id: 'in_3', kind: 'followup', text: '继续' }])).rejects.toBeInstanceOf(WorkerRuntimeError)
  })

  it('agents 查询失败时 queued，不盲目 resume', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const claude = scripted(argv => {
      if (argv[0] === 'agents') return { code: 1, stdout: '', stderr: 'temporary failure' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = new ClaudeCliRuntime({ claude, git: gitRunner(), home, workersDir: join(home, 'workers') })
    const receipt = await runtime.deliver(ref(home, { sessionId: 's1' }), [{ id: 'in_q', kind: 'followup', text: '继续' }])
    expect(receipt.status).toBe('queued')
    expect(claude.calls.some(call => call.argv.includes('--resume'))).toBe(false)
  })

  it('会话已不存在时 rejected，不盲目 resume', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const claude = scripted(argv => {
      if (argv[0] === 'agents') return { code: 0, stdout: '[]', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = new ClaudeCliRuntime({ claude, git: gitRunner(), home, workersDir: join(home, 'workers') })
    const receipt = await runtime.deliver(ref(home, { sessionId: 's1' }), [{ id: 'in_l', kind: 'followup', text: '继续' }])
    expect(receipt.status).toBe('rejected')
    expect(claude.calls.some(call => call.argv.includes('--resume'))).toBe(false)
  })

  it('stop 对不存在的会话幂等', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const claude = scripted(() => ({ code: 1, stdout: "No job matching 'gone'. Run `claude agents` to list running sessions.", stderr: '' }))
    const runtime = new ClaudeCliRuntime({ claude, git: gitRunner(), home, workersDir: join(home, 'workers') })
    await expect(runtime.stop(ref(home, { handle: 'gone' }), 'test')).resolves.toBeUndefined()
  })

  it('status 映射 working / blocked / done / lost', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const git = gitRunner()
    let agents: Record<string, unknown>[] = []
    const claude = scripted(argv => {
      if (argv[0] === 'agents') return { code: 0, stdout: JSON.stringify(agents), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = new ClaudeCliRuntime({ claude, git, home, workersDir: join(home, 'workers') })
    agents = [{ id: 'e46aaf7e', kind: 'background', state: 'working', status: 'busy', sessionId: 's1', startedAt: Date.now() }]
    expect((await runtime.status(ref(home)))?.phase).toBe('running')
    agents = [{ id: 'e46aaf7e', kind: 'background', state: 'blocked', status: 'waiting', waitingFor: 'permission prompt', sessionId: 's1' }]
    expect((await runtime.status(ref(home)))?.phase).toBe('blocked')
    agents = [{ id: 'e46aaf7e', kind: 'background', state: 'done', status: 'idle', sessionId: 's1' }]
    expect((await runtime.status(ref(home)))?.phase).toBe('exited')
    agents = []
    expect((await runtime.status(ref(home)))?.phase).toBe('lost')
  })

  it('activity 按 sessionId 精确读取 Claude JSONL', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const projects = join(home, '.claude', 'projects')
    const workdir = join(home, 'worktrees', 'ra-tk-1-demo')
    const dir = join(projects, claudeProjectSlug(workdir))
    mkdirSync(dir, { recursive: true })
    const sessionId = '11111111-1111-1111-1111-111111111111'
    writeFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify({
      type: 'assistant', timestamp: '2026-11-08T00:00:01.000Z', sessionId,
      message: { content: [{ type: 'text', text: '正在补测试' }] },
    })}\n`)
    const claude = scripted(() => ({ code: 0, stdout: '[]', stderr: '' }))
    const runtime = new ClaudeCliRuntime({ claude, git: gitRunner(), home, workersDir: join(home, 'workers'), claudeProjectsDir: projects })
    const snapshot = await runtime.activity({ ref: ref(home, { sessionId }) })
    expect(snapshot?.events[0]?.text).toBe('正在补测试')
  })
})