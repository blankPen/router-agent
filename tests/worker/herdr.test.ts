import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HerdrRuntime,
  agentNameFor,
  parseAgent,
  parseCliError,
  parseWorktreeList,
  parseWorktreeResult,
  renderInput,
  withWorkdir,
} from '../../src/worker/runtimes/herdr/index.js'
import { herdrAgentKindOf, HERDR_AGENT_KINDS } from '../../src/worker/runtimes/herdr/agents.js'
import {
  agentGet,
  agentPrompt,
  agentRead,
  agentStart,
  paneClose,
  worktreeCreate,
  worktreeList,
  worktreeOpen,
  worktreeRemove,
} from '../../src/worker/runtimes/herdr/commands.js'
import type { CommandRunner, CommandResult } from '../../src/worker/runtimes/herdr/commands.js'
import type { Assignment, Ticket } from '../../src/core/model.js'

class FakeRunner implements CommandRunner {
  calls: string[][] = []
  constructor(private responses: CommandResult[] = []) {}
  async run(argv: string[]): Promise<CommandResult> {
    this.calls.push(argv)
    return this.responses.shift() ?? { code: 0, stdout: '{}', stderr: '' }
  }
}

const ticket: Ticket = {
  id: 'tk-1',
  title: '调研 Herdr',
  threadId: 'feishu:oc_chat:om_root',
  source: 'feishu',
  chatId: 'oc_chat',
  mandateId: 'md_1',
  stage: 'todo',
  repo: '/Users/me/router-agent',
  branch: 'main',
  prNumber: 0,
  prUrl: '',
  prState: 'none',
  createdAt: '2026-11-12T10:00:00.000Z',
  updatedAt: '2026-11-12T10:00:00.000Z',
}

const assignment: Assignment = {
  id: 'as-1',
  ticketId: 'tk-1',
  runtimeId: 'herdr',
  handle: '',
  workdir: '',
  status: 'pending',
  startedAt: '2026-11-12T10:00:00.000Z',
}

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'ra-herdr-'))
}

function createResult(overrides: { pane?: string; workspace?: string; path?: string; branch?: string } = {}) {
  return JSON.stringify({
    id: 'cli:worktree:create',
    result: {
      type: 'worktree_created',
      root_pane: { pane_id: overrides.pane ?? 'w2:p1' },
      workspace: { workspace_id: overrides.workspace ?? 'w2' },
      worktree: {
        path: overrides.path ?? '/Users/admin/.herdr/worktrees/router-agent/ra-tk-1',
        branch: overrides.branch ?? 'ra/tk-1-herdr',
      },
    },
  })
}

function agentInfo(status: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: 'cli:agent:get',
    result: {
      type: 'agent_info',
      agent: {
        agent: 'claude',
        agent_status: status,
        name: 'ra-tk-1-w2-p1',
        pane_id: 'w2:p1',
        state_change_seq: 7,
        ...extra,
      },
    },
  })
}

