import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInitWizard, type InitDeps } from '../src/cli/init.js'
import type { Prompter } from '../src/cli/prompts.js'
import { loadConfig, writeConfig, chatEntry } from '../src/config.js'
import type { CommandRunner } from '../src/infra/process.js'
import { LARK_PROFILE_HOME } from '../src/sources/lark.js'

const ORCA_REPOS = JSON.stringify({ result: { repos: [
  { displayName: 'teamwork-repos', path: '/p', kind: 'git' },
  { displayName: 'folder-project', path: '/f', kind: 'folder' },
] } })
const CHATS = JSON.stringify({ data: { chats: [
  { chat_id: 'oc_dsh', name: 'DSH-Trove' },
  { chat_id: 'oc_other', name: '目标对齐' },
] } })
const MEMBERS = JSON.stringify({ data: {
  users: [
    { member_id: 'ou_me', name: '阿振(Pz)' },
    { member_id: 'ou_other', name: '同事' },
  ],
  bots: [{ member_id: 'ou_bot', name: 'Pz小助手', app_id: 'cli_bot' }],
} })
const AUTH = JSON.stringify({ identities: { user: { available: true, openId: 'ou_me' } } })
const APPCONF = JSON.stringify({ appId: 'cli_bot' })

interface Script {
  selects?: unknown[]
  inputs?: string[]
  passwords?: string[]
  confirms?: boolean[]
  checkboxes?: unknown[][]
}

function scripted(script: Script): Prompter & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    async input(opts) {
      asked.push(opts.message)
      return script.inputs?.shift() ?? opts.default ?? ''
    },
    async password(opts) {
      asked.push(opts.message)
      return script.passwords?.shift() ?? ''
    },
    async select(opts) {
      asked.push(opts.message)
      return (script.selects?.shift() ?? opts.default) as never
    },
    async checkbox(opts) {
      asked.push(opts.message)
      return (script.checkboxes?.shift() ?? []) as never
    },
    async confirm(opts) {
      asked.push(opts.message)
      return script.confirms?.shift() ?? opts.default ?? false
    },
  }
}

function larkFactory(auth: string = AUTH) {
  const calls: { argv: string[]; input?: string }[] = []
  const run: CommandRunner = {
    async run(argv, opts = {}) {
      calls.push({ argv, ...(opts.input !== undefined ? { input: opts.input } : {}) })
      if (argv[0] === 'config' && argv[1] === 'init') return { code: 0, stdout: 'OK: Configuration saved to /tmp/x/.lark-cli/config.json', stderr: '' }
      if (argv[0] === 'im' && argv[1] === '+chat-list') return { code: 0, stdout: CHATS, stderr: '' }
      if (argv[0] === 'im' && argv[1] === '+chat-members-list') return { code: 0, stdout: MEMBERS, stderr: '' }
      if (argv[0] === 'auth') return { code: 0, stdout: auth, stderr: '' }
      if (argv[0] === 'config') return { code: 0, stdout: APPCONF, stderr: '' }
      return { code: 0, stdout: '{}', stderr: '' }
    },
  }
  return { run, calls }
}

function setup(script: Script, over: Partial<InitDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ra-init-'))
  const out: string[] = []
  const lark = larkFactory()
  const prompts = scripted(script)
  const deps: InitDeps = {
    home,
    env: {},
    stdout: line => out.push(line),
    prompts,
    orca: { async run() { return { code: 0, stdout: ORCA_REPOS, stderr: '' } } },
    lark: lark.run,
    ...over,
  }
  return { home, out, asked: prompts.asked, lark, deps, prompts }
}

