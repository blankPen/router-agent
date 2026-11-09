import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chatEntry, defaultConfig, ensureHome, loadConfig, policyOf, setConfigValue, writeConfig } from '../src/config.js'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'ra-home-'))
}

describe('全局状态目录与配置', () => {
  it('ensureHome 创建目录结构并写入默认 config.yaml', () => {
    const dir = home()
    ensureHome(dir)
    for (const sub of ['logs', 'workers']) expect(existsSync(join(dir, sub))).toBe(true)
    const text = readFileSync(join(dir, 'config.yaml'), 'utf8')
    expect(text).toContain('acceptMode')
    expect(text).toContain('workerSpec')
  })

  it('没有配置时使用默认值：auto + 并发 4 + prompt 模式 + orca 运行时', () => {
    const cfg = loadConfig(home())
    expect(cfg.policy.acceptMode).toBe('auto')
    expect(cfg.policy.maxWorkers).toBe(4)
    expect(cfg.feishu.reaction).toBe('Typing')
    expect(cfg.workerSpec.mode).toBe('prompt')
    expect(cfg.runtime.default).toBe('orca')
  })

  it('旧版 backend 配置段兼容映射到 runtime', () => {
    const dir = home()
    writeFileSync(join(dir, 'config.yaml'), ['backend:', '  default: claude-cli'].join('\n'))
    expect(loadConfig(dir).runtime.default).toBe('claude-cli')
  })

  it('图片转文本默认开启，可配置关闭与阈值', () => {
    expect(loadConfig(home()).feishu.images).toEqual({ enabled: true, maxChars: 2_000, timeoutMs: 60_000 })

    const dir = home()
    ensureHome(dir)
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(join(dir, 'config.yaml'), [
      'feishu:',
      '  images:',
      '    enabled: false',
      '    maxChars: 500',
      '    timeoutMs: 30000',
    ].join('\n'))
    expect(loadConfig(dir).feishu.images).toEqual({ enabled: false, maxChars: 500, timeoutMs: 30_000 })
  })

  it('读取用户配置并覆盖默认值', () => {
    const dir = home()
    ensureHome(dir)
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(join(dir, 'config.yaml'), [
      'policy:',
      '  acceptMode: observe',
      '  maxWorkers: 2',
      'workerSpec:',
      '  mode: agent',
      'feishu:',
      '  chats: [oc_a]',
      '  otherChats: [oc_b]',
      '  directMessages: false',
      '  allowed: [ou_alice]',
      '  botOpenIds: [ou_bot]',
      'server:',
      '  port: 3999',
    ].join('\n'))
    const cfg = loadConfig(dir)
    expect(cfg.policy.acceptMode).toBe('observe')
    expect(cfg.workerSpec.mode).toBe('agent')
    expect(cfg.server.port).toBe(3999)
    expect(cfg.feishu.chats).toEqual([chatEntry('oc_a'), chatEntry('oc_b', { mode: 'mention' })])
  })

  it('非法 acceptMode / mode / port 回退到默认值而不是崩溃', () => {
    const dir = home()
    ensureHome(dir)
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(join(dir, 'config.yaml'), ['policy:', '  acceptMode: yolo', 'workerSpec:', '  mode: magic', 'server:', '  port: abc'].join('\n'))
    const cfg = loadConfig(dir)
    expect(cfg.policy.acceptMode).toBe('auto')
    expect(cfg.workerSpec.mode).toBe('prompt')
    expect(cfg.server.port).toBe(defaultConfig().server.port)
  })

  it('配置映射成 Policy：版本号随关键字段变化', () => {
    const base = { ...loadConfig(home()), feishu: { ...loadConfig(home()).feishu, chats: [chatEntry('oc_a')], allowed: ['ou_alice'] } }
    const p1 = policyOf(base)
    const p2 = policyOf({ ...base, policy: { ...base.policy, acceptMode: 'observe' } })
    expect(p1.version).not.toBe(p2.version)
    expect(p1.allowed).toEqual(['ou_alice'])
    expect(p1.receiveAll).toBe(true)
  })

  it('群级白名单：解析、写回、折算进 Policy', () => {
    const dir = home()
    ensureHome(dir)
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(join(dir, 'config.yaml'), [
      'feishu:',
      '  allowed: [ou_global]',
      '  chats:',
      '    - chat: oc_a',
      '      allowed: [ou_alice]',
      '    - chat: oc_b',
    ].join('\n'))
    const cfg = loadConfig(dir)
    expect(cfg.feishu.chats[0]?.allowed).toEqual(['ou_alice'])
    expect(cfg.feishu.chats[1]?.allowed).toEqual([])
    expect(policyOf(cfg).allowedByChat).toEqual({ oc_a: ['ou_alice'] })

    expect(setConfigValue(cfg, 'chatAllow.oc_b', 'ou_bob,ou_carol')).toBe(true)
    expect(cfg.feishu.chats[1]?.allowed).toEqual(['ou_bob', 'ou_carol'])
    expect(setConfigValue(cfg, 'chatAllow.oc_b', '')).toBe(true)
    expect(policyOf(cfg).allowedByChat).toEqual({ oc_a: ['ou_alice'] })

    writeConfig(dir, cfg)
    expect(loadConfig(dir).feishu.chats[0]?.allowed).toEqual(['ou_alice'])
  })

  it('只有 mode=all 的群才算 receiveAll（影响机器人推断候选）', () => {
    const base = loadConfig(home())
    expect(policyOf({ ...base, feishu: { ...base.feishu, chats: [chatEntry('oc_a', { mode: 'mention' })] } }).receiveAll).toBe(false)
    expect(policyOf({ ...base, feishu: { ...base.feishu, chats: [chatEntry('oc_a', { mode: 'mention' }), chatEntry('oc_b')] } }).receiveAll).toBe(true)
  })

  it('feishu.larkHome 支持配置文件与环境变量 RA_LARK_HOME（环境变量优先）', () => {
    const dir = home()
    ensureHome(dir)
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(join(dir, 'config.yaml'), ['feishu:', '  larkHome: /from/file'].join('\n'))
    expect(loadConfig(dir).feishu.larkHome).toBe('/from/file')
    expect(loadConfig(dir, { RA_LARK_HOME: '/from/env' }).feishu.larkHome).toBe('/from/env')
  })

  it('writeConfig 写回后能被 loadConfig 读回，且保留可选字段', () => {
    const dir = home()
    const cfg = loadConfig(dir)
    cfg.feishu.chats = [chatEntry('oc_a', { mode: 'mention', repo: 'router-agent', branch: 'main', sync: true })]
    cfg.feishu.allowed = ['ou_me']
    cfg.feishu.botOpenIds = ['ou_bot', 'cli_bot']
    cfg.feishu.larkHome = '/tmp/lark-home'
    cfg.feishu.appId = 'cli_dedicated'
    cfg.feishu.reaction = 'THUMBSUP'
    cfg.feishu.images = { enabled: false, maxChars: 800, timeoutMs: 15_000 }
    cfg.policy.acceptMode = 'observe'
    cfg.progress.syncMs = 30_000
    cfg.progress.probeMs = 90_000
    cfg.progress.silenceMs = 300_000
    cfg.progress.repeatMs = 600_000
    cfg.server.port = 3999
    writeConfig(dir, cfg)

    const loaded = loadConfig(dir)
    expect(loaded.feishu.chats).toEqual([chatEntry('oc_a', { mode: 'mention', repo: 'router-agent', branch: 'main', sync: true })])
    expect(loaded.feishu.allowed).toEqual(['ou_me'])
    expect(loaded.feishu.botOpenIds).toEqual(['ou_bot', 'cli_bot'])
    expect(loaded.feishu.larkHome).toBe('/tmp/lark-home')
    expect(loaded.feishu.appId).toBe('cli_dedicated')
    expect(loaded.feishu.reaction).toBe('THUMBSUP')
    expect(loaded.feishu.images).toEqual({ enabled: false, maxChars: 800, timeoutMs: 15_000 })
    expect(loaded.policy.acceptMode).toBe('observe')
    expect(loaded.progress.syncMs).toBe(30_000)
    expect(loaded.progress.probeMs).toBe(90_000)
    expect(loaded.progress.silenceMs).toBe(300_000)
    expect(loaded.progress.repeatMs).toBe(600_000)
    expect(loaded.server.port).toBe(3999)
  })

  it('setConfigValue 支持点路径与类型转换，非法值被拒绝', () => {
    const cfg = loadConfig(home())
    expect(setConfigValue(cfg, 'policy.acceptMode', 'observe')).toBe(true)
    expect(cfg.policy.acceptMode).toBe('observe')
    expect(setConfigValue(cfg, 'policy.acceptMode', 'yolo')).toBe(false)
    expect(setConfigValue(cfg, 'policy.maxWorkers', '2')).toBe(true)
    expect(cfg.policy.maxWorkers).toBe(2)
    expect(setConfigValue(cfg, 'policy.maxWorkers', '0')).toBe(false)
    expect(setConfigValue(cfg, 'progress.syncMs', '30000')).toBe(true)
    expect(cfg.progress.syncMs).toBe(30_000)
    expect(setConfigValue(cfg, 'progress.syncMs', '0')).toBe(true)
    expect(cfg.progress.syncMs).toBe(0)
    expect(setConfigValue(cfg, 'progress.syncMs', '-1')).toBe(false)
    expect(setConfigValue(cfg, 'progress.syncMs', 'abc')).toBe(false)
    expect(setConfigValue(cfg, 'progress.probeMs', '90000')).toBe(true)
    expect(cfg.progress.probeMs).toBe(90_000)
    expect(setConfigValue(cfg, 'progress.probeMs', '0')).toBe(true)
    expect(cfg.progress.probeMs).toBe(0)
    expect(setConfigValue(cfg, 'progress.probeMs', '-1')).toBe(false)
    expect(setConfigValue(cfg, 'progress.silenceMs', '300000')).toBe(true)
    expect(cfg.progress.silenceMs).toBe(300_000)
    expect(setConfigValue(cfg, 'progress.silenceMs', '0')).toBe(false)
    expect(setConfigValue(cfg, 'progress.repeatMs', '600000')).toBe(true)
    expect(cfg.progress.repeatMs).toBe(600_000)
    expect(setConfigValue(cfg, 'progress.repeatMs', 'abc')).toBe(false)
    expect(setConfigValue(cfg, 'feishu.chats', 'oc_a, oc_b')).toBe(true)
    expect(cfg.feishu.chats).toEqual([chatEntry('oc_a'), chatEntry('oc_b')])
    expect(setConfigValue(cfg, 'feishu.directMessages', 'false')).toBe(true)
    expect(cfg.feishu.directMessages).toBe(false)
    expect(setConfigValue(cfg, 'feishu.reaction', 'OnIt')).toBe(true)
    expect(cfg.feishu.reaction).toBe('OnIt')
    expect(setConfigValue(cfg, 'feishu.reaction', '')).toBe(true)
    expect(cfg.feishu.reaction).toBe('')
    expect(setConfigValue(cfg, 'workerSpec.mode', 'agent')).toBe(true)
    expect(cfg.workerSpec.mode).toBe('agent')
    expect(setConfigValue(cfg, 'workerSpec.mode', 'magic')).toBe(false)
    expect(setConfigValue(cfg, 'nope.nope', 'x')).toBe(false)
  })
})