describe('Herdr 命令构造', () => {
  it('worktree create 带仓库、分支与基线，并且不抢焦点', () => {
    expect(worktreeCreate({ cwd: '/Users/me/repo', branch: 'ra/tk-1-x', base: 'main', label: 'ra-tk-1' })).toEqual([
      'worktree', 'create',
      '--cwd', '/Users/me/repo',
      '--branch', 'ra/tk-1-x',
      '--base', 'main',
      '--label', 'ra-tk-1',
      '--no-focus',
    ])
  })

  it('worktree create 没有基线时不拼 --base', () => {
    const argv = worktreeCreate({ cwd: '/Users/me/repo', branch: 'b' })
    expect(argv).not.toContain('--base')
  })

  it('agent start 用 --kind 与 --pane；没有参数时不传裸 --', () => {
    expect(agentStart({ name: 'ra-tk-1', kind: 'claude', pane: 'w2:p1' })).toEqual([
      'agent', 'start', 'ra-tk-1',
      '--kind', 'claude',
      '--pane', 'w2:p1',
      '--timeout', '60000',
    ])
  })

  it('agent start 把 Agent 参数放在 -- 之后', () => {
    const argv = agentStart({ name: 'ra-tk-1', kind: 'claude', pane: 'w2:p1', args: ['--dangerously-skip-permissions'] })
    expect(argv.slice(-2)).toEqual(['--', '--dangerously-skip-permissions'])
  })

  it('agent prompt / get / read / pane close / worktree remove 参数正确', () => {
    expect(agentPrompt('w2:p1', '你好')).toEqual(['agent', 'prompt', 'w2:p1', '你好'])
    expect(agentGet('w2:p1')).toEqual(['agent', 'get', 'w2:p1'])
    expect(agentRead('w2:p1')).toEqual(['agent', 'read', 'w2:p1', '--source', 'recent-unwrapped', '--lines', '60'])
    expect(agentRead('w2:p1', { lines: 10, source: 'visible' })).toEqual(['agent', 'read', 'w2:p1', '--source', 'visible', '--lines', '10'])
    expect(paneClose('w2:p1')).toEqual(['pane', 'close', 'w2:p1'])
    expect(worktreeRemove('w2')).toEqual(['worktree', 'remove', '--workspace', 'w2'])
    expect(worktreeRemove('w2', { force: true })).toEqual(['worktree', 'remove', '--workspace', 'w2', '--force'])
    expect(worktreeList()).toEqual(['worktree', 'list'])
    expect(worktreeOpen({ cwd: '/Users/me/repo', branch: 'b' })).toEqual([
      'worktree', 'open',
      '--cwd', '/Users/me/repo',
      '--branch', 'b',
      '--no-focus',
    ])
  })
})

describe('Herdr 返回解析', () => {
  it('worktree create 返回路径、分支、pane 与 workspace', () => {
    expect(parseWorktreeResult(createResult())).toEqual({
      path: '/Users/admin/.herdr/worktrees/router-agent/ra-tk-1',
      branch: 'ra/tk-1-herdr',
      paneId: 'w2:p1',
      workspaceId: 'w2',
    })
  })

  it('worktree list 解析成条目列表', () => {
    const stdout = JSON.stringify({
      result: {
        worktrees: [
          { branch: 'main', path: '/private/tmp/repo' },
          { branch: 'ra/tk-1', path: '/Users/admin/.herdr/worktrees/router-agent/ra-tk-1', open_workspace_id: 'w2' },
        ],
      },
    })
    expect(parseWorktreeList(stdout)).toEqual([
      { path: '/private/tmp/repo', branch: 'main' },
      { path: '/Users/admin/.herdr/worktrees/router-agent/ra-tk-1', branch: 'ra/tk-1', workspaceId: 'w2' },
    ])
  })

  it('agent 快照解析出状态与序号', () => {
    const parsed = parseAgent(agentInfo('working'))
    expect(parsed?.status).toBe('working')
    expect(parsed?.kind).toBe('claude')
    expect(parsed?.stateChangeSeq).toBe(7)
  })

  it('没有 agent 字段时返回 null', () => {
    expect(parseAgent('{}')).toBeNull()
  })

  it('错误体从 stderr 里解出 code 与 message', () => {
    const error = parseCliError({
      code: 1,
      stdout: '',
      stderr: '{"id":"cli:agent:get","error":{"code":"agent_not_found","message":"agent target x not found"}}',
    })
    expect(error).toEqual({ code: 'agent_not_found', message: 'agent target x not found' })
  })

  it('非 JSON 的 stderr 返回 null', () => {
    expect(parseCliError({ code: 2, stdout: '', stderr: 'unknown option: --cwd' })).toBeNull()
  })
})

