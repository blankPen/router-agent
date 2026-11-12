import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrcaRuntime, OrcaCommandError, parseCreateResult, summarizeArgs } from '@router-agent/runtime-orca'
import { claudeProjectSlug, describeToolInfo, describeToolUse } from '#runtime/agents/claude.js'
import { worktreeCreate, terminalSend, terminalClose, terminalList, terminalRead, worktreeRemove, agentLaunch } from '@router-agent/runtime-orca'
import type { CommandRunner, CommandResult } from '@router-agent/runtime-orca'
import type { Assignment, Ticket } from '#core/model.js'
import { buildNeutralContract, buildWorkerPrompt } from '#runtime/spec/index.js'

class FakeRunner implements CommandRunner {
  calls: { argv: string[]; cwd?: string }[] = []
  constructor(private responses: CommandResult[] = []) {}
  async run(argv: string[], opts: { cwd?: string } = {}): Promise<CommandResult> {
    this.calls.push({ argv, ...(opts.cwd ? { cwd: opts.cwd } : {}) })
    return this.responses.shift() ?? { code: 0, stdout: '{"ok":true,"result":{}}', stderr: '' }
  }
}

const ticket: Ticket = {
  id: 'tk_1',
  title: '调整登录超时',
  threadId: 'feishu:oc_chat:om_root',
  source: 'feishu',
  chatId: 'oc_chat',
  mandateId: 'md_1',
  stage: 'todo',
  repo: 'dsh/router-agent',
  branch: 'main',
  prNumber: 0,
  prUrl: '',
  prState: 'none',
  createdAt: '2026-11-06T10:00:00.000Z',
  updatedAt: '2026-11-06T10:00:00.000Z',
}

const assignment: Assignment = {
  id: 'as_1',
  ticketId: 'tk_1',
  runtimeId: 'orca',
  handle: '',
  workdir: '',
  status: 'pending',
  startedAt: '2026-11-06T10:00:00.000Z',
}

describe('Orca 命令构造', () => {
  it('worktree create 不写死 Agent：不传 agent 时不拼 --agent', () => {
    expect(worktreeCreate({ repo: 'dsh/router-agent', name: 'ra-tk_1', prompt: '做这个' })).toEqual([
      'worktree', 'create',
      '--repo', 'name:dsh/router-agent',
      '--name', 'ra-tk_1',
      '--surface', 'terminal',
      '--prompt', '做这个',
      '--no-parent',
      '--setup', 'skip',
      '--json',
    ])
  })

  it('worktree create 配了 Agent 时传 --agent', () => {
    const argv = worktreeCreate({ repo: 'dsh/router-agent', name: 'ra-tk_1', prompt: '做这个', agent: 'codex' })
    expect(argv).toContain('--agent')
    expect(argv[argv.indexOf('--agent') + 1]).toBe('codex')
  })

  it('repo 支持直接写 Orca 选择器（id: / path: / name:），不重复加 name:', () => {
    const prompt = 'x'
    expect(worktreeCreate({ repo: 'id:abc-123', name: 'n', prompt })[3]).toBe('id:abc-123')
    expect(worktreeCreate({ repo: 'path:/Users/me/repo', name: 'n', prompt })[3]).toBe('path:/Users/me/repo')
    expect(worktreeCreate({ repo: 'name:my-repo', name: 'n', prompt })[3]).toBe('name:my-repo')
    expect(worktreeCreate({ repo: 'my-repo', name: 'n', prompt })[3]).toBe('name:my-repo')
  })

  it('terminal send 追加 Enter 并请求 JSON', () => {
    expect(terminalSend('term-1', 'hello')).toEqual(['terminal', 'send', '--terminal', 'term-1', '--text', 'hello', '--enter', '--json'])
  })

  it('terminal close / list / read / worktree rm / agent launch 参数正确', () => {
    expect(terminalClose('term-1')).toEqual(['terminal', 'close', '--terminal', 'term-1'])
    expect(terminalList()).toEqual(['terminal', 'list', '--json'])
    // 巡检读渲染屏幕，而不是默认的累计流（TUI 重绘会产生堆叠碎片）。
    expect(terminalRead('term-1')).toEqual(['terminal', 'read', '--terminal', 'term-1', '--screen', '--limit', '60', '--json'])
    expect(terminalRead('term-1', { limit: 20 })).toEqual(['terminal', 'read', '--terminal', 'term-1', '--screen', '--limit', '20', '--json'])
    // 默认不 --force：脏工作区交给 Orca 拒绝，避免误删未提交改动。
    expect(worktreeRemove('path:/tmp/wt')).toEqual(['worktree', 'rm', '--worktree', 'path:/tmp/wt', '--json'])
    expect(worktreeRemove('path:/tmp/wt', { force: true })).toEqual(['worktree', 'rm', '--worktree', 'path:/tmp/wt', '--force', '--json'])
    // 命令构造层不猜默认值；默认值由 Orca 选项声明提供。
    expect(agentLaunch({ worktree: 'path:/tmp/wt', prompt: '继续' })).toEqual(['agent', 'launch', '--worktree', 'path:/tmp/wt', '--prompt', '继续'])
    expect(agentLaunch({ worktree: 'path:/tmp/wt', prompt: '继续', agent: 'codex' }))
      .toEqual(['agent', 'launch', '--agent', 'codex', '--worktree', 'path:/tmp/wt', '--prompt', '继续'])
  })
})

