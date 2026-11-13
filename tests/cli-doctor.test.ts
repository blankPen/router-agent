import { describe, expect, it } from 'vitest'
import { formatChecks, runConfigDoctor, runDoctor, type DoctorDeps } from '../src/cli/doctor.js'
import { defaultConfig, type AppConfig, chatEntry } from '../src/config.js'
import type { CommandRunner } from '#infra/process.js'

function healthyConfig(): AppConfig {
  const config = defaultConfig()
  // 项目路径统一是本地仓库绝对路径：用真实存在的目录代表项目。
  config.projects = [{ name: 'teamwork-repos', repo: process.cwd(), defaultBranch: 'main' }]
  config.feishu.chats = [chatEntry('oc_dsh')]
  config.feishu.allowed = ['ou_me']
  config.feishu.botOpenIds = ['ou_bot', 'cli_bot']
  config.policy.acceptMode = 'observe'
  return config
}

function orca(over: Partial<Record<'status' | 'repo', string>> = {}): CommandRunner {
  return {
    async run(argv) {
      if (argv[0] === 'status') return { code: 0, stdout: over.status ?? 'appRunning: true\nruntimeReachable: true\nruntimeState: ready', stderr: '' }
      if (argv[0] === 'repo') return { code: 0, stdout: over.repo ?? JSON.stringify({ result: { repos: [{ displayName: 'teamwork-repos', path: '/p', kind: 'git' }] } }), stderr: '' }
      return { code: 0, stdout: '{}', stderr: '' }
    },
  }
}

function lark(over: { bot?: boolean; event?: boolean; chats?: string[]; members?: boolean } = {}): CommandRunner {
  const bot = over.bot ?? true
  const event = over.event ?? true
  const chats = over.chats ?? ['oc_dsh']
  const members = over.members ?? true
  return {
    async run(argv) {
      if (argv[0] === 'auth') return { code: 0, stdout: JSON.stringify({ identities: { bot: { available: bot }, user: { available: true, openId: 'ou_me' } } }), stderr: '' }
      if (argv[0] === 'event') {
        return {
          code: 0,
          stdout: JSON.stringify({ data: { decision: { status: event ? 'ready' : 'blocked', preconditions: event ? [{ name: 'scopes_granted', status: 'ok' }] : [{ name: 'scopes_granted', status: 'missing' }] } } }),
          stderr: '',
        }
      }
      if (argv[1] === '+chat-list') return { code: 0, stdout: JSON.stringify({ data: { chats: chats.map(id => ({ chat_id: id, name: id })) } }), stderr: '' }
      if (argv[1] === '+chat-members-list') {
        return { code: 0, stdout: JSON.stringify({ data: { users: [], bots: members ? [{ member_id: 'ou_bot', app_id: 'cli_bot', name: 'bot' }] : [] } }), stderr: '' }
      }
      return { code: 0, stdout: '{}', stderr: '' }
    },
  }
}

function deps(over: Partial<DoctorDeps> & { config?: AppConfig } = {}): DoctorDeps {
  return {
    config: over.config ?? healthyConfig(),
    orca: over.orca ?? orca(),
    lark: over.lark ?? lark(),
    llm: over.llm ?? (() => ({ ok: true, detail: 'deepseek-v4-flash' })),
    portFree: over.portFree ?? (async () => true),
    servicePid: over.servicePid ?? null,
    ...(over.runtime ? { runtime: over.runtime } : {}),
    ...(over.runtimeChoices ? { runtimeChoices: over.runtimeChoices } : {}),
  }
}

/** 自动识别场景的配置：不手填机器人身份，只给 appId 与一个 mode=mention 的群。 */
function autoBotConfig(appId = 'cli_bot'): AppConfig {
  const config = healthyConfig()
  config.feishu.appId = appId
  config.feishu.botOpenIds = []
  config.feishu.botNames = []
  config.feishu.chats = [chatEntry('oc_dsh', { mode: 'mention' })]
  return config
}

/** 群成员查询抛错的 runner：模拟 lark-cli 不可用。 */
function throwingMembersLark(message = 'lark-cli 调用超时'): CommandRunner {
  const base = lark()
  return {
    async run(argv, opts) {
      if (argv[1] === '+chat-members-list') throw new Error(message)
      return base.run(argv, opts)
    },
  }
}

