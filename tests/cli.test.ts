import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli, type CliIo } from '../src/cli/index.js'
import { Store } from '../src/store/db.js'
import { Engine } from '../src/core/engine.js'
import { defaultConfig, loadConfig, policyOf } from '../src/config.js'

function io(homeDir?: string): CliIo & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    stdout: line => out.push(line),
    stderr: line => err.push(line),
    // 测试永远把 RA_HOME 指到临时目录，避免任何漏解析写进真实配置。
    env: { RA_HOME: homeDir ?? join(tmpdir(), 'ra-cli-safety') },
  }
}

function home(): string {
  return mkdtempSync(join(tmpdir(), 'ra-cli-'))
}

async function initHome(dir: string): Promise<void> {
  await runCli(['init', '--home', dir, '--yes'], io())
}

describe('ra CLI', () => {
  it('ra init 初始化目录与配置', async () => {
    const dir = home()
    const output = io()
    const code = await runCli(['init', '--home', dir, '--yes'], output)
    expect(code).toBe(0)
    expect(existsSync(join(dir, 'config.yaml'))).toBe(true)
    expect(output.out.join('\n')).toContain(dir)
  })

  it('ra tickets 在空状态下给出明确提示', async () => {
    const dir = home()
    await initHome(dir)
    const output = io()
    expect(await runCli(['tickets', '--home', dir], output)).toBe(0)
    expect(output.out.join('\n')).toContain('暂无工单')
  })

  it('ra tickets --stage 过滤并打印工单行', async () => {
    const dir = home()
    await initHome(dir)
    const store = new Store(join(dir, 'state.db'))
    const engine = new Engine({ store, policy: policyOf(defaultConfig()) })
    engine.ingest({
      id: 't1', source: 'feishu', externalId: 'om_1', threadId: 'feishu:c:om_root', chatId: 'c', chatName: '',
      actorId: 'ou_a', actorName: 'A', isBot: false, text: '改登录超时', addressed: 'mention',
      receivedAt: '2026-11-06T10:00:00.000Z', disposition: 'pending',
    })
    engine.decide({ triggerId: 't1', decision: 'accept', strength: 'explicit', reason: 'ok', title: '改登录超时' })
    store.close()

    const output = io()
    expect(await runCli(['tickets', '--home', dir, '--stage', 'todo'], output)).toBe(0)
    expect(output.out.join('\n')).toContain('改登录超时')
    expect(output.out.join('\n')).toContain('todo')
  })

  it('ra ticket <id> 打印详情；工单不存在时返回非零', async () => {
    const dir = home()
    await initHome(dir)
    const store = new Store(join(dir, 'state.db'))
    const engine = new Engine({ store, policy: policyOf(defaultConfig()) })
    engine.ingest({
      id: 't1', source: 'feishu', externalId: 'om_1', threadId: 'feishu:c:om_root', chatId: 'c', chatName: '',
      actorId: 'ou_a', actorName: 'A', isBot: false, text: '改登录超时', addressed: 'mention',
      receivedAt: '2026-11-06T10:00:00.000Z', disposition: 'pending',
    })
    const ticketId = engine.decide({ triggerId: 't1', decision: 'accept', strength: 'explicit', reason: 'ok', title: '改登录超时' }).ticket!.id
    store.close()

    const output = io()
    expect(await runCli(['ticket', ticketId, '--home', dir], output)).toBe(0)
    expect(output.out.join('\n')).toContain('改登录超时')
    expect(output.out.join('\n')).toContain('授权范围')

    const missing = io()
    expect(await runCli(['ticket', 'nope', '--home', dir], missing)).toBe(1)
    expect(missing.err.join('\n')).toContain('未找到')

    const noArg = io()
    expect(await runCli(['ticket', '--home', dir], noArg)).not.toBe(0)
  })

  it('ra ticket --stop 在服务未运行时直接写库停止', async () => {
    const dir = home()
    await initHome(dir)
    const store = new Store(join(dir, 'state.db'))
    const engine = new Engine({ store, policy: policyOf(defaultConfig()) })
    engine.ingest({
      id: 't1', source: 'feishu', externalId: 'om_1', threadId: 'feishu:c:om_root', chatId: 'c', chatName: '',
      actorId: 'ou_a', actorName: 'A', isBot: false, text: '改登录超时', addressed: 'mention',
      receivedAt: '2026-11-06T10:00:00.000Z', disposition: 'pending',
    })
    const ticketId = engine.decide({ triggerId: 't1', decision: 'accept', strength: 'explicit', reason: 'ok', title: '改登录超时' }).ticket!.id
    store.close()

    const output = io(dir)
    // 用 0 端口让 HTTP 必然连接失败，走写库兜底
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'config.yaml'), readFileSync(join(dir, 'config.yaml'), 'utf8').replace('port: 3083', 'port: 1'))
    expect(await runCli(['ticket', ticketId, '--stop', '--home', dir], output)).toBe(0)
    const after = new Store(join(dir, 'state.db'))
    expect(after.getTicket(ticketId)?.stage).toBe('done')
    after.close()
  })

  it('ra status 在服务未运行时说明状态', async () => {
    const dir = home()
    await initHome(dir)
    const output = io()
    expect(await runCli(['status', '--home', dir], output)).toBe(0)
    expect(output.out.join('\n')).toContain('未运行')
  })

  it('ra config 打印路径与内容，config set 修改单项', async () => {
    const dir = home()
    await initHome(dir)
    const output = io()
    expect(await runCli(['config', '--home', dir], output)).toBe(0)
    expect(output.out.join('\n')).toContain(join(dir, 'config.yaml'))
    expect(readFileSync(join(dir, 'config.yaml'), 'utf8').length).toBeGreaterThan(0)

    const set = io()
    expect(await runCli(['config', 'set', 'policy.acceptMode', 'observe', '--home', dir], set)).toBe(0)
    expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toContain('observe')

    const bad = io()
    expect(await runCli(['config', 'set', 'policy.acceptMode', 'yolo', '--home', dir], bad)).toBe(1)
    expect(bad.err.join('\n')).toContain('非法')

    const unknown = io()
    expect(await runCli(['config', 'set', 'nope.nope', 'x', '--home', dir], unknown)).toBe(1)
  })

  it('ra doctor 汇总自检结果，有 fail 时返回 1', async () => {
    const dir = home()
    await initHome(dir)
    const configPath = join(dir, 'config.yaml')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(configPath, [
      'feishu:',
      '  chats: [oc_dsh]',
      '  allowed: [ou_me]',
      '  botOpenIds: [ou_bot, cli_bot]',
      'projects:',
      '  - name: teamwork-repos',
      `    repo: ${process.cwd()}`,
      '    defaultBranch: main',
      'policy:',
      '  acceptMode: observe',
      'llm:',
      '  baseUrl: https://api.deepseek.com/v1',
      '  model: deepseek-v4-flash',
      '  apiKey: sk-test',
      'server:',
      '  port: 3998',
    ].join('\n'))

    const healthy: CliIo = {
      ...io(dir),
      orca: {
        async run(argv) {
          if (argv[0] === 'status') return { code: 0, stdout: 'runtimeReachable: true\nruntimeState: ready', stderr: '' }
          return { code: 0, stdout: JSON.stringify({ result: { repos: [{ displayName: 'teamwork-repos', path: '/p', kind: 'git' }] } }), stderr: '' }
        },
      },
      lark: {
        async run(argv) {
          if (argv[0] === 'auth') return { code: 0, stdout: JSON.stringify({ identities: { bot: { available: true }, user: { available: true } } }), stderr: '' }
          if (argv[0] === 'event') return { code: 0, stdout: JSON.stringify({ data: { decision: { status: 'ready', preconditions: [] } } }), stderr: '' }
          if (argv[1] === '+chat-list') return { code: 0, stdout: JSON.stringify({ data: { chats: [{ chat_id: 'oc_dsh', name: 'DSH' }] } }), stderr: '' }
          return { code: 0, stdout: JSON.stringify({ data: { users: [], bots: [{ member_id: 'ou_bot', app_id: 'cli_bot' }] } }), stderr: '' }
        },
      },
    }
    const ok = io(dir)
    Object.assign(ok, { orca: healthy.orca, lark: healthy.lark })
    expect(await runCli(['doctor', '--home', dir], ok)).toBe(0)
    expect(ok.out.join('\n')).toContain('自检通过')

    const bad = io(dir)
    Object.assign(bad, { orca: { async run() { return { code: 1, stdout: '', stderr: 'runtime down' } } }, lark: healthy.lark })
    expect(await runCli(['doctor', '--home', dir], bad)).toBe(1)
    expect(bad.out.join('\n')).toContain('未通过')
  })

  it('未知命令返回非零并给出提示', async () => {
    const output = io()
    expect(await runCli(['bogus'], output)).not.toBe(0)
    expect(output.err.join('\n')).toContain('bogus')
  })

  it('ra --help 列出命令并以 0 退出', async () => {
    const output = io()
    expect(await runCli(['--help'], output)).toBe(0)
    const text = output.out.join('\n')
    expect(text).toContain('init')
    expect(text).toContain('config')
  })

  it('不带命令时输出帮助并以 2 退出', async () => {
    const output = io()
    expect(await runCli([], output)).toBe(2)
    expect(output.err.join('\n')).toContain('Usage')
  })
})