describe('Orca 返回解析', () => {
  it('优先取 launch.outcome.handle，其次 agentTerminalHandle', () => {
    expect(parseCreateResult(JSON.stringify({ ok: true, result: { launch: { outcome: { handle: 'H1' } } } }))).toEqual({ handle: 'H1' })
    expect(parseCreateResult(JSON.stringify({ ok: true, result: { agentTerminalHandle: 'H2' } }))).toEqual({ handle: 'H2' })
  })

  it('无法解析时抛出可读错误', () => {
    expect(() => parseCreateResult('not json')).toThrow(/orca:invalid-json/)
    expect(() => parseCreateResult(JSON.stringify({ ok: false, error: { message: 'no repo' } }))).toThrow(/orca:create-failed/)
  })
})

describe('OrcaRuntime', () => {
  it('命令失败时保留 stdout 里的 Orca 错误体，而不是只留下 code=1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ra-workers-'))
    const runner = new FakeRunner([{
      code: 1,
      stdout: JSON.stringify({
        ok: false,
        error: {
          code: 'agent_session_operation_unknown',
          message: 'base branch master not found',
          data: {
            cause: 'Error: Command failed: git worktree add ... master\nfatal: invalid reference: master\n    at ...',
            operationId: 'op_123',
          },
        },
      }),
      stderr: '',
    }])
    const adapter = new OrcaRuntime({ runner, workersDir: dir })

    const error = await adapter.start({ ticket, assignment, workdir: '/tmp/wt' }).catch(item => item)
    expect(error).toBeInstanceOf(OrcaCommandError)
    expect(error.message).toContain('code=agent_session_operation_unknown')
    expect(error.message).toContain('base branch master not found')
    expect(error.message).toContain('cause=Error: Command failed: git worktree add ... master')
    expect(error.detail).toMatchObject({
      command: 'worktree create',
      code: 1,
      orcaCode: 'agent_session_operation_unknown',
      orcaOperationId: 'op_123',
    })
    // 多行 cause 只保留第一行有效信息，不把堆栈整段塞进日志
    expect(error.detail.orcaCause).toBe('Error: Command failed: git worktree add ... master')
    // 参数摘要可复现，但不把整段 prompt 写进日志
    expect(error.detail.args).toContain('--base-branch main')
    expect(error.detail.args).toContain('--repo name:dsh/router-agent')
    expect(error.detail.args).toContain('--prompt <')
    expect(error.detail.args).not.toContain('ra report')
  })

  it('stdout 不是 JSON 时回退到 stdout 尾部，仍能定位命令参数', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ra-workers-'))
    const runner = new FakeRunner([{ code: 2, stdout: 'fatal: not a git repository', stderr: '' }])
    const adapter = new OrcaRuntime({ runner, workersDir: dir })
    const error = await adapter.start({ ticket, assignment, workdir: '/tmp/wt' }).catch(item => item)
    expect(error).toBeInstanceOf(OrcaCommandError)
    expect(error.message).toContain('fatal: not a git repository')
    expect(error.message).toContain('exit=2')
  })

  it('summarizeArgs 脱敏 --prompt 的值', () => {
    expect(summarizeArgs(['--repo', 'name:x', '--prompt', '很长的提示词\n第二行', '--json'])).toBe(
      '--repo name:x --prompt <10 chars> --json',
    )
  })

  it('start 创建 worktree、写入 meta.json 并返回 handle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ra-workers-'))
    const runner = new FakeRunner([
      { code: 0, stdout: JSON.stringify({ ok: true, result: { launch: { outcome: { handle: 'term-9' } }, worktree: { path: '/tmp/wt-9' } } }), stderr: '' },
    ])
    const adapter = new OrcaRuntime({ runner, workersDir: dir })
    const { handle, workdir } = await adapter.start({ ticket, assignment, workdir: '/tmp/wt-9' })

    expect(handle).toBe('term-9')
    expect(workdir).toBe('/tmp/wt-9')
    expect(runner.calls[0]!.argv.slice(0, 4)).toEqual(['worktree', 'create', '--repo', 'name:dsh/router-agent'])
    // worktree 名与工作分支一一对应：只是把 `/` 换成 `-`。
    const argv = runner.calls[0]!.argv
    expect(argv[argv.indexOf('--name') + 1]).toBe('ra-tk_1-调整登录超时')
    expect(argv[argv.indexOf('--branch') + 1]).toBe('ra/tk_1-调整登录超时')
    const metaPath = join(dir, 'tk_1', 'meta.json')
    expect(existsSync(metaPath)).toBe(true)
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    expect(meta.handle).toBe('term-9')
    expect(meta.assignmentId).toBe('as_1')
  })

  it('未配置时用声明默认 claude；配置后按配置传', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ra-workers-'))
    const stdout = JSON.stringify({ ok: true, result: { launch: { outcome: { handle: 'term-9' } } } })
    const runner = new FakeRunner([{ code: 0, stdout, stderr: '' }])
    await new OrcaRuntime({ runner, workersDir: dir }).start({ ticket, assignment, workdir: '/tmp/wt-9' })
    const defaultArgv = runner.calls[0]!.argv
    // Orca 的 --prompt 必须配 --agent，所以缺省也要传声明里的默认值。
    expect(defaultArgv[defaultArgv.indexOf('--agent') + 1]).toBe('claude')

    const runner2 = new FakeRunner([{ code: 0, stdout, stderr: '' }])
    const adapter = new OrcaRuntime({ runner: runner2, workersDir: dir, agent: 'codex' })
    await adapter.start({ ticket, assignment, workdir: '/tmp/wt-9' })
    const argv = runner2.calls[0]!.argv
    expect(argv[argv.indexOf('--agent') + 1]).toBe('codex')
    // meta 里记下 Agent，人工恢复会话时才知道该用哪个 CLI。
    const meta = JSON.parse(readFileSync(join(dir, 'tk_1', 'meta.json'), 'utf8'))
    expect(meta.agent).toBe('codex')
  })

  it('prompt 模式把 worker 手册与 Mandate 一起拼进启动 prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ra-workers-'))
    const runner = new FakeRunner([{ code: 0, stdout: JSON.stringify({ ok: true, result: { launch: { outcome: { handle: 'H' } } } }), stderr: '' }])
    const adapter = new OrcaRuntime({ runner, workersDir: dir })
    await adapter.start({ ticket, assignment, workdir: '/tmp/wt' })
    const argv = runner.calls[0]!.argv
    const prompt = argv[argv.indexOf('--prompt') + 1]!
    expect(prompt).toContain('ra report')
    expect(prompt).toContain('调整登录超时')
    expect(prompt).toContain('--reply')
  })

  it('deliver 逐条发送输入文本，并带上可回写的输入 id', async () => {
    const runner = new FakeRunner()
    const adapter = new OrcaRuntime({ runner, workersDir: '/tmp' })
    await adapter.deliver('term-1', [
      { id: 'in_1', kind: 'followup', text: '第一件事' },
      { id: 'in_2', kind: 'ci', text: 'CI 失败了' },
    ])
    expect(runner.calls.map(c => c.argv)).toEqual([
      terminalSend('term-1', '【Router 输入 in_1】\n第一件事'),
      terminalSend('term-1', '【Router 输入 in_2】\nCI 失败了'),
    ])
  })

  it('registerContext 把上下文拼成一段发送', async () => {
    const runner = new FakeRunner()
    const adapter = new OrcaRuntime({ runner, workersDir: '/tmp' })
    await adapter.registerContext('term-1', [
      { kind: 'env', key: 'RA_STATE', value: '/tmp/state.json' },
      { kind: 'dir', path: '/tmp/repo' },
    ])
    const sent = runner.calls[0]!.argv[runner.calls[0]!.argv.indexOf('--text') + 1]!
    expect(sent).toContain('RA_STATE=/tmp/state.json')
    expect(sent).toContain('/tmp/repo')
  })

  it('stop 关闭终端', async () => {
    const runner = new FakeRunner()
    const adapter = new OrcaRuntime({ runner, workersDir: '/tmp' })
    await adapter.stop('term-1', '人工停止')
    expect(runner.calls[0]!.argv).toEqual(terminalClose('term-1'))
  })

  it('inspect 从 terminal list 中按 handle 找到结构化状态，不解析屏幕文本', async () => {
    const runner = new FakeRunner([{
      code: 0,
      stdout: JSON.stringify({ ok: true, result: { terminals: [{ handle: 'term-1', connected: true, writable: true, orphaned: false, lastOutputAt: 1793897105303, worktreePath: '/tmp/wt', branch: 'ra/tk_1' }] } }),
      stderr: '',
    }])
    const adapter = new OrcaRuntime({ runner, workersDir: '/tmp' })
    const info = await adapter.inspect('term-1')
    expect(info).toMatchObject({ handle: 'term-1', connected: true, orphaned: false, worktreePath: '/tmp/wt' })
    // Orca 实测返回毫秒数字，必须归一化成 ISO，否则 idle 判定永远失效
    expect(info?.lastOutputAt).toBe(new Date(1793897105303).toISOString())
  })

  it('read 读取渲染屏幕尾部，供 Router 主动巡检', async () => {
    const runner = new FakeRunner([{
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        result: { terminal: { handle: 'term-1', status: 'running', source: 'screen', tail: ['⏺ 正在改登录超时', '⎿ pnpm test'] } },
      }),
      stderr: '',
    }])
    const adapter = new OrcaRuntime({ runner, workersDir: '/tmp' })
    const output = await adapter.read('term-1', { limit: 20 })
    expect(runner.calls[0]!.argv).toEqual(terminalRead('term-1', { limit: 20 }))
    expect(output).toEqual({ status: 'running', source: 'screen', lines: ['⏺ 正在改登录超时', '⎿ pnpm test'] })
  })

  it('read 遇到未知 status 或缺失 terminal 时返回安全值', async () => {
    const runner = new FakeRunner([
      { code: 0, stdout: JSON.stringify({ ok: true, result: { terminal: { status: 'weird', tail: [] } } }), stderr: '' },
      { code: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: '' },
    ])
    const adapter = new OrcaRuntime({ runner, workersDir: '/tmp' })
    expect(await adapter.read('term-1')).toEqual({ status: 'unknown', lines: [] })
    expect(await adapter.read('term-1')).toBeNull()
  })
})