describe('多项目与群绑定配置', () => {
  it('读取 projects，并兼容旧的 chatBindings（绑定即监控）', () => {
    const dir = home()
    ensureHome(dir)
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(join(dir, 'config.yaml'), [
      'projects:',
      '  - name: router-agent',
      '    repo: name:dsh/router-agent',
      '    defaultBranch: main',
      '    branches: [main, release]',
      '  - repo: teamwork-repos',
      'chatBindings:',
      '  oc_a:',
      '    repo: router-agent',
      '    branch: main',
      '  oc_b:',
      '    repo: teamwork-repos',
      '    branch: release',
    ].join('\n'))
    const cfg = loadConfig(dir)
    expect(cfg.projects).toEqual([
      { name: 'router-agent', repo: 'name:dsh/router-agent', branches: ['main', 'release'], defaultBranch: 'main' },
      { name: 'teamwork-repos', repo: 'teamwork-repos', branches: [], defaultBranch: '' },
    ])
    expect(cfg.feishu.chats).toEqual([
      chatEntry('oc_a', { repo: 'router-agent', branch: 'main' }),
      chatEntry('oc_b', { repo: 'teamwork-repos', branch: 'release' }),
    ])
  })

  it('旧配置（chats 字符串 / otherChats / syncChat）会迁移成统一的 chat 条目', () => {
    const dir = home()
    ensureHome(dir)
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(join(dir, 'config.yaml'), [
      'feishu:',
      '  chats: [oc_all]',
      '  otherChats: [oc_at, oc_all]',
      '  syncChat: [oc_all]',
    ].join('\n'))
    const cfg = loadConfig(dir)
    expect(cfg.feishu.chats).toEqual([
      chatEntry('oc_all', { mode: 'all', sync: true }),
      chatEntry('oc_at', { mode: 'mention' }),
    ])
    // otherChats 不会覆盖 chats 里的 all 模式
    expect(cfg.feishu.chats[0]?.mode).toBe('all')
  })

  it('setConfigValue 支持 project.<name> 与 chatBinding.<chat>，非法值被拒绝', () => {
    const cfg = loadConfig(home())
    expect(setConfigValue(cfg, 'project.router-agent', 'name:dsh/router-agent@main')).toBe(true)
    expect(cfg.projects).toEqual([{ name: 'router-agent', repo: 'name:dsh/router-agent', branches: [], defaultBranch: 'main' }])
    // 同名再设一次是覆盖，不是追加
    expect(setConfigValue(cfg, 'project.router-agent', 'name:dsh/router-agent@release')).toBe(true)
    expect(cfg.projects).toHaveLength(1)
    expect(cfg.projects[0]?.defaultBranch).toBe('release')

    // 绑定同时意味着监控这个群
    expect(setConfigValue(cfg, 'chatBinding.oc_a', 'router-agent@main')).toBe(true)
    expect(cfg.feishu.chats).toEqual([chatEntry('oc_a', { repo: 'router-agent', branch: 'main' })])
    expect(setConfigValue(cfg, 'chatBinding.oc_a', 'router-agent@release')).toBe(true)
    expect(cfg.feishu.chats).toHaveLength(1)
    expect(cfg.feishu.chats[0]?.branch).toBe('release')

    // 群列表替换时保留已有条目的绑定 / 模式
    expect(setConfigValue(cfg, 'chatMode.oc_a', 'mention')).toBe(true)
    expect(cfg.feishu.chats[0]?.mode).toBe('mention')
    expect(setConfigValue(cfg, 'feishu.chats', 'oc_a,oc_b')).toBe(true)
    expect(cfg.feishu.chats).toEqual([
      chatEntry('oc_a', { mode: 'mention', repo: 'router-agent', branch: 'release' }),
      chatEntry('oc_b'),
    ])
    expect(setConfigValue(cfg, 'chatSync.oc_b', 'true')).toBe(true)
    expect(cfg.feishu.chats[1]?.sync).toBe(true)

    expect(setConfigValue(cfg, 'project.', 'x')).toBe(false)
    expect(setConfigValue(cfg, 'chatBinding.oc_a', '')).toBe(false)
    expect(setConfigValue(cfg, 'chatMode.oc_a', 'yolo')).toBe(false)
  })

  it('writeConfig 写回后仍能读回 projects / 群配置', () => {
    const dir = home()
    const cfg = loadConfig(dir)
    cfg.projects = [{ name: 'router-agent', repo: 'name:dsh/router-agent', branches: ['main'], defaultBranch: 'main' }]
    cfg.feishu.chats = [
      chatEntry('oc_a', { mode: 'mention', repo: 'router-agent', branch: 'main', sync: true }),
      chatEntry('oc_b'),
    ]
    writeConfig(dir, cfg)

    const loaded = loadConfig(dir)
    expect(loaded.projects).toEqual(cfg.projects)
    expect(loaded.feishu.chats).toEqual(cfg.feishu.chats)
  })
})