describe('Herdr 运行时', () => {
  it('start 建 worktree、起 Agent、投递契约', async () => {
    const workersDir = workdir()
    const runner = new FakeRunner([
      { code: 0, stdout: createResult(), stderr: '' },
      { code: 0, stdout: agentInfo('idle'), stderr: '' },
      { code: 0, stdout: agentInfo('idle'), stderr: '' },
    ])
    const runtime = new HerdrRuntime({ herdr: runner, git: runner, workersDir })

    const result = await runtime.start({
      ticket,
      assignment,
      workdir: '',
      brief: {
        ticketId: 'tk-1',
        title: 't',
        scope: 's',
        workBranch: 'ra/tk-1-herdr',
        contract: '契约正文\n- 工作目录：(由运行时决定)',
      },
    } as never)

    expect(result.handle).toBe('w2:p1')
    expect(result.workdir).toBe('/Users/admin/.herdr/worktrees/router-agent/ra-tk-1')
    expect(result.workspaceRef).toBe('w2')
    expect(runner.calls[0]![0]).toBe('worktree')
    expect(runner.calls[0]).toContain('/Users/me/router-agent')
    expect(runner.calls[1]![0]).toBe('agent')
    expect(runner.calls[1]).toContain('claude')
    expect(runner.calls[1]).toContain('--dangerously-skip-permissions')
    // 契约里的工作目录占位换成 Herdr 实际建出来的检出路径
    expect(runner.calls[2]).toEqual([
      'agent', 'prompt', 'w2:p1',
      '契约正文\n- 工作目录：/Users/admin/.herdr/worktrees/router-agent/ra-tk-1',
    ])
  })

  it('start 在服务端没跑时抛 runtime:unavailable', async () => {
    const runner = new FakeRunner([
      { code: 1, stdout: '', stderr: '{"error":{"code":"server_not_running","message":"no herdr server is running"}}' },
    ])
    const runtime = new HerdrRuntime({ herdr: runner, git: runner, workersDir: workdir() })
    await expect(runtime.start({ ticket, assignment, workdir: '' } as never)).rejects.toMatchObject({
      code: 'runtime:unavailable',
    })
  })

  it('start 在 Agent 被阻塞时抛 agent:launch-failed 并说明原因', async () => {
    const runner = new FakeRunner([
      { code: 0, stdout: createResult(), stderr: '' },
      { code: 1, stdout: '', stderr: '{"error":{"code":"agent_not_ready","message":"agent is blocked during startup"}}' },
    ])
    const runtime = new HerdrRuntime({ herdr: runner, git: runner, workersDir: workdir() })
    await expect(runtime.start({ ticket, assignment, workdir: '' } as never)).rejects.toMatchObject({
      code: 'agent:launch-failed',
    })
  })

  it('start 拒绝非本地路径的仓库', async () => {
    const runner = new FakeRunner()
    const runtime = new HerdrRuntime({ herdr: runner, git: runner, workersDir: workdir() })
    await expect(
      runtime.start({ ticket: { ...ticket, repo: 'name:router-agent' }, assignment, workdir: '' } as never),
    ).rejects.toMatchObject({ code: 'workspace:missing-repo' })
    expect(runner.calls).toHaveLength(0)
  })

  it('start 失败时回滚已经建出来的检出', async () => {
    const runner = new FakeRunner([
      { code: 0, stdout: createResult(), stderr: '' },
      { code: 1, stdout: '', stderr: '{"error":{"code":"agent_not_ready","message":"blocked"}}' },
      { code: 0, stdout: '{}', stderr: '' },
      { code: 0, stdout: '{}', stderr: '' },
    ])
    const runtime = new HerdrRuntime({ herdr: runner, git: runner, workersDir: workdir() })
    await expect(runtime.start({ ticket, assignment, workdir: '' } as never)).rejects.toThrow()
    expect(runner.calls.some(call => call[0] === 'pane' && call[1] === 'close')).toBe(true)
    expect(runner.calls.some(call => call[0] === 'worktree' && call[1] === 'remove')).toBe(true)
  })

  it('deliver 带上输入 id 投递追问', async () => {
    const runner = new FakeRunner([
      { code: 0, stdout: agentInfo('idle'), stderr: '' },
    ])
    const runtime = new HerdrRuntime({ herdr: runner, git: runner, workersDir: workdir() })
    const receipt = await runtime.deliver(
      { handle: 'w2:p1', ticketId: 'tk-1' },
      [{ id: 'in_abc', kind: 'followup', text: '继续做' }],
    )
    expect(receipt).toEqual({ status: 'accepted', inputIds: ['in_abc'] })
    expect(runner.calls[0]).toEqual(['agent', 'prompt', 'w2:p1', '【Router 输入 in_abc】\n继续做'])
  })

  it('deliver 在 Agent 被阻塞时拒收并允许稍后重投', async () => {
    const runner = new FakeRunner([
      { code: 1, stdout: '', stderr: '{"error":{"code":"agent_blocked","message":"agent is blocked"}}' },
    ])
    const runtime = new HerdrRuntime({ herdr: runner, git: runner, workersDir: workdir() })
    const receipt = await runtime.deliver(
      { handle: 'w2:p1', ticketId: 'tk-1' },
      [{ id: 'in_abc', kind: 'followup', text: '继续做' }],
    )
    expect(receipt).toMatchObject({ status: 'rejected', reason: 'herdr:agent-blocked', retryable: true })
  })

  it('deliver 在 Agent 不存在时不重试', async () => {
    const runner = new FakeRunner([
      { code: 1, stdout: '', stderr: '{"error":{"code":"agent_not_found","message":"not found"}}' },
    ])
    const runtime = new HerdrRuntime({ herdr: runner, git: runner, workersDir: workdir() })
    const receipt = await runtime.deliver(
      { handle: 'w2:p1', ticketId: 'tk-1' },
      [{ id: 'in_abc', kind: 'followup', text: '继续做' }],
    )
    expect(receipt).toMatchObject({ status: 'rejected', reason: 'herdr:agent_not_found', retryable: false })
  })

  it('status 把 Herdr 的屏幕状态映射成中立状态', async () => {
    const cases: [string, string, string][] = [
      ['idle', 'running', 'true'],
      ['done', 'running', 'true'],
      ['working', 'running', 'true'],
      ['blocked', 'blocked', 'false'],
      ['unknown', 'unknown', 'false'],
    ]
    for (const [herdrStatus, phase, accepting] of cases) {
      const runner = new FakeRunner([{ code: 0, stdout: agentInfo(herdrStatus), stderr: '' }])
      const runtime = new HerdrRuntime({ herdr: runner, git: runner, workersDir: workdir() })
      const status = await runtime.status({ handle: 'w2:p1', ticketId: 'tk-1' })
      expect(status?.phase).toBe(phase)
      expect(String(status?.acceptingInput)).toBe(accepting)
    }
  })

  it('status 在 Agent 不存在时判定为 lost', async () => {
    const runner = new FakeRunner([
      { code: 1, stdout: '', stderr: '{"error":{"code":"agent_not_found","message":"not found"}}' },
    ])
    const runtime = new HerdrRuntime({ herdr: runner, git: runner, workersDir: workdir() })
    expect(await runtime.status({ handle: 'w2:p1', ticketId: 'tk-1' })).toMatchObject({
      alive: false,
      phase: 'lost',
    })
  })

  it('status 在查询失败时返回 null（判断不了，不是丢了）', async () => {
    const runner = new FakeRunner([{ code: 1, stdout: '', stderr: 'server_not_running' }])
    const runtime = new HerdrRuntime({ herdr: runner, git: runner, workersDir: workdir() })
    expect(await runtime.status({ handle: 'w2:p1', ticketId: 'tk-1' })).toBeNull()
  })

  it('output 读终端尾部；Agent 忙时退回 visible 源', async () => {
    const runner = new FakeRunner([
      { code: 1, stdout: '', stderr: '{"error":{"code":"agent_not_idle","message":"not idle"}}' },
      { code: 0, stdout: '第一行\n第二行', stderr: '' },
    ])
    const runtime = new HerdrRuntime({ herdr: runner, git: runner, workersDir: workdir() })
    const output = await runtime.output({ handle: 'w2:p1', ticketId: 'tk-1' }, { limit: 5 })
    expect(output?.lines).toEqual(['第一行', '第二行'])
    expect(output?.source).toBe('herdr-visible')
    expect(runner.calls[1]).toContain('visible')
  })

  it('stop 关掉承载 Agent 的 pane；pane 已不在时按幂等处理', async () => {
    const runner = new FakeRunner([
      { code: 1, stdout: '', stderr: '{"error":{"code":"pane_not_found","message":"gone"}}' },
    ])
    const runtime = new HerdrRuntime({ herdr: runner, git: runner, workersDir: workdir() })
    await expect(runtime.stop({ handle: 'w2:p1', ticketId: 'tk-1' }, 'ticket-stopped')).resolves.toBeUndefined()
    expect(runner.calls[0]).toEqual(['pane', 'close', 'w2:p1'])
  })

  it('removeWorkspace 在 workspace 已被关掉时先重新打开再删除', async () => {
    const runner = new FakeRunner([
      { code: 0, stdout: createResult(), stderr: '' },
      { code: 0, stdout: agentInfo('idle'), stderr: '' },
      { code: 0, stdout: agentInfo('idle'), stderr: '' },
      { code: 1, stdout: '', stderr: '{"error":{"code":"workspace_not_found","message":"workspace w2 not found"}}' },
      { code: 0, stdout: createResult({ workspace: 'w7' }), stderr: '' },
      { code: 0, stdout: '{}', stderr: '' },
    ])
    const runtime = new HerdrRuntime({ herdr: runner, git: runner, workersDir: workdir() })
    await runtime.start({ ticket, assignment, workdir: '' } as never)
    await runtime.removeWorkspace({
      ticketId: 'tk-1',
      workdir: '/Users/admin/.herdr/worktrees/router-agent/ra-tk-1',
      workspaceRef: 'w2',
    })
    const opens = runner.calls.filter(call => call[0] === 'worktree' && call[1] === 'open')
    expect(opens).toHaveLength(1)
    expect(opens[0]).toContain('/Users/me/router-agent')
    const removes = runner.calls.filter(call => call[0] === 'worktree' && call[1] === 'remove')
    expect(removes.map(call => call[call.indexOf('--workspace') + 1])).toEqual(['w2', 'w7'])
  })

  it('doctor 检查 CLI 与服务端是否就绪', async () => {
    const runner = new FakeRunner([
      { code: 0, stdout: 'herdr 0.9.5', stderr: '' },
      { code: 0, stdout: 'status: running\nversion: 0.9.5\n', stderr: '' },
    ])
    const runtime = new HerdrRuntime({ herdr: runner, git: runner, workersDir: workdir() })
    const checks = await runtime.doctor()
    expect(checks.map(check => check.status)).toEqual(['ok', 'ok'])
    expect(checks[1]!.detail).toBe('0.9.5')
  })

  it('doctor 在服务端没跑时给出 fail 与提示', async () => {
    const runner = new FakeRunner([
      { code: 0, stdout: 'herdr 0.9.5', stderr: '' },
      { code: 0, stdout: 'status: not running\n', stderr: '' },
    ])
    const runtime = new HerdrRuntime({ herdr: runner, git: runner, workersDir: workdir() })
    const checks = await runtime.doctor()
    expect(checks[1]!.status).toBe('fail')
    expect(checks[1]!.hint).toMatch(/herdr server/)
  })

  it('repoSlug 从检出的 origin 解析 owner/repo', async () => {
    const herdr = new FakeRunner()
    const git = new FakeRunner([
      { code: 0, stdout: 'git@github.com:blankPen/router-agent.git\n', stderr: '' },
    ])
    const runtime = new HerdrRuntime({ herdr, git, workersDir: workdir() })
    expect(await runtime.repoSlug({ handle: 'w2:p1', ticketId: 'tk-1', workdir: '/tmp/wt' })).toBe('blankPen/router-agent')
    expect(git.calls[0]).toEqual(['remote', 'get-url', 'origin'])
  })

  it('repoSlug 在远端不是 GitHub 时返回 null', async () => {
    const git = new FakeRunner([
      { code: 0, stdout: 'git@gitlab.com:o/r.git\n', stderr: '' },
    ])
    const runtime = new HerdrRuntime({ herdr: new FakeRunner(), git, workersDir: workdir() })
    expect(await runtime.repoSlug({ handle: 'w2:p1', ticketId: 'tk-1', workdir: '/tmp/wt' })).toBeNull()
  })
})