describe('Claude 会话记录', () => {
  it('按 workdir 找到最新会话，提取 assistant 文本与工具调用', async () => {
    const projects = mkdtempSync(join(tmpdir(), 'ra-claude-projects-'))
    const workdir = '/tmp/acme/ra-tk-1'
    const dir = join(projects, claudeProjectSlug(workdir))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 's1.jsonl'), [
      JSON.stringify({ type: 'system', timestamp: '2026-11-06T10:00:00.000Z' }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-06T10:01:00.000Z',
        sessionId: 's1',
        message: { content: [{ type: 'thinking', thinking: '想一想' }, { type: 'text', text: '正在改配置' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-06T10:02:00.000Z',
        sessionId: 's1',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/x/service.ts' } }] },
      }),
    ].join('\n'))

    const adapter = new OrcaRuntime({ runner: new FakeRunner(), workersDir: '/tmp', claudeProjectsDir: projects })
    const snapshot = await adapter.session(workdir)

    expect(snapshot?.at).toBe('2026-11-06T10:02:00.000Z')
    expect(snapshot?.events).toEqual([
      { at: '2026-11-06T10:01:00.000Z', kind: 'text', text: '正在改配置' },
      { at: '2026-11-06T10:02:00.000Z', kind: 'tool', text: 'Edit(service.ts)', tool: { name: 'Edit', target: 'service.ts' } },
    ])
    expect(snapshot?.sessionId).toBe('s1')
    expect(snapshot?.filePath).toBe(join(dir, 's1.jsonl'))
  })

  it('找不到 workdir 对应的会话目录时返回 null', async () => {
    const projects = mkdtempSync(join(tmpdir(), 'ra-claude-projects-'))
    const adapter = new OrcaRuntime({ runner: new FakeRunner(), workersDir: '/tmp', claudeProjectsDir: projects })
    expect(await adapter.session('/tmp/not-there')).toBeNull()
  })

  it('工具调用压成一行人话，不把完整命令带进话题', () => {
    expect(describeToolUse('Bash', { description: '跑测试', command: 'pnpm test' })).toBe('Bash：跑测试')
    expect(describeToolUse('Edit', { file_path: '/tmp/a/service.ts' })).toBe('Edit(service.ts)')
    expect(describeToolUse('Grep', { pattern: 'syncProgress' })).toBe('Grep(syncProgress)')
    expect(describeToolUse('Task', { description: '并行审查' })).toBe('Task：并行审查')
    // 结构化信息供进展巡检生成语义摘要：只留工具名与目标，不带完整命令。
    expect(describeToolInfo('Bash', { command: 'pnpm test --run' })).toEqual({ name: 'Bash', target: 'pnpm test --run' })
    expect(describeToolInfo('Edit', { file_path: '/tmp/a/service.ts' })).toEqual({ name: 'Edit', target: 'service.ts' })
    expect(describeToolInfo('Grep', { pattern: 'syncProgress' })).toEqual({ name: 'Grep', target: 'syncProgress' })
  })
})

