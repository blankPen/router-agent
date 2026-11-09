import { describe, expect, it } from 'vitest'
import { formatChecks, runDoctor, type DoctorDeps } from '../src/cli/doctor.js'
import { defaultConfig, type AppConfig, chatEntry } from '../src/config.js'
import type { CommandRunner } from '../src/infra/process.js'

function healthyConfig(): AppConfig {
  const config = defaultConfig()
  config.projects = [{ name: 'teamwork-repos', repo: 'teamwork-repos', defaultBranch: 'main' }]
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

  it('缺少必填项直接 fail 并给出 hint', async () => {
    const config = healthyConfig()
    config.projects = []
    config.feishu.allowed = []
    const checks = await runDoctor(deps({ config }))
    const item = checks.find(check => check.name === '配置必填项')!
    expect(item.status).toBe('fail')
    expect(item.detail).toContain('projects')
    expect(item.hint).toContain('ra config set')
  })

  it('机器人身份不可用 / 事件未就绪 / 仓库不存在 / 端口被占 都会 fail', async () => {
    const checks = await runDoctor(deps({
      lark: lark({ bot: false, event: false }),
      orca: orca({ repo: JSON.stringify({ result: { repos: [] } }) }),
      portFree: async () => false,
    }))
    expect(checks.find(item => item.name === '飞书机器人身份')?.status).toBe('fail')
    expect(checks.find(item => item.name === '事件订阅预检')?.status).toBe('fail')
    expect(checks.find(item => item.name === 'Orca 仓库')?.status).toBe('fail')
    expect(checks.find(item => item.name === '服务端口')?.status).toBe('fail')
  })

  it('群对机器人不可见或群里没找到机器人也会 fail', async () => {
    const checks = await runDoctor(deps({ lark: lark({ chats: ['oc_other'], members: false }) }))
    expect(checks.find(item => item.name === '监控群可见性')?.status).toBe('fail')
    expect(checks.find(item => item.name === '机器人在群内')?.status).toBe('fail')
  })

  it('格式化输出带图标与修复建议', async () => {
    const lines = formatChecks(await runDoctor(deps({ config: { ...healthyConfig(), projects: [] } })))
    expect(lines.join('\n')).toContain('❌')
    expect(lines.join('\n')).toContain('→')
  })
})