describe('Herdr Agent kind', () => {
  it('claude 的无人值守参数会跳过「信任此文件夹」弹窗', () => {
    expect(herdrAgentKindOf('claude')?.args).toContain('--dangerously-skip-permissions')
  })

  it('未知 kind 返回 undefined', () => {
    expect(herdrAgentKindOf('nope')).toBeUndefined()
    expect(herdrAgentKindOf('')).toBeUndefined()
  })

  it('目录里的 kind 都有可用的无人值守参数', () => {
    for (const kind of HERDR_AGENT_KINDS) {
      expect(kind.args.length).toBeGreaterThan(0)
    }
  })
})

describe('Herdr 辅助函数', () => {
  it('Agent 名字匹配 Herdr 的命名规则且带 pane 标识', () => {
    expect(agentNameFor('tk-1', 'w2:p1')).toBe('ra-tk-1-w2-p1')
    expect(agentNameFor('tk-1', 'w2:p1')).toMatch(/^[a-z][a-z0-9_-]{0,31}$/)
  })

  it('超长工单号会被截断到 32 字符以内', () => {
    const name = agentNameFor('tk-with-a-very-long-identifier-0123456789', 'w12:p3')
    expect(name.length).toBeLessThanOrEqual(32)
    expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/)
  })

  it('投递文本带上 Router 输入 id', () => {
    expect(renderInput({ id: 'in_1', kind: 'followup', text: '继续' })).toBe('【Router 输入 in_1】\n继续')
  })

  it('契约里的工作目录占位被换成真实检出路径', () => {
    expect(withWorkdir('- 工作目录：(由运行时决定)', '/tmp/wt')).toBe('- 工作目录：/tmp/wt')
    expect(withWorkdir('- 工作目录：(由 Orca 决定)', '/tmp/wt')).toBe('- 工作目录：/tmp/wt')
    expect(withWorkdir('没有占位', '/tmp/wt')).toBe('没有占位')
    expect(withWorkdir('没有占位', '')).toBe('没有占位')
  })
})

describe('Herdr 元数据', () => {
  it('start 把 pane、workspace 与 Agent 写进 meta.json', async () => {
    const workersDir = workdir()
    const runner = new FakeRunner([
      { code: 0, stdout: createResult(), stderr: '' },
      { code: 0, stdout: agentInfo('idle'), stderr: '' },
      { code: 0, stdout: agentInfo('idle'), stderr: '' },
    ])
    const runtime = new HerdrRuntime({ herdr: runner, git: runner, workersDir })
    await runtime.start({ ticket, assignment, workdir: '' } as never)
    const meta = JSON.parse(readFileSync(join(workersDir, 'tk-1', 'meta.json'), 'utf8'))
    expect(meta.handle).toBe('w2:p1')
    expect(meta.paneId).toBe('w2:p1')
    expect(meta.workspaceId).toBe('w2')
    expect(meta.workBranch).toBe('ra/tk-1-herdr')
    expect(meta.agent).toBe('claude')
  })
})
