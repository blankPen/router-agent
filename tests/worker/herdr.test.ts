import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HerdrRuntime,
  agentNameFor,
  parseAgent,
  parseCliError,
  parseStalePaneId,
  parseWorkspaceResult,
  renderInput,
  shortHash,
  withWorkdir,
} from '#runtime/runtimes/herdr/index.js'
import { ensureHerdrServer, probeHerdrServer } from '#runtime/runtimes/herdr/server.js'
import { herdrAgentKindOf, HERDR_AGENT_KINDS } from '#runtime/runtimes/herdr/agents.js'
import {
  agentGet,
  agentPrompt,
  agentRead,
  agentSendKeys,
  agentStart,
  paneClose,
  paneRead,
  serverStatus,
  version,
  workspaceClose,
  workspaceCreate,
} from '#runtime/runtimes/herdr/commands.js'
import type { CommandRunner, CommandResult } from '#runtime/runtimes/herdr/commands.js'
import type { Assignment, Ticket } from '#core/model.js'

/**
 * Herdr 侧的假 runner：按命令分派，而不是按调用顺序 —— 派工流程里命令条数多，
 * 顺序一改测试就假失败。
 */
class FakeHerdr implements CommandRunner {
  calls: string[][] = []
  serverRunning: boolean
  agentStatus = 'idle'
  paneText = ''
  agentStartResult?: CommandResult
  agentStartResults?: CommandResult[]
  agentGetResult?: CommandResult
  agentPromptResult?: CommandResult
  paneCloseResult?: CommandResult
  workspaceCreateResult?: CommandResult

  constructor(opts: { serverRunning?: boolean } = {}) {
    this.serverRunning = opts.serverRunning ?? true
  }

  async run(argv: string[]): Promise<CommandResult> {
    this.calls.push(argv)
    const key = argv.slice(0, 2).join(' ')
    switch (key) {
      case 'status server':
        return this.serverRunning
          ? { code: 0, stdout: 'status: running\nversion: 0.9.5\n', stderr: '' }
          : { code: 0, stdout: 'status: not running\n', stderr: '' }
      case 'workspace create':
        return this.workspaceCreateResult ?? { code: 0, stdout: workspaceResult(), stderr: '' }
      case 'agent start':
        if (this.agentStartResults?.length) return this.agentStartResults.shift()!
        return this.agentStartResult ?? { code: 0, stdout: agentInfo(this.agentStatus), stderr: '' }
      case 'agent get':
        return this.agentGetResult ?? { code: 0, stdout: agentInfo(this.agentStatus), stderr: '' }
      case 'agent prompt':
        return this.agentPromptResult ?? { code: 0, stdout: agentInfo(this.agentStatus), stderr: '' }
      case 'agent read':
        return { code: 0, stdout: '第一行\n第二行', stderr: '' }
      case 'agent send-keys':
        return { code: 0, stdout: '{"result":{"type":"ok"}}', stderr: '' }
      case 'pane read':
        return { code: 0, stdout: this.paneText, stderr: '' }
      case 'pane close':
        return this.paneCloseResult ?? { code: 0, stdout: '{"result":{"type":"ok"}}', stderr: '' }
      case 'workspace close':
        return { code: 0, stdout: '{"result":{"type":"ok"}}', stderr: '' }
      default:
        return { code: 0, stdout: '{}', stderr: '' }
    }
  }
}

/** git 侧的假 runner：按 git 子命令分派。 */
class FakeGit implements CommandRunner {
  calls: string[][] = []
  callsWithCwd: Array<{ argv: string[]; cwd?: string }> = []
  removed: string[] = []
  branchExists = false
  removeFails = false
  remote = 'git@github.com:blankPen/router-agent.git\n'