describe('Worker 提示词', () => {
  it('要求用 ra report 上报，并覆盖交付物 / PR / 禁止直连 IM 的约束', () => {
    const prompt = buildWorkerPrompt({ ticket, mandateScope: '只改登录超时', statePath: '/tmp/s.json', eventsPath: '/tmp/e.log', repo: 'dsh/router-agent' })
    expect(prompt).toContain('ra report')
    expect(prompt).toContain('--reply')
    expect(prompt).toContain('--ack')
    expect(prompt).toContain('不要直接给飞书发消息')
    expect(prompt).toContain('只改登录超时')
    expect(prompt).toContain('ra doc')
  })

  it('把工单上的原始图片路径写进 Worker 手册，提示用 Read 看原图', () => {
    const withImages = {
      ...ticket,
      attachments: [
        { path: '/tmp/ra-images/tk_1/img_a.png', mimeType: 'image/png' },
        { path: '/tmp/ra-images/tk_1/img_b.png', mimeType: 'image/png', quoted: true },
      ],
    }
    const prompt = buildWorkerPrompt({ ticket: withImages, mandateScope: '按图改', statePath: '/tmp/s.json', eventsPath: '/tmp/e.log', repo: 'dsh/router-agent' })
    expect(prompt).toContain('附件图片（原图）')
    expect(prompt).toContain('/tmp/ra-images/tk_1/img_a.png')
    expect(prompt).toContain('/tmp/ra-images/tk_1/img_b.png')
    expect(prompt).toContain('引用消息里的图片')
    expect(prompt).toContain('读图工具')
  })

  it('改 UI 的工单要求 PR / MR 描述带 Before / After 对比', () => {
    const base = { ticket, mandateScope: '只改登录超时', statePath: '/tmp/s.json', eventsPath: '/tmp/e.log', repo: 'dsh/router-agent' }
    const prompt = buildWorkerPrompt(base)
    expect(prompt).toContain('UI 改动：必须交 Before / After 对比')
    expect(prompt).toContain('只有 After 不算完整交付')
    expect(prompt).toContain('不要报 `ready`')
    expect(prompt).toContain('改了 UI 却没在 PR / MR 描述里给出 Before / After 对比，不能报 `ready`')
    expect(prompt).toContain('--ui-change')
    expect(prompt).toContain('补不了就改用 `blocked`')

    const contract = buildNeutralContract({
      ticketId: 'tk_1',
      title: '调整登录超时',
      scope: '只改登录超时',
      repo: 'dsh/router-agent',
      statePath: '/tmp/s.json',
      eventsPath: '/tmp/e.log',
    })
    expect(contract).toContain('UI 改动：必须交 Before / After 对比')
    expect(contract).toContain('只有 After 不算完整交付')
  })
})