describe('ra runtime add / uninstall 插件运行时', () => {
  it('本地路径入口写入 runtime.plugins 并提示重启', async () => {
    const dir = home()
    await initHome(dir)
    const output = io(dir)
    expect(await runCli(['runtime', 'add', 'demo-runtime', './demo-runtime', '--home', dir], output)).toBe(0)
    expect(loadConfig(dir).runtime.plugins?.['demo-runtime']).toBe('./demo-runtime')
    expect(output.out.join('\n')).toContain('本地路径插件不需要下载')
  })

  it('拒绝非法 id、内置 id 与不是包名/路径的入口', async () => {
    const dir = home()
    await initHome(dir)

    const badId = io(dir)
    expect(await runCli(['runtime', 'add', 'Demo_Runtime', './x', '--home', dir], badId)).toBe(2)
    expect(badId.err.join('\n')).toContain('小写字母、数字与连字符')
    expect(loadConfig(dir).runtime.plugins?.['Demo_Runtime']).toBeUndefined()

    const builtin = io(dir)
    expect(await runCli(['runtime', 'add', 'orca', '@acme/runtime-x', '--home', dir], builtin)).toBe(1)
    expect(builtin.err.join('\n')).toContain('内置运行时')

    const badEntry = io(dir)
    expect(await runCli(['runtime', 'add', 'demo-runtime', 'not a package', '--home', dir], badEntry)).toBe(2)
    expect(badEntry.err.join('\n')).toContain('入口只能是 npm 包名')
  })

  it('uninstall 自定义插件时说明改配置移除', async () => {
    const dir = home()
    await initHome(dir)
    expect(await runCli(['runtime', 'add', 'demo-runtime', './demo-runtime', '--home', dir], io(dir))).toBe(0)
    const output = io(dir)
    expect(await runCli(['runtime', 'uninstall', 'demo-runtime', '--home', dir], output)).toBe(0)
    expect(output.out.join('\n')).toContain("ra config set runtime.plugins.demo-runtime ''")
  })
})