describe('Pi 研判层配置', () => {
  it('默认带 60s 超时与 token 预算', () => {
    const cfg = loadConfig(home())
    expect(cfg.router).toMatchObject({
      timeoutMs: 60_000,
      tokenBudget: 32_000,
    })
  })

  it('读取 router 段，非法值回退默认', () => {
    const dir = home()
    ensureHome(dir)
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(join(dir, 'config.yaml'), [
      'router:',
      '  timeoutMs: 15000',
      '  tokenBudget: 8000',
      '  agentDir: /tmp/ra-pi',
    ].join('\n'))
    const cfg = loadConfig(dir)
    expect(cfg.router).toMatchObject({
      timeoutMs: 15000,
      tokenBudget: 8000,
      agentDir: '/tmp/ra-pi',
    })
  })

  it('config set 支持 router.*，非法值拒绝', () => {
    const cfg = defaultConfig()
    expect(setConfigValue(cfg, 'router.timeoutMs', '30000')).toBe(true)
    expect(cfg.router.timeoutMs).toBe(30000)
    expect(setConfigValue(cfg, 'router.tokenBudget', '0')).toBe(true)
    expect(cfg.router.tokenBudget).toBe(0)
    expect(setConfigValue(cfg, 'router.agentDir', '/tmp/pi')).toBe(true)
    expect(cfg.router.agentDir).toBe('/tmp/pi')

    expect(setConfigValue(cfg, 'router.timeoutMs', '10')).toBe(false)
  })

  it('writeConfig 写回后 router 段仍能读回', () => {
    const dir = home()
    const cfg = loadConfig(dir)
    cfg.router.timeoutMs = 45000
    cfg.router.tokenBudget = 16000
    writeConfig(dir, cfg)

    const loaded = loadConfig(dir)
    expect(loaded.router.timeoutMs).toBe(45000)
    expect(loaded.router.tokenBudget).toBe(16000)
  })
})