describe('多项目 / 多分支派工', () => {
  it('worktree create 带上起始分支（--base-branch）与语义分支（--branch）', () => {
    const argv = worktreeCreate({ repo: 'dsh/router-agent', name: 'ra-tk_1', prompt: '做这个', baseBranch: 'release', branch: 'ra/tk-1-fix-login' })
    expect(argv.slice(0, 6)).toEqual(['worktree', 'create', '--repo', 'name:dsh/router-agent', '--name', 'ra-tk_1'])
    expect(argv[argv.indexOf('--base-branch') + 1]).toBe('release')
    expect(argv[argv.indexOf('--branch') + 1]).toBe('ra/tk-1-fix-login')
    // 没给分支时不传，交给 Orca 用仓库默认分支
    expect(worktreeCreate({ repo: 'r', name: 'n', prompt: 'p' })).not.toContain('--base-branch')
    expect(worktreeCreate({ repo: 'r', name: 'n', prompt: 'p' })).not.toContain('--branch')
  })

  it('start 优先用工单自带的 repo/branch，而不是适配器上的全局 repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ra-workers-'))
    const runner = new FakeRunner([{ code: 0, stdout: JSON.stringify({ ok: true, result: { launch: { outcome: { handle: 'H' } } } }), stderr: '' }])
    const adapter = new OrcaRuntime({ runner, workersDir: dir })
    const scoped = { ...ticket, repo: 'name:other/repo', branch: 'release' }
    await adapter.start({ ticket: scoped, assignment, workdir: '/tmp/wt' })

    const argv = runner.calls[0]!.argv
    expect(argv[argv.indexOf('--repo') + 1]).toBe('name:other/repo')
    expect(argv[argv.indexOf('--base-branch') + 1]).toBe('release')
    // 工作分支由工单号 + 标题生成，而不是被 Orca 的用户前缀包一层 UUID。
    expect(argv[argv.indexOf('--branch') + 1]).toBe('ra/tk_1-调整登录超时')
    const meta = JSON.parse(readFileSync(join(dir, 'tk_1', 'meta.json'), 'utf8'))
    expect(meta.repo).toBe('name:other/repo')
    expect(meta.branch).toBe('release')
    expect(meta.workBranch).toBe('ra/tk_1-调整登录超时')
    const prompt = argv[argv.indexOf('--prompt') + 1]!
    expect(prompt).toContain('起始分支：release')
    expect(prompt).toContain('分支名：`ra/tk_1-调整登录超时`')
  })
})
