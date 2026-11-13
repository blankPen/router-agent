import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyConfigPatch,
  chatEntry,
  defaultConfig,
  ensureHome,
  loadConfig,
  policyOf,
  projectsForRuntime,
  publicConfig,
  publicPlugins,
  setConfigValue,
  setProjectsForRuntime,
  writeConfig,
} from '../src/config.js'

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
    expect(text).toContain('runtime')
  })

  it('没有配置时使用默认值：auto + 并发 4 + orca 运行时', () => {
    const cfg = loadConfig(home())
    expect(cfg.policy.acceptMode).toBe('auto')
    expect(cfg.policy.maxWorkers).toBe(4)
    expect(cfg.policy.interruptedRecovery).toBe('auto')
    expect(cfg.policy.maxAutoRecover).toBe(1)
    expect(cfg.feishu.reaction).toBe('Typing')
    expect(cfg.worker.evidence.ui).toBe('warn')
    // 群级「处理普通成员消息」默认关闭：不改变存量群的回复行为；追问轮次默认 10 轮。
    expect(cfg.feishu.chats).toEqual([])
    expect(cfg.runtime.default).toBe('orca')
  })

  it('旧版 backend 配置段兼容映射到 runtime', () => {
    const dir = home()
    writeFileSync(join(dir, 'config.yaml'), ['backend:', '  default: claude-cli'].join('\n'))
    expect(loadConfig(dir).runtime.default).toBe('claude-code')
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
      'worker:',
      '  evidence:',
      '    ui: enforce',
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
    expect(cfg.server.port).toBe(3999)
    expect(cfg.policy.maxWorkers).toBe(2)
    expect(cfg.worker.evidence.ui).toBe('enforce')
    expect(cfg.feishu.chats).toEqual([chatEntry('oc_a'), chatEntry('oc_b', { scope: 'mention' })])
  })

  it('非法 acceptMode / port 回退到默认值而不是崩溃', () => {
    const dir = home()
    ensureHome(dir)
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(join(dir, 'config.yaml'), ['policy:', '  acceptMode: yolo', 'server:', '  port: abc'].join('\n'))
    const cfg = loadConfig(dir)
    expect(cfg.policy.acceptMode).toBe('auto')
    expect(cfg.server.port).toBe(defaultConfig().server.port)
  })

  it('interruptedRecovery 可配置，非法值回退到 auto', () => {
    const dir = home()
    ensureHome(dir)
    writeFileSync(
      join(dir, 'config.yaml'),
      ['policy:', '  interruptedRecovery: notify', '  maxAutoRecover: 3'].join('\n'),
    )
    const cfg = loadConfig(dir)
    expect(cfg.policy.interruptedRecovery).toBe('notify')
    expect(cfg.policy.maxAutoRecover).toBe(3)

    const bad = home()
    ensureHome(bad)
    writeFileSync(
      join(bad, 'config.yaml'),
      ['policy:', '  interruptedRecovery: whatever', '  maxAutoRecover: -5'].join('\n'),
    )
    const fallback = loadConfig(bad)
    expect(fallback.policy.interruptedRecovery).toBe('auto')
    expect(fallback.policy.maxAutoRecover).toBe(1)
  })

  it('配置映射成 Policy：版本号随关键字段变化', () => {
    const base = { ...loadConfig(home()), feishu: { ...loadConfig(home()).feishu, chats: [chatEntry('oc_a')], allowed: ['ou_alice'] } }
    const p1 = policyOf(base)
    const p2 = policyOf({ ...base, policy: { ...base.policy, acceptMode: 'observe' } })
    expect(p1.version).not.toBe(p2.version)
    expect(p1.allowed).toEqual(['ou_alice'])
    expect(p1.scopeByChat).toEqual({ oc_a: 'mention' })
  })

  it('名单解析结果写进 Policy，但不进版本指纹', () => {
    const base = { ...loadConfig(home()), feishu: { ...loadConfig(home()).feishu, chats: [chatEntry('oc_a')], allowed: ['a@b.com'] } }
    const plain = policyOf(base)
    const resolved = policyOf(base, {
      allowedOpenIds: ['ou_alice'],
      allowedByChatOpenIds: { oc_a: ['ou_alice'] },
      names: { ou_alice: 'Alice' },
    })
    // 版本指纹只由原始配置决定：解析结果抖动不得触发 policy 变更
    expect(resolved.version).toBe(plain.version)
    expect(resolved.allowedOpenIds).toEqual(['ou_alice'])
    expect(resolved.allowedByChatOpenIds).toEqual({ oc_a: ['ou_alice'] })
    expect(resolved.names).toEqual({ ou_alice: 'Alice' })
    expect(plain.allowedOpenIds).toBeUndefined()
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

  it('每个群的消息范围都折算进 Policy', () => {
    const base = loadConfig(home())
    const policy = policyOf({
      ...base,
      feishu: { ...base.feishu, chats: [chatEntry('oc_a', { scope: 'admins' }), chatEntry('oc_b', { scope: 'all' })] },
    })
    expect(policy.scopeByChat).toEqual({ oc_a: 'admins', oc_b: 'all' })
  })

  it('旧配置里的 feishu.larkHome 被忽略，保存后不再写回', () => {
    const dir = home()
    ensureHome(dir)
    writeFileSync(join(dir, 'config.yaml'), ['feishu:', '  larkHome: /legacy'].join('\n'))
    const loaded = loadConfig(dir)
    expect('larkHome' in loaded.feishu).toBe(false)
    writeConfig(dir, loaded)
    expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).not.toContain('larkHome')
  })

  it('writeConfig 写回后能被 loadConfig 读回，且保留可选字段', () => {
    const dir = home()
    const cfg = loadConfig(dir)
    cfg.feishu.chats = [chatEntry('oc_a', { scope: 'mention', repo: 'router-agent', branch: 'main' })]
    cfg.feishu.allowed = ['ou_me']
    cfg.feishu.botOpenIds = ['ou_bot', 'cli_bot']
    cfg.feishu.appId = 'cli_dedicated'
    cfg.feishu.reaction = 'THUMBSUP'
    cfg.feishu.images = { enabled: false, maxChars: 800, timeoutMs: 15_000 }
    cfg.policy.acceptMode = 'observe'
    cfg.progress.syncMs = 30_000
    cfg.progress.probeMs = 90_000
    cfg.progress.silenceMs = 300_000
    cfg.progress.repeatMs = 600_000
    cfg.server.port = 3999
    cfg.worker.skill.mode = 'inline'
    cfg.reply.ask = { mode: 'callback', allow: 'requester', timeoutMs: 10 * 60_000 }
    writeConfig(dir, cfg)

    const loaded = loadConfig(dir)
    expect(loaded.feishu.chats).toEqual([chatEntry('oc_a', { scope: 'mention', repo: 'router-agent', branch: 'main' })])
    expect(loaded.feishu.allowed).toEqual(['ou_me'])
    expect(loaded.feishu.botOpenIds).toEqual(['ou_bot', 'cli_bot'])
    expect(loaded.feishu.appId).toBe('cli_dedicated')
    expect(loaded.feishu.reaction).toBe('THUMBSUP')
    expect(loaded.feishu.images).toEqual({ enabled: false, maxChars: 800, timeoutMs: 15_000 })
    expect(loaded.policy.acceptMode).toBe('observe')
    expect(loaded.progress.syncMs).toBe(30_000)
    expect(loaded.progress.probeMs).toBe(90_000)
    expect(loaded.progress.silenceMs).toBe(300_000)
    expect(loaded.progress.repeatMs).toBe(600_000)
    expect(loaded.server.port).toBe(3999)
    expect(loaded.worker.skill.mode).toBe('inline')
    expect(loaded.reply.ask).toEqual({ mode: 'callback', allow: 'requester', timeoutMs: 10 * 60_000 })
  })

  it('setConfigValue 支持点路径与类型转换，非法值被拒绝', () => {
    const cfg = loadConfig(home())
    expect(cfg.worker.skill.mode).toBe('path')
    expect(setConfigValue(cfg, 'worker.skill.mode', 'inline')).toBe(true)
    expect(cfg.worker.skill.mode).toBe('inline')
    expect(setConfigValue(cfg, 'worker.skill.mode', 'nope')).toBe(false)
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
    expect(setConfigValue(cfg, 'worker.evidence.ui', 'enforce')).toBe(true)
    expect(cfg.worker.evidence.ui).toBe('enforce')
    expect(setConfigValue(cfg, 'worker.evidence.ui', 'magic')).toBe(false)
    expect(setConfigValue(cfg, 'llm.api', 'anthropic-messages')).toBe(true)
    expect(cfg.llm?.api).toBe('anthropic-messages')
    expect(setConfigValue(cfg, 'llm.api', 'bogus')).toBe(false)
    expect(setConfigValue(cfg, 'llm.authHeader', 'true')).toBe(true)
    expect(cfg.llm?.authHeader).toBe(true)
    expect(setConfigValue(cfg, 'llm.authHeader', 'yes')).toBe(false)
    expect(setConfigValue(cfg, 'llm.contextWindow', '200000')).toBe(true)
    expect(cfg.llm?.contextWindow).toBe(200_000)
    expect(setConfigValue(cfg, 'llm.contextWindow', '0')).toBe(false)
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
      { name: 'router-agent', repo: 'name:dsh/router-agent', defaultBranch: 'main' },
      { name: 'teamwork-repos', repo: 'teamwork-repos', defaultBranch: '' },
    ])
    expect(cfg.feishu.chats).toEqual([
      chatEntry('oc_a', { repo: 'router-agent', branch: 'main' }),
      // teamwork-repos 没有默认分支；群分支不再允许自定义，加载时被清空
      chatEntry('oc_b', { repo: 'teamwork-repos', branch: '' }),
    ])
  })

  it('旧配置（chats 字符串 / otherChats）会迁移成统一的 chat 条目', () => {
    const dir = home()
    ensureHome(dir)
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(join(dir, 'config.yaml'), [
      'feishu:',
      '  chats: [oc_all]',
      '  otherChats: [oc_at, oc_all]',
    ].join('\n'))
    const cfg = loadConfig(dir)
    expect(cfg.feishu.chats).toEqual([
      chatEntry('oc_all'),
      chatEntry('oc_at', { scope: 'mention' }),
    ])
    // otherChats 不会覆盖 chats 里的范围
    expect(cfg.feishu.chats[0]?.scope).toBe('mention')
  })

  it('setConfigValue 支持 project.<name> 与 chatBinding.<chat>，非法值被拒绝', () => {
    const cfg = loadConfig(home())
    expect(setConfigValue(cfg, 'project.router-agent', '/Users/me/router-agent@main')).toBe(true)
    expect(cfg.projects).toEqual([{ name: 'router-agent', repo: '/Users/me/router-agent', defaultBranch: 'main' }])
    // 项目路径统一是本地绝对路径：Orca 的 name:/id: 选择器不再接受
    expect(setConfigValue(cfg, 'project.router-agent', 'name:dsh/router-agent@main')).toBe(false)
    // 同名再设一次是覆盖，不是追加
    expect(setConfigValue(cfg, 'project.router-agent', '/Users/me/router-agent@release')).toBe(true)
    expect(cfg.projects).toHaveLength(1)
    expect(cfg.projects[0]?.defaultBranch).toBe('release')

    // 绑定同时意味着监控这个群；分支跟随项目的默认分支（此处已改成 release）
    expect(setConfigValue(cfg, 'chatBinding.oc_a', 'router-agent@main')).toBe(true)
    expect(cfg.feishu.chats).toEqual([chatEntry('oc_a', { repo: 'router-agent', branch: 'release' })])
    expect(setConfigValue(cfg, 'chatBinding.oc_a', 'router-agent@main')).toBe(true)
    expect(cfg.feishu.chats).toHaveLength(1)
    expect(cfg.feishu.chats[0]?.branch).toBe('release')

    // 群列表替换时保留已有条目的绑定 / 消息范围
    expect(setConfigValue(cfg, 'chatScope.oc_a', 'admins')).toBe(true)
    expect(cfg.feishu.chats[0]?.scope).toBe('admins')
    expect(setConfigValue(cfg, 'feishu.chats', 'oc_a,oc_b')).toBe(true)
    expect(cfg.feishu.chats).toEqual([
      chatEntry('oc_a', { scope: 'admins', repo: 'router-agent', branch: 'release' }),
      chatEntry('oc_b'),
    ])
    // 补拉功能已移除，旧路径不再可用
    expect(setConfigValue(cfg, 'chatSync.oc_b', 'true')).toBe(false)

    expect(setConfigValue(cfg, 'project.', 'x')).toBe(false)
    expect(setConfigValue(cfg, 'chatBinding.oc_a', '')).toBe(false)
    expect(setConfigValue(cfg, 'chatScope.oc_a', 'yolo')).toBe(false)
  })

  it('writeConfig 写回后仍能读回 projects / 群配置', () => {
    const dir = home()
    const cfg = loadConfig(dir)
    cfg.projects = [{ name: 'router-agent', repo: 'name:dsh/router-agent', defaultBranch: 'main' }]
    cfg.feishu.chats = [
      chatEntry('oc_a', { scope: 'mention', repo: 'router-agent', branch: 'main' }),
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

  it('普通成员消息是群级配置：可写回并读回，patch 做类型与范围校验', () => {
    const dir = home()
    const cfg = loadConfig(dir)
    const patch = applyConfigPatch(cfg, {
      'feishu.chats': [{
        chat: 'oc_dev',
        scope: 'all',
        repo: '',
        branch: '',
        allowed: [],
        members: { maxQuestions: 2, codeAccess: false, approvers: ['admin@example.com'] },
      }],
    })
    expect(patch.errors).toEqual([])
    writeConfig(dir, cfg)

    const loaded = loadConfig(dir)
    expect(loaded.feishu.chats[0]?.members).toEqual({
      maxQuestions: 2,
      codeAccess: false,
      approvers: ['admin@example.com'],
    })
    expect(loaded.feishu.chats[0]?.scope).toBe('all')

    // 轮次越界：0–50 的整数。
    expect(applyConfigPatch(loadConfig(home()), {
      'feishu.chats': [{ chat: 'oc_dev', scope: 'all', repo: '', branch: '', allowed: [], members: { maxQuestions: 51, codeAccess: true, approvers: [] } }],
    }).errors).toHaveLength(1)
    // 全局路径已经下沉到群级，不再是合法的配置项。
    expect(applyConfigPatch(loadConfig(home()), { 'intake.enabled': true }).errors).toHaveLength(1)
  })

  it('新建群默认：消息范围 mention、10 轮追问、允许只读代码', () => {
    const cfg = loadConfig(home())
    expect(chatEntry('oc_new').scope).toBe('mention')
    expect(chatEntry('oc_new').members).toEqual({ maxQuestions: 10, codeAccess: true, approvers: [] })
    expect(cfg.feishu.chats).toEqual([])
  })

  it('旧版全局 intake 段迁移到群级配置，并写回时不再输出全局段', () => {
    const dir = home()
    writeFileSync(join(dir, 'config.yaml'), [
      'feishu:',
      '  chats:',
      '    - chat: oc_dev',
      '      mode: all',
      '    - chat: oc_ops',
      '      mode: mention',
      'intake:',
      '  enabled: true',
      '  chats: [oc_dev]',
      '  maxQuestions: 6',
      '  codeAccess: false',
      '  approvers: [admin@example.com]',
      '',
    ].join('\n'))
    const cfg = loadConfig(dir)
    expect(cfg.feishu.chats.find(chat => chat.chat === 'oc_dev')?.members).toEqual({
      maxQuestions: 6,
      codeAccess: false,
      approvers: ['admin@example.com'],
    })
    // 旧 intake 开启过的群：消息范围至少接受普通成员 @ 消息。
    expect(cfg.feishu.chats.find(chat => chat.chat === 'oc_dev')?.scope).toBe('mention')
    // 不在旧白名单里的群只迁参数，不迁开关。
    expect(cfg.feishu.chats.find(chat => chat.chat === 'oc_ops')?.members?.maxQuestions).toBe(10)
    // 写回后全局段消失，只剩群级配置。
    writeConfig(dir, cfg)
    const text = readFileSync(join(dir, 'config.yaml'), 'utf8')
    expect(text).not.toContain('\nintake:')
    expect(text).toContain('members:')
  })

  it('旧版全局 intake 段没写生效群时迁移到所有已监控的群', () => {
    const dir = home()
    writeFileSync(join(dir, 'config.yaml'), [
      'feishu:',
      '  chats:',
      '    - chat: oc_dev',
      '    - chat: oc_ops',
      'intake:',
      '  enabled: true',
      '  maxQuestions: 4',
      '',
    ].join('\n'))
    const cfg = loadConfig(dir)
    for (const chat of cfg.feishu.chats) {
      expect(chat.members.maxQuestions).toBe(4)
      expect(chat.scope).not.toBe('admins')
    }
  })

  it('群上已经写了普通成员配置时，旧全局段不再覆盖它', () => {
    const dir = home()
    writeFileSync(join(dir, 'config.yaml'), [
      'feishu:',
      '  chats:',
      '    - chat: oc_dev',
      '      members:',
      '        maxQuestions: 7',
      'intake:',
      '  enabled: true',
      '  maxQuestions: 2',
      '',
    ].join('\n'))
    const cfg = loadConfig(dir)
    expect(cfg.feishu.chats[0]?.members).toMatchObject({ maxQuestions: 7 })
  })

  it('群上旧的 intake 段按同一口径读成普通成员配置', () => {
    const dir = home()
    writeFileSync(join(dir, 'config.yaml'), [
      'feishu:',
      '  chats:',
      '    - chat: oc_dev',
      '      intake:',
      '        maxQuestions: 3',
      '',
    ].join('\n'))
    const cfg = loadConfig(dir)
    expect(cfg.feishu.chats[0]?.members).toMatchObject({ maxQuestions: 3 })
  })
})

describe('决策层配置（Jev）', () => {
  it('决策层默认关闭，Provider 默认走 Jev', () => {
    const cfg = loadConfig(home(), {})
    expect(cfg.decision.enabled).toBe(false)
    expect(cfg.decision.provider).toBe('jev')
    expect(cfg.decision.jev.apiKey).toBe('')
    expect(cfg.decision.jev.model).toBe('')
  })

  it('面板保存其它配置后，手写的 decision 段不被冲掉', () => {
    const dir = home()
    ensureHome(dir)
    // 环境变量优先级高于 YAML：这里用空 env，保证断言的是配置里写的值。
    const cfg = loadConfig(dir, {})
    cfg.decision.enabled = true
    cfg.decision.jev.model = 'jev-latest'
    cfg.decision.jev.apiKey = 'sk-jev'
    writeConfig(dir, cfg)

    // 面板保存一个无关字段：走的是「读配置 → 打补丁 → 整体写回」。
    const loaded = loadConfig(dir, {})
    const patched = applyConfigPatch(loaded, { 'policy.maxWorkers': 3 })
    expect(patched.errors).toEqual([])
    writeConfig(dir, loaded)

    const after = loadConfig(dir, {})
    expect(after.decision.enabled).toBe(true)
    expect(after.decision.jev.model).toBe('jev-latest')
    expect(after.decision.jev.apiKey).toBe('sk-jev')
  })

  it('面板可以保存决策层开关、Provider 与 Jev 连接信息', () => {
    const cfg = defaultConfig()
    const result = applyConfigPatch(cfg, {
      'decision.enabled': true,
      'decision.provider': 'llm',
      'decision.jev.model': 'jev-latest',
      'decision.jev.apiKey': ' sk-jev ',
    })
    expect(result.errors).toEqual([])
    expect(cfg.decision.enabled).toBe(true)
    expect(cfg.decision.provider).toBe('llm')
    expect(cfg.decision.jev.model).toBe('jev-latest')
    expect(cfg.decision.jev.apiKey).toBe('sk-jev')
  })

  it('决策层配置非法值被拒绝', () => {
    const cfg = defaultConfig()
    expect(applyConfigPatch(cfg, { 'decision.provider': 'nope' }).errors).toHaveLength(1)
    expect(applyConfigPatch(cfg, { 'decision.enabled': 'yes' }).errors).toHaveLength(1)
  })

  it('config set 支持 decision.*，非法值拒绝', () => {
    const cfg = defaultConfig()
    expect(setConfigValue(cfg, 'decision.enabled', 'true')).toBe(true)
    expect(setConfigValue(cfg, 'decision.provider', 'llm')).toBe(true)
    expect(setConfigValue(cfg, 'decision.jev.model', 'jev-latest')).toBe(true)
    expect(setConfigValue(cfg, 'decision.provider', 'nope')).toBe(false)
    expect(cfg.decision.enabled).toBe(true)
    expect(cfg.decision.provider).toBe('llm')
    expect(cfg.decision.jev.model).toBe('jev-latest')
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

describe('Worker 运行时配置', () => {
  it('允许 orca / claude-code，未知值被拒绝', () => {
    const cfg = defaultConfig()
    expect(applyConfigPatch(cfg, { 'runtime.default': 'claude-code' })).toEqual({ errors: [], changed: ['runtime.default'] })
    expect(cfg.runtime.default).toBe('claude-code')
    const bad = applyConfigPatch(cfg, { 'runtime.default': 'claude' })
    expect(bad.errors[0]?.path).toBe('runtime.default')
  })

  it('旧值 claude-cli 写入时归一为 claude-code', () => {
    const cfg = defaultConfig()
    const result = applyConfigPatch(cfg, { 'runtime.default': 'claude-cli' })
    expect(result.errors).toEqual([])
    expect(cfg.runtime.default).toBe('claude-code')
  })

  it('YAML 里的 claude-cli 在加载时归一', () => {
    const dir = home()
    ensureHome(dir)
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(join(dir, 'config.yaml'), ['backend:', '  default: claude-cli'].join('\n'))
    expect(loadConfig(dir).runtime.default).toBe('claude-code')
  })

  it('CLI setConfigValue 接受新 id 并拒绝未知值', () => {
    const cfg = defaultConfig()
    expect(setConfigValue(cfg, 'runtime.default', 'claude-code')).toBe(true)
    expect(cfg.runtime.default).toBe('claude-code')
    expect(setConfigValue(cfg, 'runtime.default', 'nope')).toBe(false)
  })

  it('接受 ACP 目录里的动态 id，拒绝拼错的 acp-*', () => {
    const cfg = defaultConfig()
    expect(applyConfigPatch(cfg, { 'runtime.default': 'acp-codex' })).toEqual({ errors: [], changed: ['runtime.default'] })
    expect(cfg.runtime.default).toBe('acp-codex')
    expect(setConfigValue(cfg, 'runtime.default', 'acp-claude')).toBe(true)
    expect(setConfigValue(cfg, 'runtime.default', 'acp-nope')).toBe(false)
    expect(applyConfigPatch(cfg, { 'runtime.default': 'acp-nope' }).errors).toHaveLength(1)
  })

  it('同一次保存里声明插件并选为默认运行时不会被拒绝', () => {
    const cfg = defaultConfig()
    const result = applyConfigPatch(cfg, {
      'runtime.plugins.my-runtime': './my-runtime',
      'runtime.default': 'my-runtime',
    })
    expect(result.errors).toEqual([])
    expect(cfg.runtime.default).toBe('my-runtime')
    expect(cfg.runtime.plugins?.['my-runtime']).toBe('./my-runtime')
  })

  it('同一次保存里新增 channel 插件不会因未知 id 被拒绝', () => {
    const cfg = defaultConfig()
    const result = applyConfigPatch(cfg, { 'channels.slack': '@scope/channel-slack' })
    expect(result.errors).toEqual([])
    expect(cfg.channels?.slack).toBe('@scope/channel-slack')
  })

  it('插件 createAll 注册的实例 id 可作为默认运行时', () => {
    const cfg = defaultConfig()
    cfg.runtime.plugins = { multi: './multi-runtime' }
    cfg.runtime.loadedIds = ['multi-a', 'multi-b']
    expect(applyConfigPatch(cfg, { 'runtime.default': 'multi-a' }).errors).toEqual([])
    expect(cfg.runtime.default).toBe('multi-a')
  })

  it('多实例插件只出面板一行，实例 id 收进 loadedIds', () => {
    const cfg = defaultConfig()
    cfg.runtime.plugins = { multi: './multi-runtime' }
    const views = publicPlugins(cfg, {
      runtimes: [{ id: 'multi', name: 'Multi', label: 'multi', hint: '多实例', loadedIds: ['multi-a', 'multi-b'] }],
    })
    const multi = views.filter(view => view.kind === 'runtime' && view.id === 'multi')
    expect(multi).toHaveLength(1)
    expect(multi[0]?.loadedIds).toEqual(['multi-a', 'multi-b'])
    // createAll 的实例 id 不该各自再占一行。
    expect(views.some(view => view.id === 'multi-a')).toBe(false)
  })

  it('runtime.projects.acp-codex 写回后重读不丢', () => {
    const dir = home()
    ensureHome(dir)
    const cfg = defaultConfig()
    cfg.runtime.default = 'acp-codex'
    setProjectsForRuntime(cfg, 'acp-codex', [{ name: 'a', repo: '/Users/me/a', defaultBranch: 'main' }])
    writeConfig(dir, cfg)
    expect(projectsForRuntime(loadConfig(dir), 'acp-codex')).toEqual([
      { name: 'a', repo: '/Users/me/a', defaultBranch: 'main' },
    ])
  })

  it('publicConfig 遮蔽 runtime.options.*.env 明文', () => {
    const cfg = defaultConfig()
    cfg.runtime.options = {
      'acp-codex': { env: { OPENAI_API_KEY: 'sk-secret' }, args: ['--message-streaming'] },
      acp: { env: { TOKEN: 'token-secret' } },
    }
    const published = publicConfig(cfg) as { runtime: { options: Record<string, { env?: unknown; envKeys?: string[] }> } }
    expect(published.runtime.options['acp-codex']?.env).toBeUndefined()
    expect(published.runtime.options['acp-codex']?.envKeys).toEqual(['OPENAI_API_KEY'])
    expect(published.runtime.options.acp?.env).toBeUndefined()
    expect(JSON.stringify(published)).not.toContain('sk-secret')
    expect(JSON.stringify(published)).not.toContain('token-secret')
  })

  it('面板可以写入 llm.apiKey，写入后落盘但不下发明文', () => {
    const dir = home()
    ensureHome(dir)
    const cfg = defaultConfig()
    const result = applyConfigPatch(cfg, {
      'llm.baseUrl': 'https://api.deepseek.com/v1',
      'llm.model': 'deepseek-v4-flash',
      'llm.apiKey': 'sk-panel-secret',
    })
    expect(result.errors).toEqual([])
    expect(result.changed).toEqual(['llm.baseUrl', 'llm.model', 'llm.apiKey'])
    expect(cfg.llm).toMatchObject({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-panel-secret',
    })

    const published = publicConfig(cfg) as { llm: Record<string, unknown> }
    expect(published.llm).toEqual({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      api: 'openai-completions',
      authHeader: false,
      apiKeySet: true,
    })
    expect(JSON.stringify(published)).not.toContain('sk-panel-secret')

    writeConfig(dir, cfg)
    expect(loadConfig(dir).llm?.apiKey).toBe('sk-panel-secret')
    expect(applyConfigPatch(cfg, { 'llm.apiKey': 123 }).errors).toHaveLength(1)
    expect(applyConfigPatch(cfg, { 'llm.apiKey': '   ' }).errors).toHaveLength(1)
    // 从本地配置导入时使用的协议与鉴权方式也要能落盘。
    expect(applyConfigPatch(cfg, { 'llm.api': 'anthropic-messages', 'llm.authHeader': true }).errors).toEqual([])
    expect(cfg.llm).toMatchObject({ api: 'anthropic-messages', authHeader: true })
    expect(applyConfigPatch(cfg, { 'llm.api': 'bogus' }).errors).toHaveLength(1)
    expect(applyConfigPatch(cfg, { 'llm.authHeader': 'yes' }).errors).toHaveLength(1)
  })
})

describe('项目清单按运行时隔离', () => {
  it('顶层 projects 只归 orca，claude-code 读 runtime.projects.claude-code', () => {
    const dir = home()
    ensureHome(dir)
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(join(dir, 'config.yaml'), [
      'projects:',
      '  - name: router-agent',
      '    repo: name:dsh/router-agent',
      '    defaultBranch: main',
      'backend:',
      '  default: claude-code',
      '  projects:',
      '    claude-code:',
      '      - name: router-agent',
      '        repo: /Users/me/router-agent',
      '        defaultBranch: main',
    ].join('\n'))
    const cfg = loadConfig(dir)
    expect(cfg.projects).toEqual([{ name: 'router-agent', repo: 'name:dsh/router-agent', defaultBranch: 'main' }])
    expect(projectsForRuntime(cfg, 'orca')).toEqual(cfg.projects)
    expect(projectsForRuntime(cfg)).toEqual([{ name: 'router-agent', repo: '/Users/me/router-agent', defaultBranch: 'main' }])
  })

  it('applyConfigPatch 按路径写两套清单，并校验 claude-code 必须是本地路径', () => {
    const cfg = defaultConfig()
    const ok = applyConfigPatch(cfg, {
      'runtime.default': 'claude-code',
      'runtime.projects.claude-code': [{ name: 'router-agent', repo: '/Users/me/router-agent', defaultBranch: 'main' }],
    })
    expect(ok.errors).toEqual([])
    expect(projectsForRuntime(cfg, 'claude-code')).toHaveLength(1)
    // orca 清单不受影响
    expect(cfg.projects).toEqual([])

    const bad = applyConfigPatch(cfg, {
      'runtime.projects.claude-code': [{ name: 'router-agent', repo: 'name:dsh/router-agent', defaultBranch: 'main' }],
    })
    expect(bad.errors[0]?.path).toBe('runtime.projects.claude-code')
    expect(bad.errors[0]?.message).toContain('本地仓库绝对路径')
  })

  it('orca 清单同样要求本地绝对路径（所有 runtime 统一口径）', () => {
    const cfg = defaultConfig()
    const bad = applyConfigPatch(cfg, {
      projects: [{ name: 'router-agent', repo: 'name:dsh/router-agent', defaultBranch: 'main' }],
    })
    expect(bad.errors[0]?.path).toBe('projects')
    expect(bad.errors[0]?.message).toContain('本地仓库绝对路径')

    const ok = applyConfigPatch(cfg, {
      projects: [{ name: 'router-agent', repo: '/Users/me/router-agent', defaultBranch: 'main' }],
    })
    expect(ok.errors).toEqual([])
    expect(cfg.projects[0]?.repo).toBe('/Users/me/router-agent')
  })

  it('CLI setConfigValue 对 orca 也只接受本地绝对路径', () => {
    const cfg = defaultConfig()
    expect(cfg.runtime.default).toBe('orca')
    expect(setConfigValue(cfg, 'project.router-agent', '/Users/me/router-agent@main')).toBe(true)
    expect(cfg.projects[0]).toMatchObject({ name: 'router-agent', repo: '/Users/me/router-agent', defaultBranch: 'main' })
    expect(setConfigValue(cfg, 'project.other', 'name:dsh/other@main')).toBe(false)
  })

  it('writeConfig 保留两套清单并重新读回', () => {
    const dir = home()
    const cfg = defaultConfig()
    cfg.projects = [{ name: 'a', repo: 'name:a', defaultBranch: 'main' }]
    setProjectsForRuntime(cfg, 'claude-code', [{ name: 'a', repo: '/Users/me/a', defaultBranch: 'dev' }])
    writeConfig(dir, cfg)
    const loaded = loadConfig(dir)
    expect(loaded.projects).toEqual(cfg.projects)
    expect(projectsForRuntime(loaded, 'claude-code')).toEqual(projectsForRuntime(cfg, 'claude-code'))
  })

  it('CLI setConfigValue 写当前默认运行时的清单', () => {
    const cfg = defaultConfig()
    cfg.runtime.default = 'claude-code'
    expect(setConfigValue(cfg, 'project.router-agent', '/Users/me/router-agent@main')).toBe(true)
    expect(projectsForRuntime(cfg, 'claude-code')[0]).toMatchObject({ name: 'router-agent', repo: '/Users/me/router-agent', defaultBranch: 'main' })
    expect(cfg.projects).toEqual([])
    // claude-code 不接受 name: 选择器
    expect(setConfigValue(cfg, 'project.other', 'name:dsh/other@main')).toBe(false)
  })
})

describe('群绑定跟随项目清单', () => {
  it('保存群配置时分支强制取项目默认分支', () => {
    const cfg = defaultConfig()
    cfg.projects = [{ name: 'router-agent', repo: 'name:dsh/router-agent', defaultBranch: 'main' }]
    const result = applyConfigPatch(cfg, {
      'feishu.chats': [chatEntry('oc_a', { repo: 'router-agent', branch: 'custom' })],
    })
    expect(result.errors).toEqual([])
    expect(cfg.feishu.chats[0]?.branch).toBe('main')
  })

  it('切换运行时后群绑定分支重新跟随新运行时项目', () => {
    const cfg = defaultConfig()
    cfg.projects = [{ name: 'trove', repo: 'trove', defaultBranch: 'main' }]
    cfg.runtime = {
      default: 'orca',
      projects: { 'claude-code': [{ name: 'trove', repo: '/Users/me/trove', defaultBranch: 'dev' }] },
    }
    cfg.feishu.chats = [chatEntry('oc_a', { repo: 'trove', branch: 'main' })]
    const result = applyConfigPatch(cfg, { 'runtime.default': 'claude-code' })
    expect(result.errors).toEqual([])
    expect(cfg.feishu.chats[0]?.branch).toBe('dev')
  })

  it('CLI chatBinding 绑定项目时忽略自定义分支', () => {
    const cfg = defaultConfig()
    cfg.projects = [{ name: 'router-agent', repo: 'name:dsh/router-agent', defaultBranch: 'main' }]
    expect(setConfigValue(cfg, 'chatBinding.oc_a', 'router-agent@release')).toBe(true)
    expect(cfg.feishu.chats.find(chat => chat.chat === 'oc_a')?.branch).toBe('main')
  })
})

describe('配置链路日志', () => {
  function recorder() {
    const logs: { level: string; message: string; extra?: Record<string, unknown> }[] = []
    const logger = {
      info: (message: string, extra?: Record<string, unknown>) => logs.push({ level: 'info', message, ...(extra ? { extra } : {}) }),
      warn: (message: string, extra?: Record<string, unknown>) => logs.push({ level: 'warn', message, ...(extra ? { extra } : {}) }),
      error: (message: string, extra?: Record<string, unknown>) => logs.push({ level: 'error', message, ...(extra ? { extra } : {}) }),
    }
    return { logs, logger }
  }

  it('首次启动生成默认 config.yaml 时留一条 config:created', () => {
    const { logs, logger } = recorder()
    const dir = home()
    loadConfig(dir, process.env, { logger })
    expect(logs).toContainEqual({ level: 'info', message: 'config:created', extra: { path: join(dir, 'config.yaml') } })
  })

  it('YAML 解析失败降级默认值，并记下 config:parse-failed', () => {
    const dir = home()
    writeFileSync(join(dir, 'config.yaml'), 'policy: [unclosed')
    const { logs, logger } = recorder()
    const cfg = loadConfig(dir, process.env, { logger })
    expect(cfg.policy.acceptMode).toBe('auto')
    const entry = logs.find(log => log.message === 'config:parse-failed')
    expect(entry?.level).toBe('warn')
    expect(String(entry?.extra?.message ?? '')).not.toBe('')
  })

  it('旧版 backend 段迁移到 runtime 时留一条 config:legacy-backend', () => {
    const dir = home()
    writeFileSync(join(dir, 'config.yaml'), ['backend:', '  default: claude-cli'].join('\n'))
    const { logs, logger } = recorder()
    expect(loadConfig(dir, process.env, { logger }).runtime.default).toBe('claude-code')
    expect(logs.some(log => log.message === 'config:legacy-backend')).toBe(true)
  })

  it('runtime.options 试图覆盖安全参数时先记 error 再抛错', () => {
    const dir = home()
    writeFileSync(join(dir, 'config.yaml'), [
      'runtime:',
      '  options:',
      '    orca:',
      '      allowNetwork: true',
    ].join('\n'))
    const { logs, logger } = recorder()
    expect(() => loadConfig(dir, process.env, { logger })).toThrow(/不允许覆盖安全参数/)
    const entry = logs.find(log => log.message === 'config:invalid-security-override')
    expect(entry?.level).toBe('error')
    expect(entry?.extra?.keys).toEqual(['allowNetwork'])
  })
})

describe('关单后的工作区回收配置', () => {
  it('默认保留 24 小时、每 30 分钟扫描一次', () => {
    const cfg = loadConfig(home())
    expect(cfg.workspace).toMatchObject({ enabled: true, keepHours: 24, sweepMinutes: 30 })
  })

  it('YAML 覆盖 workspace 段后能读回', () => {
    const dir = home()
    ensureHome(dir)
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(join(dir, 'config.yaml'), [
      'workspace:',
      '  enabled: false',
      '  keepHours: 6',
      '  sweepMinutes: 10',
    ].join('\n'))
    const cfg = loadConfig(dir)
    expect(cfg.workspace.enabled).toBe(false)
    expect(cfg.workspace.keepHours).toBe(6)
    expect(cfg.workspace.sweepMinutes).toBe(10)
  })

  it('setConfigValue 支持 workspace.* 点路径，非法值被拒绝', () => {
    const cfg = loadConfig(home())
    expect(setConfigValue(cfg, 'workspace.enabled', 'false')).toBe(true)
    expect(cfg.workspace.enabled).toBe(false)
    expect(setConfigValue(cfg, 'workspace.enabled', 'yes')).toBe(false)
    expect(setConfigValue(cfg, 'workspace.keepHours', '12')).toBe(true)
    expect(cfg.workspace.keepHours).toBe(12)
    // 0 合法：关单后下个扫描周期就回收
    expect(setConfigValue(cfg, 'workspace.keepHours', '0')).toBe(true)
    expect(cfg.workspace.keepHours).toBe(0)
    expect(setConfigValue(cfg, 'workspace.keepHours', '-1')).toBe(false)
    expect(setConfigValue(cfg, 'workspace.sweepMinutes', '15')).toBe(true)
    expect(cfg.workspace.sweepMinutes).toBe(15)
    expect(setConfigValue(cfg, 'workspace.sweepMinutes', '0')).toBe(false)
  })

  it('decision 默认关闭，Jev 密钥优先读环境变量', () => {
    const cfg = loadConfig(home(), { TYPESAFE_API_KEY: 'env-key', TYPESAFE_MODEL: 'jev-latest' })
    expect(cfg.decision.enabled).toBe(false)
    expect(cfg.decision.provider).toBe('jev')
    expect(cfg.decision.jev).toEqual({ apiKey: 'env-key', model: 'jev-latest' })
  })

  it('decision YAML 可开启并配置 Jev，环境变量覆盖密钥', () => {
    const dir = home()
    ensureHome(dir)
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(join(dir, 'config.yaml'), [
      'decision:',
      '  enabled: true',
      '  provider: jev',
      '  jev:',
      '    apiKey: yaml-key',
      '    model: jev-latest',
      '    baseUrl: https://proxy.example/j',
    ].join('\n'))
    const cfg = loadConfig(dir, { TYPESAFE_API_KEY: 'env-key' })
    expect(cfg.decision.enabled).toBe(true)
    expect(cfg.decision.provider).toBe('jev')
    expect(cfg.decision.jev).toEqual({ apiKey: 'env-key', model: 'jev-latest', baseUrl: 'https://proxy.example/j' })
  })

  it('decision provider 只认 jev / llm 两种取值', () => {
    const dir = home()
    ensureHome(dir)
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(join(dir, 'config.yaml'), ['decision:', '  enabled: true', '  provider: other'].join('\n'))
    expect(loadConfig(dir).decision.provider).toBe('jev')
  })

  it('publicConfig 遮蔽 decision.jev 明文密钥', () => {
    const cfg = defaultConfig()
    cfg.decision = { enabled: true, provider: 'jev', jev: { apiKey: 'jev-secret', model: 'jev-latest' } }
    const published = publicConfig(cfg) as { decision: { jev: Record<string, unknown> } }
    expect(published.decision.jev).toEqual({ model: 'jev-latest', apiKeySet: true })
    expect(JSON.stringify(published)).not.toContain('jev-secret')
  })
})

describe('事件总线的 config set 白名单', () => {
  it('setConfigValue 可改事件开关、预算、队列深度与审核人', () => {
    const cfg = loadConfig(home())
    expect(setConfigValue(cfg, 'event.enabled', 'true')).toBe(true)
    expect(cfg.event.enabled).toBe(true)
    expect(setConfigValue(cfg, 'event.enabled', 'yes')).toBe(false)
    expect(setConfigValue(cfg, 'event.budget.dailyTokens', '50000')).toBe(true)
    expect(cfg.event.budget.dailyTokens).toBe(50_000)
    expect(setConfigValue(cfg, 'event.budget.dailyTokens', '-1')).toBe(false)
    expect(setConfigValue(cfg, 'event.budget.dailyEvents', '0')).toBe(true)
    expect(cfg.event.budget.dailyEvents).toBe(0)
    expect(setConfigValue(cfg, 'event.maxQueueDepth', '100')).toBe(true)
    expect(cfg.event.maxQueueDepth).toBe(100)
    expect(setConfigValue(cfg, 'event.approvers', 'ou_a, ou_b')).toBe(true)
    expect(cfg.event.approvers).toEqual(['ou_a', 'ou_b'])
    expect(setConfigValue(cfg, 'event.notifyChat', 'oc_ops')).toBe(true)
    expect(cfg.event.notifyChat).toBe('oc_ops')
  })

  it('setConfigValue 用 JSON 改时间窗与来源，非法 JSON 与非法条目被拒绝', () => {
    const cfg = loadConfig(home())
    const windows = JSON.stringify([{ id: 'night', from: '22:00', to: '06:00', allow: ['t0', 't1'] }])
    expect(setConfigValue(cfg, 'event.windows', windows)).toBe(true)
    expect(cfg.event.windows).toEqual([{ id: 'night', from: '22:00', to: '06:00', allow: ['t0', 't1'] }])
    expect(setConfigValue(cfg, 'event.windows', 'not-json')).toBe(false)
    expect(setConfigValue(cfg, 'event.windows', JSON.stringify([{ id: 'bad', from: '25:00', to: '06:00', allow: ['t0'] }]))).toBe(false)
    const sources = JSON.stringify([{ id: 'gh', type: 'github', mode: 'poll', repos: ['a/b'], labels: [], state: 'open', intervalMs: 600000, cron: '', path: '', secretRef: '', notifyChat: '', project: '', priorityHint: 50, costClass: 'cheap', lane: '' }])
    expect(setConfigValue(cfg, 'event.sources', sources)).toBe(true)
    expect(cfg.event.sources[0]?.id).toBe('gh')
    expect(setConfigValue(cfg, 'event.sources', '[]')).toBe(true)
    expect(cfg.event.sources).toEqual([])
  })
})