  async run(argv: string[], opts?: { cwd?: string }): Promise<CommandResult> {
    this.calls.push(argv)
    this.callsWithCwd.push({ argv, cwd: opts?.cwd })
    // `git -C <dir> <cmd>` 形态与 `git <cmd>` 形态都支持。
    const args = argv[0] === '-C' ? argv.slice(2) : argv
    if (args[0] === 'check-ref-format') return { code: 0, stdout: '', stderr: '' }
    if (args[0] === 'show-ref') {
      return this.branchExists ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: '' }
    }
    if (args[0] === 'worktree' && args[1] === 'add') return { code: 0, stdout: '', stderr: '' }
    if (args[0] === 'worktree' && args[1] === 'remove') {
      if (this.removeFails && !argv.includes('--force')) {
        return { code: 1, stdout: '', stderr: 'contains modified or untracked files' }
      }
      this.removed.push(argv[argv.length - 1]!)
      return { code: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'rev-parse') return { code: 0, stdout: 'ra/tk-1-herdr\n', stderr: '' }
    if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' }
    if (args[0] === 'remote') return { code: 0, stdout: this.remote, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
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

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'ra-herdr-'))
}

function workspaceResult(overrides: { pane?: string; workspace?: string } = {}) {
  return JSON.stringify({
    id: 'cli:workspace:create',
    result: {
      type: 'workspace_created',
      root_pane: { pane_id: overrides.pane ?? 'w2:p1', tab_id: 'w2:t1' },
      workspace: { workspace_id: overrides.workspace ?? 'w2' },
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
        name: 'ra-router-agent-tk-1-he-1a2b3c4d',
        pane_id: 'w2:p1',
        state_change_seq: 7,
        ...extra,
      },
    },
  })
}

function cliError(code: string, message: string): CommandResult {
  return { code: 1, stdout: '', stderr: JSON.stringify({ error: { code, message } }) }
}

function makeRuntime(opts: { herdr?: FakeHerdr; git?: FakeGit; home?: string } = {}) {
  const herdr = opts.herdr ?? new FakeHerdr()
  const git = opts.git ?? new FakeGit()
  const home = opts.home ?? tempHome()
  const runtime = new HerdrRuntime({
    herdr,
    git,
    workersDir: join(home, 'workers'),
    home,
  })
  return { runtime, herdr, git, home }
}