describe('交互式 ra init', () => {
  it('按必填项引导：仓库 → 飞书凭据 → 群 → 授权成员，并自动识别机器人身份', async () => {
    const script: Script = {
      selects: ['teamwork-repos', 'existing'],
      inputs: ['main', 'cli_new'],
      passwords: ['shh'],
      checkboxes: [['oc_dsh'], ['ou_me']],
    }
    const { home, asked, lark, deps } = setup(script)
    const config = await runInitWizard(deps)

    expect(asked[0]).toContain('Orca 仓库')
    expect(asked.some(q => q.includes('飞书机器人'))).toBe(true)
    expect(asked.some(q => q.includes('监控'))).toBe(true)
    expect(config.projects[0]).toMatchObject({ name: 'teamwork-repos', repo: 'teamwork-repos', defaultBranch: 'main' })
    expect('larkHome' in config.feishu).toBe(false)
    expect(config.feishu.appId).toBe('cli_new')
    expect(config.feishu.chats).toEqual([chatEntry('oc_dsh')])
    expect(config.feishu.allowed).toEqual(['ou_me'])
    expect(config.feishu.botOpenIds).toEqual(['ou_bot', 'cli_bot'])
    expect(config.feishu.botNames).toEqual(['Pz小助手'])

    // App Secret 必须走 stdin，不能出现在 argv
    const initCall = lark.calls.find(call => call.argv[0] === 'config' && call.argv[1] === 'init')
    expect(initCall?.argv).toEqual(['config', 'init', '--app-id', 'cli_new', '--app-secret-stdin'])
    expect(initCall?.input?.trim()).toBe('shh')
    expect(JSON.stringify(initCall?.argv)).not.toContain('shh')

    const saved = loadConfig(home)
    expect(saved.projects[0]?.repo).toBe('teamwork-repos')
    expect(saved.feishu.appId).toBe('cli_new')
    expect(saved.feishu.botOpenIds).toEqual(['ou_bot', 'cli_bot'])
  })

  it('选择跳过时不写凭据，仍可完成群与成员选择', async () => {
    const { home, deps, prompts } = setup({
      selects: ['teamwork-repos', 'skip'],
      inputs: ['release'],
      checkboxes: [['oc_dsh'], ['ou_me']],
    })
    const seeded = loadConfig(home)
    seeded.projects = [{ name: 'teamwork-repos', repo: 'teamwork-repos', defaultBranch: 'release' }]
    seeded.feishu.chats = [chatEntry('oc_dsh')]
    seeded.feishu.allowed = ['ou_me']
    writeConfig(home, seeded)

    const config = await runInitWizard(deps)
    expect(prompts.asked.length).toBeGreaterThan(0)
    // 已有项目的分支 / 群 / 白名单不被默认项清掉
    expect(config.projects[0]).toMatchObject({ name: 'teamwork-repos', repo: 'teamwork-repos', defaultBranch: 'release' })
    expect(config.feishu.chats).toEqual([chatEntry('oc_dsh')])
    expect(config.feishu.allowed).toEqual(['ou_me'])
    expect(config.feishu.appId).toBe('')
  })

  it('读不到群列表时引导去 Web 配置页，且不阻塞写配置', async () => {
    const { home, out, deps } = setup({
      selects: ['teamwork-repos', 'skip'],
      inputs: ['main'],
    }, {
      lark: { async run() { return { code: 1, stdout: '', stderr: 'not configured' } } },
    })
    const config = await runInitWizard(deps)
    expect('larkHome' in config.feishu).toBe(false)
    const text = out.join('\n')
    expect(text).toContain('Web 配置页')
    expect(existsSync(join(home, 'config.yaml'))).toBe(true)
  })

  it('选择「现在新建应用」时内部调用 config init --new，并使用固定 profile', async () => {
    const streamCalls: { argv: string[]; env: NodeJS.ProcessEnv }[] = []
    const { deps } = setup({
      selects: ['teamwork-repos', 'new'],
      inputs: ['main'],
    }, {
      stream: async (argv, env) => { streamCalls.push({ argv, env }); return 0 },
    })
    await runInitWizard(deps)
    expect(streamCalls[0]?.argv).toEqual(['config', 'init', '--new'])
    expect(streamCalls[0]?.env.HOME).toBe(LARK_PROFILE_HOME)
  })

  it('缺少用户授权时询问并可调用 auth login', async () => {
    const streamCalls: { argv: string[]; env: NodeJS.ProcessEnv }[] = []
    const lark = larkFactory(JSON.stringify({ identities: { user: { available: false } } }))
    const { deps } = setup({
      selects: ['teamwork-repos', 'existing'],
      inputs: ['main', 'cli_new'],
      passwords: ['shh'],
      confirms: [true],
      checkboxes: [['oc_dsh'], ['ou_me']],
    }, {
      lark: lark.run,
      stream: async (argv, env) => { streamCalls.push({ argv, env }); return 0 },
    })
    await runInitWizard(deps)
    const authCall = streamCalls.find(call => call.argv[0] === 'auth' && call.argv[1] === 'login')
    expect(authCall).toBeTruthy()
    expect(authCall?.argv).toEqual([
      'auth', 'login',
      '--domain', 'im,docs,drive,contact',
      // contact 域映射不含 contact:user.id:readonly，邮箱→open_id 依赖它，必须显式申请。
      '--scope', 'contact:user.id:readonly',
    ])
    expect(authCall?.env.HOME).toBe(LARK_PROFILE_HOME)
  })

  it('非交互模式不提问，只写默认配置并提示如何补齐必填项', async () => {
    const { home, out, deps } = setup({}, { prompts: undefined })
    const config = await runInitWizard(deps)
    expect(config.projects).toEqual([])
    expect(out.join('\n')).toContain('ra config set')
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('feishu:')
  })
})