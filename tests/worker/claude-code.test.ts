import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner } from '#infra/process.js'
import { ClaudeCodeRuntime, allowedToolsFrom } from '@router-agent/runtime-claude-code'
import type { WorkerContext, WorkerRef } from '#runtime/port.js'
import { claudeProjectSlug } from '#runtime/agents/claude.js'
import { parseGitHubRepo } from '#runtime/workspaces/git-worktree.js'

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
      mandateId: 'm', stage: 'todo', repo: '/tmp/repo', branch: 'main',
      prNumber: 0, prUrl: '', prState: 'none', createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z',
    },
    assignment: {
      id: 'as-1', ticketId: 'tk-1', runtimeId: 'claude-code', handle: '', workdir: '',
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

describe('ClaudeCodeRuntime', () => {
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
    const runtime = new ClaudeCodeRuntime({ claude, git, home, workersDir: join(home, 'workers') })
    const started = await runtime.start(context(home))
    expect(started.handle).toBe('e46aaf7e')
    expect(started.sessionId).toBe('11111111-1111-1111-1111-111111111111')
    expect(started.branch).toBe('ra/tk-1-demo')
    const bg = claude.calls.find(call => call.argv[0] === '--bg')
    expect(bg?.argv).toContain('--name')
    expect(bg?.argv).toContain('--add-dir')
    expect(bg?.argv).toContain('--dangerously-skip-permissions')
    expect(bg?.argv).not.toContain('--permission-mode')
    expect(bg?.argv).toContain('--')
    expect(bg?.argv.at(-1)).toContain('brief.md')
    expect(bg?.argv).not.toContain('--resume')
  })

  it('parseBackgroundId 兼容带 ANSI 颜色的 backgrounded 输出', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const agents = [{ id: 'e46aaf7e', kind: 'background', state: 'working', status: 'busy', sessionId: 's1' }]
    const claude = scripted(argv => {
      if (argv[0] === '--bg') return { code: 0, stdout: `backgrounded · \u001b[36me46aaf7e\u001b[39m · ra-tk-1-demo\n`, stderr: '' }
      if (argv[0] === 'agents') return { code: 0, stdout: JSON.stringify(agents), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = new ClaudeCodeRuntime({ claude, git: gitRunner(), home, workersDir: join(home, 'workers') })
    const started = await runtime.start(context(home))
    expect(started.handle).toBe('e46aaf7e')
  })

  it('working 时 deliver 返回 queued，不触发 --resume', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const git = gitRunner()
    const agents = [{ id: 'e46aaf7e', kind: 'background', state: 'working', status: 'busy', sessionId: 's1' }]
    const claude = scripted(argv => {
      if (argv[0] === 'agents') return { code: 0, stdout: JSON.stringify(agents), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = new ClaudeCodeRuntime({ claude, git, home, workersDir: join(home, 'workers') })
    const receipt = await runtime.deliver(ref(home, { sessionId: 's1' }), [{ id: 'in_1', kind: 'followup', text: '补测试' }])
    expect(receipt.status).toBe('queued')
    expect(claude.calls.some(call => call.argv.includes('--resume'))).toBe(false)
  })

  it('working 时把输入插进当前轮，不等 done 也不 fork', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const projects = join(home, '.claude', 'projects')
    const workdir = join(home, 'worktrees', 'ra-tk-1-demo')
    const sessionId = 'e46aaf7e-3008-4c2e-99e5-fe312f3bff32'
    const dir = join(projects, claudeProjectSlug(workdir))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ type: 'assistant', message: { content: [] } })}\n`)

    const agents = [{ id: 'e46aaf7e', kind: 'background', state: 'working', status: 'busy', sessionId }]
    const claude = scripted(argv => {
      if (argv[0] === 'agents') return { code: 0, stdout: JSON.stringify(agents), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    let injected = ''
    const runtime = new ClaudeCodeRuntime({
      claude, git: gitRunner(), home, workersDir: join(home, 'workers'), claudeProjectsDir: projects,
      inject: async (_handle, text) => {
        injected = text
        // 模拟 TUI 把这句话作为本轮输入写进会话记录。
        writeFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify({
          type: 'user', message: { role: 'user', content: [{ type: 'text', text }] },
        })}\n`, { flag: 'a' })
        return { ok: true }
      },
    })
    mkdirSync(join(home, 'workers', 'tk-1'), { recursive: true })
    writeFileSync(join(home, 'workers', 'tk-1', 'meta.json'), JSON.stringify({
      ticketId: 'tk-1', assignmentId: 'as-1', runtime: 'claude-code', handle: 'e46aaf7e',
      workdir, repo: '/tmp/repo', branch: 'main', workBranch: 'ra/tk-1-demo', sessionId, status: 'running',
    }))

    const receipt = await runtime.deliver(ref(home), [{ id: 'in_turn', kind: 'followup', text: '顺便补测试' }])
    expect(receipt.status).toBe('accepted')
    expect(injected).toContain('input-in_turn')
    // 轮内插话不能再走 resume（那会复制会话）。
    expect(claude.calls.some(call => call.argv.includes('--resume'))).toBe(false)
    expect(claude.calls.some(call => call.argv[0] === 'stop')).toBe(false)
  })

  it('轮内插话没落盘时退回 queued，等本轮结束再 resume', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const projects = join(home, '.claude', 'projects')
    const workdir = join(home, 'worktrees', 'ra-tk-1-demo')
    const sessionId = 'e46aaf7e-3008-4c2e-99e5-fe312f3bff32'
    mkdirSync(join(projects, claudeProjectSlug(workdir)), { recursive: true })
    writeFileSync(join(projects, claudeProjectSlug(workdir), `${sessionId}.jsonl`), '')

    const agents = [{ id: 'e46aaf7e', kind: 'background', state: 'working', status: 'busy', sessionId }]
    const claude = scripted(argv => {
      if (argv[0] === 'agents') return { code: 0, stdout: JSON.stringify(agents), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = new ClaudeCodeRuntime({
      claude, git: gitRunner(), home, workersDir: join(home, 'workers'), claudeProjectsDir: projects,
      inject: async () => ({ ok: false, reason: 'not-recorded' }),
    })
    const receipt = await runtime.deliver(ref(home, { sessionId }), [{ id: 'in_lost', kind: 'followup', text: '继续' }])
    expect(receipt).toMatchObject({ status: 'queued' })
    expect(claude.calls.some(call => call.argv.includes('--resume'))).toBe(false)
  })

  it('同一批输入重投时不再重复插话', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const projects = join(home, '.claude', 'projects')
    const workdir = join(home, 'worktrees', 'ra-tk-1-demo')
    const sessionId = 'e46aaf7e-3008-4c2e-99e5-fe312f3bff32'
    const dir = join(projects, claudeProjectSlug(workdir))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${sessionId}.jsonl`), '')

    const agents = [{ id: 'e46aaf7e', kind: 'background', state: 'working', status: 'busy', sessionId }]
    const claude = scripted(argv => {
      if (argv[0] === 'agents') return { code: 0, stdout: JSON.stringify(agents), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    let calls = 0
    const runtime = new ClaudeCodeRuntime({
      claude, git: gitRunner(), home, workersDir: join(home, 'workers'), claudeProjectsDir: projects,
      inject: async (_handle, text) => {
        calls++
        writeFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify({
          type: 'user', message: { role: 'user', content: [{ type: 'text', text }] },
        })}\n`, { flag: 'a' })
        return { ok: true }
      },
    })
    mkdirSync(join(home, 'workers', 'tk-1'), { recursive: true })
    writeFileSync(join(home, 'workers', 'tk-1', 'meta.json'), JSON.stringify({
      ticketId: 'tk-1', assignmentId: 'as-1', runtime: 'claude-code', handle: 'e46aaf7e',
      workdir, repo: '/tmp/repo', branch: 'main', workBranch: 'ra/tk-1-demo', sessionId, status: 'running',
    }))

    const input = [{ id: 'in_once', kind: 'followup' as const, text: '只插一次' }]
    expect((await runtime.deliver(ref(home), input, { attempt: 1 })).status).toBe('accepted')
    expect((await runtime.deliver(ref(home), input, { attempt: 2, redeliver: true })).status).toBe('accepted')
    expect(calls).toBe(1)
  })

  it('blocked 时不插话：等人工处理后再投', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    let injected = false
    const agents = [{ id: 'e46aaf7e', kind: 'background', state: 'blocked', status: 'waiting', sessionId: 's1' }]
    const claude = scripted(argv => {
      if (argv[0] === 'agents') return { code: 0, stdout: JSON.stringify(agents), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = new ClaudeCodeRuntime({
      claude, git: gitRunner(), home, workersDir: join(home, 'workers'),
      inject: async () => { injected = true; return { ok: true } },
    })
    const receipt = await runtime.deliver(ref(home, { sessionId: 's1' }), [{ id: 'in_blocked', kind: 'followup', text: '继续' }])
    expect(receipt).toMatchObject({ status: 'queued', reason: 'claude:blocked' })
    expect(injected).toBe(false)
  })

  it('done 时 deliver 用同一 session resume，且不带任何新 flags', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const git = gitRunner()
    const agents = [{ id: 'e46aaf7e', kind: 'background', state: 'done', status: 'idle', sessionId: 's1' }]
    const claude = scripted(argv => {
      if (argv[0] === 'agents') return { code: 0, stdout: JSON.stringify(agents), stderr: '' }
      if (argv[0] === '--bg') return { code: 0, stdout: 'backgrounded · e46aaf7e · ra-tk-1-demo\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = new ClaudeCodeRuntime({ claude, git, home, workersDir: join(home, 'workers') })
    // 先写 meta，模拟 start 时没来得及捕获 sessionId
    mkdirSync(join(home, 'workers', 'tk-1'), { recursive: true })
    writeFileSync(join(home, 'workers', 'tk-1', 'meta.json'), JSON.stringify({
      ticketId: 'tk-1', assignmentId: 'as-1', runtime: 'claude-code', handle: 'e46aaf7e',
      workdir: join(home, 'worktrees', 'ra-tk-1-demo'), repo: '/tmp/repo', branch: 'main',
      workBranch: 'ra/tk-1-demo', status: 'running',
    }))
    const receipt = await runtime.deliver(ref(home), [{ id: 'in_2', kind: 'followup', text: '补测试' }], { attempt: 1 })
    expect(receipt.status).toBe('accepted')
    const resume = claude.calls.find(call => call.argv.includes('--resume'))
    expect(resume?.argv).toEqual(['--bg', '--resume', 's1', expect.stringContaining('input-')])
    expect(resume?.argv).not.toContain('--')
    expect(resume?.argv).not.toContain('--model')
    expect(resume?.argv).not.toContain('--permission-mode')
  })

  it('出现副本时停掉副本并保留原会话，不接管新会话', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const git = gitRunner()
    const agents = [
      { id: 'e46aaf7e', kind: 'background', state: 'done', status: 'idle', sessionId: 's1' },
      { id: '95c4c910', kind: 'background', state: 'working', status: 'busy', sessionId: 's2' },
    ]
    const claude = scripted(argv => {
      if (argv[0] === 'agents') return { code: 0, stdout: JSON.stringify(agents), stderr: '' }
      if (argv[0] === '--bg') {
        return {
          code: 0,
          stdout: 'backgrounded · 95c4c910 · ra-tk-1-demo\n',
          stderr: 'note: session e46aaf7e is already running in the background, so this started a copy as 95c4c910. `claude attach e46aaf7e` opens the original.\n',
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = new ClaudeCodeRuntime({ claude, git, home, workersDir: join(home, 'workers') })
    mkdirSync(join(home, 'workers', 'tk-1'), { recursive: true })
    writeFileSync(join(home, 'workers', 'tk-1', 'meta.json'), JSON.stringify({
      ticketId: 'tk-1', assignmentId: 'as-1', runtime: 'claude-code', handle: 'e46aaf7e',
      workdir: join(home, 'worktrees', 'ra-tk-1-demo'), repo: '/tmp/repo', branch: 'main',
      workBranch: 'ra/tk-1-demo', sessionId: 's1', status: 'running',
    }))
    const receipt = await runtime.deliver(ref(home), [{ id: 'in_3', kind: 'followup', text: '继续' }])
    // 一个话题 = 一个会话：副本不能接管工单，只能停掉后把输入重投回原会话。
    expect(receipt).toMatchObject({ status: 'rejected', reason: 'claude:resume-forked', retryable: true })
    const meta = JSON.parse(readFileSync(join(home, 'workers', 'tk-1', 'meta.json'), 'utf8')) as {
      handle: string
      sessionId: string
    }
    expect(meta.handle).toBe('e46aaf7e')
    expect(meta.sessionId).toBe('s1')
  })

  it('出现副本时停掉副本，不让它和原会话并发改同一 worktree', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const git = gitRunner()
    const agents = [
      { id: 'e46aaf7e', kind: 'background', state: 'done', status: 'idle', sessionId: 's1' },
      { id: '95c4c910', kind: 'background', state: 'working', status: 'busy', sessionId: 's2' },
    ]
    const claude = scripted(argv => {
      if (argv[0] === 'agents') return { code: 0, stdout: JSON.stringify(agents), stderr: '' }
      if (argv[0] === '--bg') {
        return {
          code: 0,
          stdout: 'backgrounded · 95c4c910 · ra-tk-1-demo\n',
          stderr: 'note: session e46aaf7e is already running in the background, so this started a copy as 95c4c910.\n',
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = new ClaudeCodeRuntime({ claude, git, home, workersDir: join(home, 'workers') })
    mkdirSync(join(home, 'workers', 'tk-1'), { recursive: true })
    writeFileSync(join(home, 'workers', 'tk-1', 'meta.json'), JSON.stringify({
      ticketId: 'tk-1', assignmentId: 'as-1', runtime: 'claude-code', handle: 'e46aaf7e',
      workdir: join(home, 'worktrees', 'ra-tk-1-demo'), repo: '/tmp/repo', branch: 'main',
      workBranch: 'ra/tk-1-demo', sessionId: 's1', status: 'running',
    }))

    await runtime.deliver(ref(home), [{ id: 'in_stop', kind: 'followup', text: '继续' }])

    const stops = claude.calls.filter(call => call.argv[0] === 'stop')
    expect(stops.map(call => call.argv[1])).toContain('95c4c910')
    // 不能用 claude rm：部分版本会连带删掉工单的 worktree。
    expect(claude.calls.some(call => call.argv[0] === 'rm')).toBe(false)
  })

  it('追问前先停掉后台 worker，再 resume 同一个会话', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const git = gitRunner()
    const agents = [
      { id: 'e46aaf7e', kind: 'background', state: 'done', status: 'idle', sessionId: 'e46aaf7e-3008-4c2e-99e5-fe312f3bff32' },
    ]
    const claude = scripted(argv => {
      if (argv[0] === 'agents') return { code: 0, stdout: JSON.stringify(agents), stderr: '' }
      if (argv[0] === 'stop') return { code: 0, stdout: 'stopped e46aaf7e\n', stderr: '' }
      if (argv[0] === '--bg') {
        return {
          code: 0,
          stdout: 'backgrounded · e46aaf7e · ra-tk-1-demo\n',
          stderr: 'note: woke session e46aaf7e with its saved options (--dangerously-skip-permissions, --model).\n',
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = new ClaudeCodeRuntime({ claude, git, home, workersDir: join(home, 'workers') })
    mkdirSync(join(home, 'workers', 'tk-1'), { recursive: true })
    writeFileSync(join(home, 'workers', 'tk-1', 'meta.json'), JSON.stringify({
      ticketId: 'tk-1', assignmentId: 'as-1', runtime: 'claude-code', handle: 'e46aaf7e',
      workdir: join(home, 'worktrees', 'ra-tk-1-demo'), repo: '/tmp/repo', branch: 'main',
      workBranch: 'ra/tk-1-demo', sessionId: 'e46aaf7e-3008-4c2e-99e5-fe312f3bff32', status: 'running',
    }))

    const receipt = await runtime.deliver(ref(home), [{ id: 'in_wake', kind: 'followup', text: '继续' }])
    expect(receipt.status).toBe('accepted')

    // 后台 worker 还活着时 CLI 会复制出副本；必须先 stop 再 resume 同一会话。
    const stop = claude.calls.find(call => call.argv[0] === 'stop')
    expect(stop?.argv).toEqual(['stop', 'e46aaf7e'])
    const resume = claude.calls.find(call => call.argv.includes('--resume'))
    expect(resume?.argv).toEqual(['--bg', '--resume', 'e46aaf7e-3008-4c2e-99e5-fe312f3bff32', expect.stringContaining('input-')])
    expect(claude.calls.indexOf(stop!)).toBeLessThan(claude.calls.indexOf(resume!))
  })

  it('兼容新版 Claude 的副本文案 started a copy of that conversation as', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const agents = [
      { id: 'e46aaf7e', kind: 'background', state: 'done', status: 'idle', sessionId: 's1' },
      { id: '95c4c910', kind: 'background', state: 'working', status: 'busy', sessionId: 's2' },
    ]
    const claude = scripted(argv => {
      if (argv[0] === 'agents') return { code: 0, stdout: JSON.stringify(agents), stderr: '' }
      if (argv[0] === '--bg') {
        return {
          code: 0,
          stdout: 'backgrounded · 95c4c910 · ra-tk-1-demo\n',
          stderr: 'note: started a copy of that conversation as 95c4c910. To continue a session under its own id, pass its full session id to --resume.\n',
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = new ClaudeCodeRuntime({ claude, git: gitRunner(), home, workersDir: join(home, 'workers') })
    mkdirSync(join(home, 'workers', 'tk-1'), { recursive: true })
    writeFileSync(join(home, 'workers', 'tk-1', 'meta.json'), JSON.stringify({
      ticketId: 'tk-1', assignmentId: 'as-1', runtime: 'claude-code', handle: 'e46aaf7e',
      workdir: join(home, 'worktrees', 'ra-tk-1-demo'), repo: '/tmp/repo', branch: 'main',
      workBranch: 'ra/tk-1-demo', sessionId: 's1', status: 'running',
    }))
    const receipt = await runtime.deliver(ref(home), [{ id: 'in_4', kind: 'followup', text: '继续' }])
    expect(receipt).toMatchObject({ status: 'rejected', reason: 'claude:resume-forked' })
  })

  it('fork 时即使退出码非 0，也不抛错而是停副本后退避重投', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const agents = [
      { id: 'e46aaf7e', kind: 'background', state: 'done', status: 'idle', sessionId: 's1' },
      { id: '95c4c910', kind: 'background', state: 'working', status: 'busy', sessionId: 's2' },
    ]
    const claude = scripted(argv => {
      if (argv[0] === 'agents') return { code: 0, stdout: JSON.stringify(agents), stderr: '' }
      if (argv[0] === '--bg') {
        return {
          code: 1,
          stdout: 'backgrounded · 95c4c910 · ra-tk-1-demo\n',
          stderr: 'note: session e46aaf7e is already running in the background, so this started a copy as 95c4c910.\n',
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = new ClaudeCodeRuntime({ claude, git: gitRunner(), home, workersDir: join(home, 'workers') })
    mkdirSync(join(home, 'workers', 'tk-1'), { recursive: true })
    writeFileSync(join(home, 'workers', 'tk-1', 'meta.json'), JSON.stringify({
      ticketId: 'tk-1', assignmentId: 'as-1', runtime: 'claude-code', handle: 'e46aaf7e',
      workdir: join(home, 'worktrees', 'ra-tk-1-demo'), repo: '/tmp/repo', branch: 'main',
      workBranch: 'ra/tk-1-demo', sessionId: 's1', status: 'running',
    }))
    const receipt = await runtime.deliver(ref(home), [{ id: 'in_5', kind: 'followup', text: '继续' }])
    expect(receipt).toMatchObject({ status: 'rejected', reason: 'claude:resume-forked', retryable: true })
  })

  it('agents 查询失败时 queued，不盲目 resume', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const claude = scripted(argv => {
      if (argv[0] === 'agents') return { code: 1, stdout: '', stderr: 'temporary failure' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const runtime = new ClaudeCodeRuntime({ claude, git: gitRunner(), home, workersDir: join(home, 'workers') })
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
    const runtime = new ClaudeCodeRuntime({ claude, git: gitRunner(), home, workersDir: join(home, 'workers') })
    const receipt = await runtime.deliver(ref(home, { sessionId: 's1' }), [{ id: 'in_l', kind: 'followup', text: '继续' }])
    expect(receipt.status).toBe('rejected')
    expect(claude.calls.some(call => call.argv.includes('--resume'))).toBe(false)
  })

  it('stop 对不存在的会话幂等', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const claude = scripted(() => ({ code: 1, stdout: "No job matching 'gone'. Run `claude agents` to list running sessions.", stderr: '' }))
    const runtime = new ClaudeCodeRuntime({ claude, git: gitRunner(), home, workersDir: join(home, 'workers') })
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
    const runtime = new ClaudeCodeRuntime({ claude, git, home, workersDir: join(home, 'workers') })
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
    const runtime = new ClaudeCodeRuntime({ claude, git: gitRunner(), home, workersDir: join(home, 'workers'), claudeProjectsDir: projects })
    const snapshot = await runtime.activity({ ref: ref(home, { sessionId }) })
    expect(snapshot?.events[0]?.text).toBe('正在补测试')
  })

  it('removeWorkspace 先删 claude agent view，再删 worktree 目录', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const workdir = join(home, 'worktrees', 'ra-tk-1-demo')
    mkdirSync(workdir, { recursive: true })
    mkdirSync(join(home, 'workers', 'tk-1'), { recursive: true })
    writeFileSync(join(home, 'workers', 'tk-1', 'meta.json'), JSON.stringify({
      ticketId: 'tk-1', assignmentId: 'as-1', runtime: 'claude-code', handle: 'e46aaf7e',
      workdir, repo: '/tmp/repo', branch: 'main', workBranch: 'ra/tk-1-demo',
    }))
    const claude = scripted(() => ({ code: 0, stdout: '', stderr: '' }))
    const git = gitRunner()
    const runtime = new ClaudeCodeRuntime({ claude, git, home, workersDir: join(home, 'workers') })

    await runtime.removeWorkspace({ ticketId: 'tk-1', workdir })
    expect(claude.calls.map(call => call.argv)).toEqual([['rm', 'e46aaf7e']])
    expect(git.calls.some(call => call.argv[0] === 'worktree' && call.argv[1] === 'remove')).toBe(true)
  })

  it('removeWorkspace 对已不存在的 agent 会话幂等，不挡住 worktree 回收', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-claude-'))
    const workdir = join(home, 'worktrees', 'ra-tk-1-demo')
    mkdirSync(workdir, { recursive: true })
    mkdirSync(join(home, 'workers', 'tk-1'), { recursive: true })
    writeFileSync(join(home, 'workers', 'tk-1', 'meta.json'), JSON.stringify({
      ticketId: 'tk-1', assignmentId: 'as-1', runtime: 'claude-code', handle: 'gone',
      workdir, repo: '/tmp/repo', branch: 'main', workBranch: 'ra/tk-1-demo',
    }))
    const claude = scripted(argv => {
      if (argv[0] === 'rm') return { code: 1, stdout: '', stderr: 'no such session' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const git = gitRunner()
    const runtime = new ClaudeCodeRuntime({ claude, git, home, workersDir: join(home, 'workers') })

    await expect(runtime.removeWorkspace({ ticketId: 'tk-1', workdir })).resolves.toBeUndefined()
    expect(git.calls.some(call => call.argv[0] === 'worktree' && call.argv[1] === 'remove')).toBe(true)
  })
})