describe('Herdr 命令构造', () => {
  it('workspace create 带目录与标签，并且不抢焦点', () => {
    expect(workspaceCreate({ cwd: '/Users/me/wt', label: 'ra-tk-1' })).toEqual([
      'workspace', 'create',
      '--cwd', '/Users/me/wt',
      '--label', 'ra-tk-1',
      '--no-focus',
    ])
  })

  it('workspace create 没有标签时不拼 --label', () => {
    expect(workspaceCreate({ cwd: '/Users/me/wt' })).not.toContain('--label')
  })

  it('workspace close 带 workspace id', () => {
    expect(workspaceClose('w2')).toEqual(['workspace', 'close', 'w2'])
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

  it('agent prompt / get / read / send-keys / pane close / pane read 参数正确', () => {
    expect(agentPrompt('w2:p1', '你好')).toEqual(['agent', 'prompt', 'w2:p1', '你好'])
    expect(agentGet('w2:p1')).toEqual(['agent', 'get', 'w2:p1'])
    expect(agentRead('w2:p1')).toEqual(['agent', 'read', 'w2:p1', '--source', 'recent-unwrapped', '--lines', '60'])
    expect(agentRead('w2:p1', { lines: 10, source: 'visible' })).toEqual(['agent', 'read', 'w2:p1', '--source', 'visible', '--lines', '10'])
    expect(agentSendKeys('w2:p1', ['down'])).toEqual(['agent', 'send-keys', 'w2:p1', 'down'])
    expect(paneClose('w2:p1')).toEqual(['pane', 'close', 'w2:p1'])
    expect(paneRead('w2:p1')).toEqual(['pane', 'read', 'w2:p1', '--source', 'visible', '--lines', '40'])
    expect(serverStatus()).toEqual(['status', 'server'])
    expect(version()).toEqual(['--version'])
  })
})

describe('Herdr 返回解析', () => {
  it('workspace create 返回 pane 与 workspace', () => {
    expect(parseWorkspaceResult(workspaceResult())).toEqual({
      paneId: 'w2:p1',
      workspaceId: 'w2',
      tabId: 'w2:t1',
    })
  })

  it('workspace create 返回缺字段时只给有的那些', () => {
    expect(parseWorkspaceResult('{"result":{}}')).toEqual({})
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

  it('从「名字被占用」的错误里解出占用者的 pane', () => {
    const message = 'agent name probe1 is already used; candidates: terminal_id=term_1 pane_id=w5:p1 workspace_id=w5'
    expect(parseStalePaneId(message)).toBe('w5:p1')
    expect(parseStalePaneId('no pane here')).toBeNull()
  })
})

describe('Herdr 服务端自启', () => {
  it('探测时能认出在跑的服务端', async () => {
    const herdr = new FakeHerdr({ serverRunning: true })
    expect(await probeHerdrServer(herdr)).toMatchObject({ running: true, version: '0.9.5' })
  })

  it('探测时能认出没在跑的服务端', async () => {
    const herdr = new FakeHerdr({ serverRunning: false })
    const state = await probeHerdrServer(herdr)
    expect(state.running).toBe(false)
    expect(state.reason).toBeTruthy()
  })

  it('服务端已经在跑时不会重复拉起', async () => {
    const herdr = new FakeHerdr({ serverRunning: true })
    const spawned: string[] = []
    const state = await ensureHerdrServer({ runner: herdr, spawnFn: bin => spawned.push(bin) })
    expect(state).toMatchObject({ running: true, started: false })
    expect(spawned).toEqual([])
  })

  it('服务端没在跑时会被拉起来', async () => {
    const herdr = new FakeHerdr({ serverRunning: false })
    const spawned: string[] = []
    const state = await ensureHerdrServer({
      runner: herdr,
      spawnFn: bin => {
        spawned.push(bin)
        herdr.serverRunning = true
      },
      timeoutMs: 2_000,
      pollMs: 10,
    })
    expect(state).toMatchObject({ running: true, started: true })
    expect(spawned).toEqual(['herdr'])
  })

  it('拉起动作抛错时给出原因，不假装成功', async () => {
    const herdr = new FakeHerdr({ serverRunning: false })
    const state = await ensureHerdrServer({
      runner: herdr,
      spawnFn: () => { throw new Error('EACCES') },
      timeoutMs: 100,
      pollMs: 10,
    })
    expect(state.running).toBe(false)
    expect(state.reason).toContain('EACCES')
  })

  it('拉起来之后仍然没跑时超时退出', async () => {
    const herdr = new FakeHerdr({ serverRunning: false })
    const state = await ensureHerdrServer({
      runner: herdr,
      spawnFn: () => {},
      timeoutMs: 60,
      pollMs: 10,
    })
    expect(state.running).toBe(false)
    expect(state.reason).toContain('超时')
  })
})

describe('Herdr 运行时', () => {
  it('start 用 git worktree 建检出、用 Herdr 开窗口起 Agent', async () => {
    const { runtime, herdr, git, home } = makeRuntime()
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

    // 检出归 ra 自己管：走 git worktree，不碰 Herdr 的仓库登记。
    const adds = git.calls.filter(call => call[0] === 'worktree' && call[1] === 'add')
    expect(adds).toHaveLength(1)
    expect(adds[0]).toContain('ra/tk-1-herdr')
    expect(adds[0]).toContain(join(home, 'worktrees', 'ra-tk-1-herdr'))
    expect(herdr.calls.some(call => call[0] === 'worktree')).toBe(false)

    expect(result.handle).toBe('w2:p1')
    expect(result.workdir).toBe(join(home, 'worktrees', 'ra-tk-1-herdr'))
    expect(result.workspaceRef).toBe('w2')

    // Herdr 侧只做「开窗口 + 跑 Agent + 投输入」。
    const created = herdr.calls.find(call => call[0] === 'workspace' && call[1] === 'create')!
    expect(created).toContain(result.workdir)
    const started = herdr.calls.find(call => call[0] === 'agent' && call[1] === 'start')!
    expect(started).toContain('claude')
    expect(started).toContain('--dangerously-skip-permissions')
    expect(started).toContain('w2:p1')
    // 契约里的工作目录占位换成真实检出路径
    const prompted = herdr.calls.find(call => call[0] === 'agent' && call[1] === 'prompt')!
    expect(prompted[3]).toBe(`契约正文\n- 工作目录：${result.workdir}`)
  })

  it('start 在服务端没跑时把它拉起来', async () => {
    const herdr = new FakeHerdr({ serverRunning: false })
    const home = tempHome()
    const spawned: string[] = []
    const runtime = new HerdrRuntime({
      herdr,
      git: new FakeGit(),
      workersDir: join(home, 'workers'),
      home,
      spawnServer: bin => {
        spawned.push(bin)
        herdr.serverRunning = true
      },
    })
    await runtime.start({ ticket, assignment, workdir: '' } as never)
    expect(spawned).toEqual(['herdr'])
  })

  it('start 在服务端拉不起来时抛 runtime:unavailable', async () => {
    const herdr = new FakeHerdr({ serverRunning: false })
    const runtime = new HerdrRuntime({
      herdr,
      git: new FakeGit(),
      workersDir: join(tempHome(), 'workers'),
      home: tempHome(),
      spawnServer: () => { throw new Error('boom') },
    })
    await expect(runtime.start({ ticket, assignment, workdir: '' } as never)).rejects.toMatchObject({
      code: 'runtime:unavailable',
    })
  })

  it('start 遇到「信任此文件夹」弹窗时自动确认并继续', async () => {
    const herdr = new FakeHerdr()
    herdr.agentStartResult = cliError('agent_not_ready', 'agent is blocked during startup')
    herdr.paneText = 'Quick safety check: Is this a project you created or one you trust?\n No, exit\n   Yes, I trust this folder'
    const { runtime, git } = makeRuntime({ herdr })
    const result = await runtime.start({ ticket, assignment, workdir: '' } as never)
    expect(result.handle).toBe('w2:p1')
    const reads = herdr.calls.filter(call => call[0] === 'pane' && call[1] === 'read')
    expect(reads).toHaveLength(1)
    const keys = herdr.calls.filter(call => call[0] === 'agent' && call[1] === 'send-keys')
    expect(keys.map(call => call[3])).toEqual(['down', 'enter'])
    expect(herdr.calls.some(call => call[0] === 'agent' && call[1] === 'prompt')).toBe(true)
    expect(git.calls.some(call => call[0] === 'worktree' && call[1] === 'add')).toBe(true)
  })

  it('start 遇到别的阻塞弹窗时不乱按键，直接失败', async () => {
    const herdr = new FakeHerdr()
    herdr.agentStartResult = cliError('agent_not_ready', 'agent is blocked during startup')
    herdr.paneText = 'Do you want to continue?'
    const { runtime } = makeRuntime({ herdr })
    await expect(runtime.start({ ticket, assignment, workdir: '' } as never)).rejects.toMatchObject({
      code: 'agent:launch-failed',
    })
    expect(herdr.calls.some(call => call[0] === 'agent' && call[1] === 'send-keys')).toBe(false)
  })

  it('start 遇到名字被占用时回收旧窗口再试一次', async () => {
    const herdr = new FakeHerdr()
    herdr.agentStartResults = [
      cliError('agent_name_taken', 'agent name ra-x is already used; candidates: terminal_id=term_1 pane_id=w9:p1 workspace_id=w9'),
      { code: 0, stdout: agentInfo('idle'), stderr: '' },
    ]
    const { runtime } = makeRuntime({ herdr })
    await runtime.start({ ticket, assignment, workdir: '' } as never)
    const closes = herdr.calls.filter(call => call[0] === 'pane' && call[1] === 'close')
    expect(closes.map(call => call[2])).toContain('w9:p1')
    expect(herdr.calls.filter(call => call[0] === 'agent' && call[1] === 'start')).toHaveLength(2)
  })

  it('start 失败时回滚已经建出来的窗口与检出', async () => {
    const herdr = new FakeHerdr()
    herdr.agentStartResult = cliError('agent_not_ready', 'blocked')
    herdr.paneText = 'Do you want to continue?'
    const { runtime, git } = makeRuntime({ herdr })
    await expect(runtime.start({ ticket, assignment, workdir: '' } as never)).rejects.toThrow()
    expect(herdr.calls.some(call => call[0] === 'pane' && call[1] === 'close')).toBe(true)
    expect(herdr.calls.some(call => call[0] === 'workspace' && call[1] === 'close')).toBe(true)
    expect(git.removed.length).toBeGreaterThan(0)
  })

  it('start 拒绝非本地路径的仓库', async () => {
    const { runtime, herdr } = makeRuntime()
    await expect(
      runtime.start({ ticket: { ...ticket, repo: 'name:router-agent' }, assignment, workdir: '' } as never),
    ).rejects.toMatchObject({ code: 'workspace:missing-repo' })
    expect(herdr.calls).toHaveLength(0)
  })

  it('deliver 带上输入 id 投递追问', async () => {
    const { runtime, herdr } = makeRuntime()
    const receipt = await runtime.deliver(
      { handle: 'w2:p1', ticketId: 'tk-1' },
      [{ id: 'in_abc', kind: 'followup', text: '继续做' }],
    )
    expect(receipt).toEqual({ status: 'accepted', inputIds: ['in_abc'] })
    expect(herdr.calls.find(call => call[0] === 'agent' && call[1] === 'prompt')).toEqual([
      'agent', 'prompt', 'w2:p1', '【Router 输入 in_abc】\n继续做',
    ])
  })

  it('deliver 在 Agent 被阻塞时拒收并允许稍后重投', async () => {
    const herdr = new FakeHerdr()
    herdr.agentPromptResult = cliError('agent_blocked', 'agent is blocked')
    const { runtime } = makeRuntime({ herdr })
    const receipt = await runtime.deliver(
      { handle: 'w2:p1', ticketId: 'tk-1' },
      [{ id: 'in_abc', kind: 'followup', text: '继续做' }],
    )
    expect(receipt).toMatchObject({ status: 'rejected', reason: 'herdr:agent-blocked', retryable: true })
  })

  it('deliver 在 Agent 不存在时不重试', async () => {
    const herdr = new FakeHerdr()
    herdr.agentPromptResult = cliError('agent_not_found', 'not found')
    const { runtime } = makeRuntime({ herdr })
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
      const herdr = new FakeHerdr()
      herdr.agentStatus = herdrStatus
      const { runtime } = makeRuntime({ herdr })
      const status = await runtime.status({ handle: 'w2:p1', ticketId: 'tk-1' })
      expect(status?.phase).toBe(phase)
      expect(String(status?.acceptingInput)).toBe(accepting)
    }
  })

  it('status 在 Agent 不存在时判定为 lost', async () => {
    const herdr = new FakeHerdr()
    herdr.agentGetResult = cliError('agent_not_found', 'not found')
    const { runtime } = makeRuntime({ herdr })
    expect(await runtime.status({ handle: 'w2:p1', ticketId: 'tk-1' })).toMatchObject({
      alive: false,
      phase: 'lost',
    })
  })

  it('status 在查询失败时返回 null（判断不了，不是丢了）', async () => {
    const herdr = new FakeHerdr()
    herdr.agentGetResult = { code: 1, stdout: '', stderr: 'server_not_running' }
    const { runtime } = makeRuntime({ herdr })
    expect(await runtime.status({ handle: 'w2:p1', ticketId: 'tk-1' })).toBeNull()
  })

  it('output 读终端尾部；Agent 忙时退回 visible 源', async () => {
    let calls = 0
    const runtime = new HerdrRuntime({
      herdr: {
        run: async () => {
          calls += 1
          if (calls === 1) return cliError('agent_not_idle', 'not idle')
          return { code: 0, stdout: '第一行\n第二行', stderr: '' }
        },
      },
      git: new FakeGit(),
      workersDir: join(tempHome(), 'workers'),
      home: tempHome(),
    })
    const output = await runtime.output({ handle: 'w2:p1', ticketId: 'tk-1' }, { limit: 5 })
    expect(output?.lines).toEqual(['第一行', '第二行'])
    expect(output?.source).toBe('herdr-visible')
  })

  it('stop 关掉承载 Agent 的 pane 与 workspace；pane 已不在时按幂等处理', async () => {
    const herdr = new FakeHerdr()
    herdr.paneCloseResult = cliError('pane_not_found', 'gone')
    const { runtime } = makeRuntime({ herdr })
    await expect(runtime.stop({ handle: 'w2:p1', ticketId: 'tk-1' }, 'ticket-stopped')).resolves.toBeUndefined()
    expect(herdr.calls.find(call => call[0] === 'pane' && call[1] === 'close')).toEqual(['pane', 'close', 'w2:p1'])
  })

  it('removeWorkspace 关窗口后用 git 删掉检出', async () => {
    const { runtime, herdr, git } = makeRuntime()
    const started = await runtime.start({ ticket, assignment, workdir: '' } as never)
    await runtime.removeWorkspace({ ticketId: 'tk-1', workdir: started.workdir, workspaceRef: 'w2' })
    expect(herdr.calls.some(call => call[0] === 'pane' && call[1] === 'close')).toBe(true)
    expect(herdr.calls.some(call => call[0] === 'workspace' && call[1] === 'close')).toBe(true)
    expect(git.removed).toContain(started.workdir)
  })

  it('removeWorkspace 在仓库上下文里删检出', async () => {
    const { runtime, git } = makeRuntime()
    const started = await runtime.start({ ticket, assignment, workdir: '' } as never)
    await runtime.removeWorkspace({ ticketId: 'tk-1', workdir: started.workdir, workspaceRef: 'w2' })
    // `git worktree remove` 必须在仓库上下文里跑，否则报 "not a git repository"。
    const removes = git.callsWithCwd.filter(call => call.argv[0] === 'worktree' && call.argv[1] === 'remove')
    expect(removes).toHaveLength(1)
    expect(removes[0]!.cwd).toBe('/Users/me/router-agent')
  })

  it('removeWorkspace 在检出有改动时强制删除', async () => {
    const git = new FakeGit()
    git.removeFails = true
    const { runtime } = makeRuntime({ git })
    const started = await runtime.start({ ticket, assignment, workdir: '' } as never)
    await runtime.removeWorkspace({ ticketId: 'tk-1', workdir: started.workdir, workspaceRef: 'w2' })
    expect(git.removed).toContain(started.workdir)
    expect(git.calls.some(call => call.includes('--force'))).toBe(true)
  })

  it('doctor 检查 CLI 与服务端，并在服务端没跑时自动拉起', async () => {
    const herdr = new FakeHerdr({ serverRunning: false })
    const spawned: string[] = []
    const runtime = new HerdrRuntime({
      herdr,
      git: new FakeGit(),
      workersDir: join(tempHome(), 'workers'),
      home: tempHome(),
      spawnServer: bin => {
        spawned.push(bin)
        herdr.serverRunning = true
      },
    })
    const checks = await runtime.doctor()
    expect(checks.map(check => check.status)).toEqual(['ok', 'ok'])
    expect(checks[1]!.detail).toContain('已自动拉起')
    expect(spawned).toEqual(['herdr'])
  })

  it('doctor 在 CLI 缺失时直接判 fail', async () => {
    const runtime = new HerdrRuntime({
      herdr: { run: async () => ({ code: 127, stdout: '', stderr: 'not found' }) },
      git: new FakeGit(),
      workersDir: join(tempHome(), 'workers'),
      home: tempHome(),
    })
    const checks = await runtime.doctor()
    expect(checks.map(check => check.status)).toEqual(['fail', 'fail'])
    expect(checks[0]!.hint).toMatch(/herdr/)
  })

  it('repoSlug 从检出的 origin 解析 owner/repo', async () => {
    const git = new FakeGit()
    const { runtime, home } = makeRuntime({ git })
    const workdir = join(home, 'worktrees', 'ra-tk-1-herdr')
    expect(await runtime.repoSlug({ handle: 'w2:p1', ticketId: 'tk-1', workdir })).toBe('blankPen/router-agent')
    expect(git.calls[0]).toEqual(['remote', 'get-url', 'origin'])
  })

  it('repoSlug 在远端不是 GitHub 时返回 null', async () => {
    const git = new FakeGit()
    git.remote = 'git@gitlab.com:o/r.git\n'
    const { runtime, home } = makeRuntime({ git })
    const workdir = join(home, 'worktrees', 'ra-tk-1-herdr')
    expect(await runtime.repoSlug({ handle: 'w2:p1', ticketId: 'tk-1', workdir })).toBeNull()
  })
})

describe('Herdr Agent kind', () => {
  it('claude 的无人值守参数会跳过权限确认', () => {
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

describe('Herdr Agent 命名', () => {
  it('名字匹配 Herdr 的命名规则且以短哈希结尾', () => {
    const name = agentNameFor({ kind: 'claude', repo: '/Users/me/router-agent', branch: 'ra/tk-1-herdr' })
    expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/)
    expect(name.endsWith(shortHash('claude\n/Users/me/router-agent\nra/tk-1-herdr'))).toBe(true)
  })

  it('同样的工具 + 路径 + 分支永远得到同一个名字', () => {
    const args = { kind: 'claude', repo: '/Users/me/router-agent', branch: 'ra/tk-1-herdr' }
    expect(agentNameFor(args)).toBe(agentNameFor({ ...args }))
  })

  it('换工具、换路径、换分支都会得到不同的名字', () => {
    const base = agentNameFor({ kind: 'claude', repo: '/Users/me/router-agent', branch: 'ra/tk-1-herdr' })
    expect(agentNameFor({ kind: 'codex', repo: '/Users/me/router-agent', branch: 'ra/tk-1-herdr' })).not.toBe(base)
    expect(agentNameFor({ kind: 'claude', repo: '/Users/me/other', branch: 'ra/tk-1-herdr' })).not.toBe(base)
    expect(agentNameFor({ kind: 'claude', repo: '/Users/me/router-agent', branch: 'ra/tk-2-herdr' })).not.toBe(base)
  })

  it('名字里带上项目名与分支，方便人类在侧栏辨认', () => {
    const name = agentNameFor({ kind: 'claude', repo: '/Users/me/router-agent', branch: 'ra/tk-1-herdr' })
    expect(name.startsWith('ra-router-agent-tk-1')).toBe(true)
  })

  it('超长项目名与分支名会被截断，但哈希后缀保留', () => {
    const name = agentNameFor({
      kind: 'claude',
      repo: '/Users/me/a-very-long-repository-name-here',
      branch: 'ra/tk-with-a-very-long-identifier-0123456789',
    })
    expect(name.length).toBeLessThanOrEqual(32)
    expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/)
    expect(name.endsWith(shortHash('claude\n/Users/me/a-very-long-repository-name-here\nra/tk-with-a-very-long-identifier-0123456789'))).toBe(true)
  })

  it('短哈希是稳定的 16 进制串', () => {
    expect(shortHash('abc')).toBe(shortHash('abc'))
    expect(shortHash('abc')).toMatch(/^[0-9a-f]{8}$/)
    expect(shortHash('abc', 16)).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('Herdr 辅助函数', () => {
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
  it('start 把 pane、workspace、Agent 与名字写进 meta.json', async () => {
    const { runtime, home } = makeRuntime()
    await runtime.start({ ticket, assignment, workdir: '' } as never)
    const meta = JSON.parse(readFileSync(join(home, 'workers', 'tk-1', 'meta.json'), 'utf8'))
    expect(meta.handle).toBe('w2:p1')
    expect(meta.paneId).toBe('w2:p1')
    expect(meta.workspaceId).toBe('w2')
    expect(meta.workBranch).toBe('ra/tk-1-herdr')
    expect(meta.agent).toBe('claude')
    expect(meta.agentName).toBe(agentNameFor({ kind: 'claude', repo: '/Users/me/router-agent', branch: 'ra/tk-1-herdr' }))
  })
})