describe('会话复用与人格配置', () => {
  it('默认开启按人隔离、7 天保留、Pi 压缩', () => {
    const cfg = loadConfig(home())
    expect(cfg.router.session).toMatchObject({
      enabled: true,
      keyScope: 'user',
      retentionDays: 7,
      maxActive: 50,
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    })
    expect(cfg.router.persona).toMatchObject({ name: '阿罗', style: 'friendly', language: 'zh-CN' })
  })

  it('YAML 覆盖 session / persona 后能读回', () => {
    const dir = home()
    ensureHome(dir)
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(join(dir, 'config.yaml'), [
      'router:',
      '  session:',
      '    enabled: false',
      '    keyScope: thread',
      '    retentionDays: 3',
      '    compaction:',
      '      enabled: false',
      '  persona:',
      '    name: 小助手',
      '    style: concise',
    ].join('\n'))
    const cfg = loadConfig(dir)
    expect(cfg.router.session.enabled).toBe(false)
    expect(cfg.router.session.keyScope).toBe('thread')
    expect(cfg.router.session.retentionDays).toBe(3)
    expect(cfg.router.session.compaction.enabled).toBe(false)
    expect(cfg.router.persona.name).toBe('小助手')
    expect(cfg.router.persona.style).toBe('concise')
  })
})