describe('ra doctor', () => {
  it('配置齐全且依赖可用时全部 ok/warn，没有 fail', async () => {
    const checks = await runDoctor(deps())
    expect(checks.every(item => item.status !== 'fail')).toBe(true)
    expect(checks.find(item => item.name === 'Orca runtime')?.status).toBe('ok')
    expect(checks.find(item => item.name === '事件订阅预检')?.status).toBe('ok')
    expect(checks.find(item => item.name === '机器人在群内')?.status).toBe('ok')
    expect(checks.find(item => item.name === '运行状态')?.status).toBe('warn')
  })

  it('ACP 可选运行时未安装只 warn，默认运行时不可用 fail', async () => {
    const config = healthyConfig()
    config.runtime.default = 'acp-codex'
    const checks = await runDoctor(deps({
      config,
      runtimeChoices: [
        { id: 'acp-codex', label: 'Codex', hint: '', status: 'needs-auth', installable: true, loginHint: '先运行 codex-acp login' },
        { id: 'acp-gemini', label: 'Gemini', hint: '', status: 'not-installed', installable: false },
      ],
    }))
    expect(checks.find(check => check.name === 'ACP acp-codex')).toMatchObject({
      status: 'fail',
      hint: '先运行 codex-acp login',
    })
    expect(checks.find(check => check.name === 'ACP acp-gemini')?.status).toBe('warn')
  })

  it('缺少必填项直接 fail 并给出 hint', async () => {    const config = healthyConfig()
    config.projects = []
    config.feishu.allowed = []
    const checks = await runDoctor(deps({ config }))
    const item = checks.find(check => check.name === '配置必填项')!
    expect(item.status).toBe('fail')
    expect(item.detail).toContain('projects')
    expect(item.hint).toContain('ra config set')
  })

  it('机器人身份不可用 / 事件未就绪 / 项目路径不存在 / 端口被占 都会 fail', async () => {
    const config = healthyConfig()
    config.projects = [{ name: 'teamwork-repos', repo: '/Users/me/not-exist-repo', defaultBranch: 'main' }]
    const checks = await runDoctor(deps({
      config,
      lark: lark({ bot: false, event: false }),
      portFree: async () => false,
    }))
    expect(checks.find(item => item.name === '飞书机器人身份')?.status).toBe('fail')
    expect(checks.find(item => item.name === '事件订阅预检')?.status).toBe('fail')
    expect(checks.find(item => item.name === '本地项目路径')?.status).toBe('fail')
    expect(checks.find(item => item.name === '服务端口')?.status).toBe('fail')
  })

  it('群对机器人不可见或群里没找到机器人也会 fail', async () => {
    const checks = await runDoctor(deps({ lark: lark({ chats: ['oc_other'], members: false }) }))
    expect(checks.find(item => item.name === '监控群可见性')?.status).toBe('fail')
    expect(checks.find(item => item.name === '机器人在群内')?.status).toBe('fail')
  })

  it('不手填机器人身份时按 appId 自动识别，必填项不再要求 botOpenIds', async () => {
    const checks = await runDoctor(deps({ config: autoBotConfig() }))
    expect(checks.find(item => item.name === '配置必填项')?.status).toBe('ok')
    const identity = checks.find(item => item.name === '机器人身份自动识别')!
    expect(identity.status).toBe('ok')
    expect(identity.detail).toContain('识别到机器人')
    expect(checks.find(item => item.name === '机器人在群内')?.status).toBe('ok')
  })

  it('自动识别失败时判 fail，并说明是没找到而不是接口异常', async () => {
    const checks = await runDoctor(deps({ config: autoBotConfig('cli_other'), lark: lark({ members: false }) }))
    const identity = checks.find(item => item.name === '机器人身份自动识别')!
    expect(identity.status).toBe('fail')
    expect(identity.detail).toContain('没找到')
    expect(identity.detail).not.toContain('接口异常')
  })

  it('自动识别时 lark-cli 抛错判 fail，且带出调用失败原因', async () => {
    const checks = await runDoctor(deps({ config: autoBotConfig(), lark: throwingMembersLark('lark-cli 调用超时') }))
    const identity = checks.find(item => item.name === '机器人身份自动识别')!
    expect(identity.status).toBe('fail')
    expect(identity.detail).toContain('超时')
  })

  it('手填机器人身份时不再自动识别，只由「机器人在群内」扫一次成员', async () => {
    const config = healthyConfig()
    config.feishu.chats = [chatEntry('oc_dsh', { mode: 'mention' })]
    let memberCalls = 0
    const base = lark()
    const runner: CommandRunner = {
      async run(argv, opts) {
        if (argv[1] === '+chat-members-list') memberCalls += 1
        return base.run(argv, opts)
      },
    }
    const checks = await runDoctor(deps({ config, lark: runner }))
    expect(checks.find(item => item.name === '机器人身份自动识别')?.detail).toContain('手动填写')
    expect(memberCalls).toBe(1)
  })

  it('格式化输出带图标与修复建议', async () => {
    const lines = formatChecks(await runDoctor(deps({ config: { ...healthyConfig(), projects: [] } })))
    expect(lines.join('\n')).toContain('❌')
    expect(lines.join('\n')).toContain('→')
  })
})

describe('面板用的配置自检', () => {
  it('缺配置时指出缺什么、去哪改', () => {
    const config = healthyConfig()
    config.feishu.allowed = []
    const checks = runConfigDoctor({ config, llm: () => ({ ok: true, detail: 'model' }) })

    const required = checks.find(item => item.name === '配置必填项')!
    expect(required.status).toBe('fail')
    expect(required.detail).toContain('feishu.allowed')
    expect(required.section).toBe('channels')
  })

  it('模型没配时指向模型配置分组', () => {
    const checks = runConfigDoctor({
      config: healthyConfig(),
      llm: () => ({ ok: false, detail: '缺 baseUrl' }),
    })

    const llm = checks.find(item => item.name === '模型配置')!
    expect(llm.status).toBe('fail')
    expect(llm.section).toBe('llm')
  })

  it('配齐时全部通过，不给出修改入口', () => {
    const checks = runConfigDoctor({ config: healthyConfig(), llm: () => ({ ok: true, detail: 'model' }) })

    expect(checks.every(item => item.status === 'ok')).toBe(true)
    expect(checks.some(item => item.section)).toBe(false)
  })
})
