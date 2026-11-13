import { beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { AgentLoop } from '../../src/router/agent-loop.js'
import { type Policy } from '#core/policy.js'
import type { Trigger } from '#core/model.js'
import type { DecisionAgent } from '../../src/router/decision/agent.js'
import type { IntakeEngine, IntakeRunRequest } from '../../src/router/intake-engine.js'
import type { DispatchSettings } from '../../src/router/dispatch.js'
import type { MemberSettingsView } from '../../src/router/intake-flow.js'
import { chatEntry } from '../../src/config.js'

/** 按顺序返回预设 JSON 的假识别引擎，并记录每轮请求。 */
class FakeIntake implements IntakeEngine {
  requests: IntakeRunRequest[] = []
  constructor(private replies: unknown[]) {}
  async run(req: IntakeRunRequest): Promise<string> {
    this.requests.push(req)
    const next = this.replies.shift()
    return typeof next === 'string' ? next : JSON.stringify(next ?? { kind: 'chat', reason: 'no more replies' })
  }
}

const policy: Policy = {
  version: 'p1',
  acceptMode: 'auto',
  maxWorkers: 4,
  allowed: ['ou_alice'],
  bots: [],
}

const dispatch: DispatchSettings = {
  projects: [{ name: 'router-agent', repo: 'name:dsh/router-agent', defaultBranch: 'main' }],
  bindings: [chatEntry('oc_dev', { scope: 'all', repo: 'router-agent', branch: 'main' })],
}

function trigger(over: Partial<Trigger> = {}): Trigger {
  return {
    id: 't1',
    source: 'feishu',
    externalId: 'om_1',
    threadId: 'feishu:oc_dev:om_1',
    threadKeys: ['om_1'],
    chatId: 'oc_dev',
    chatName: '研发群',
    actorId: 'ou_bob',
    actorName: 'Bob',
    isBot: false,
    text: '登录页面一直报 500',
    addressed: 'none',
    receivedAt: '2026-11-12T10:00:00.000Z',
    disposition: 'pending',
    ...over,
  }
}

function setup(
  llm: IntakeEngine,
  over: {
    maxQuestions?: number
    approvers?: string[]
    policy?: Partial<Policy>
    codeAccess?: boolean
    resolveProjectPath?: (project: { name: string; repo: string }) => Promise<string | undefined>
  } = {},
) {
  const store = new Store(':memory:')
  const clock = { now: () => now }
  let n = 0
  const engine = new Engine({ store, policy: { ...policy, ...over.policy }, clock, ids: { next: p => `${p}_${++n}` } })
  const loop = new AgentLoop({
    engine,
    decisionEngine: {
      async assess() { throw new Error('intake 不应进入研判') },
      async reply() { throw new Error('intake 不应进入回复通道') },
    },
    clock,
    batchWindowMs: 0,
    source: 'feishu',
    dispatch,
    replyAlwaysChats: ['oc_dev'],
    intake: {
      llm,
      settings: intakeSettings(over),
      ...(over.resolveProjectPath ? { resolveProjectPath: over.resolveProjectPath } : {}),
    },
  })
  return { store, engine, loop, advance: (at: string) => { now = at } }
}

/** 群级普通成员消息配置：默认只有 oc_dev 开启，其它群关闭。 */
function intakeSettings(over: {
  maxQuestions?: number
  approvers?: string[]
  enabledChats?: string[]
  approversByChat?: Record<string, string[]>
  codeAccess?: boolean
} = {}): MemberSettingsView {
  const enabledChats = new Set(over.enabledChats ?? ['oc_dev'])
  return {
    forChat: (chatId: string) => ({
      enabled: enabledChats.has(chatId),
      maxQuestions: over.maxQuestions ?? 2,
      codeAccess: over.codeAccess ?? false,
      approvers: over.approversByChat?.[chatId] ?? over.approvers ?? ['ou_admin'],
    }),
  }
}

const QUESTIONS = { kind: 'issue', reason: '页面报错' }
let now = '2026-11-12T10:00:10.000Z'

beforeEach(() => {
  now = '2026-11-12T10:00:10.000Z'
})

describe('需求识别（intake）', () => {
  it('闲聊直接忽略，不建会话、不追问', async () => {
    const llm = new FakeIntake([{ kind: 'chat', reason: '寒暄' }])
    const { engine, loop, store } = setup(llm)
    engine.ingest(trigger({ text: '大家好呀' }))

    const result = await loop.tick()
    expect(result.ignored).toBe(1)
    expect(store.latestIntakeByThread('feishu:oc_dev:om_1')).toBeNull()
    expect(store.listOutbox()).toHaveLength(0)
  })

  it('疑似问题进入澄清：主动追问并把追问挂到话题', async () => {
    const llm = new FakeIntake([QUESTIONS, { action: 'reply', reply: '麻烦补充一下报错原文和设备信息' }])
    const { engine, loop, store } = setup(llm)
    engine.ingest(trigger())

    await loop.tick()
    const intake = store.latestIntakeByThread('feishu:oc_dev:om_1')
    expect(intake?.status).toBe('clarifying')
    expect(intake?.kind).toBe('issue')
    expect(intake?.questions).toBe(1)
    expect(intake?.turns.map(turn => turn.role)).toEqual(['user', 'router'])
    expect(intake?.project).toBe('router-agent')

    const outbox = store.listOutbox()
    expect(outbox[0]?.text).toContain('报错原文')
    expect(outbox[0]?.threadId).toBe('om_1')
  })

  it('普通成员 @机器人 也进决策层：Router 研判不再被调用', async () => {
    const llm = new FakeIntake([{ action: 'answer', reply: '在设置里打开开关就行' }])
    const store = new Store(':memory:')
    const clock = { now: () => now }
    let n = 0
    const engine = new Engine({ store, policy, clock, ids: { next: p => `${p}_${++n}` } })
    let assessed = ''
    const decided: string[] = []
    const decisionAgent = {
      async decide(trigger: Trigger) {
        decided.push(trigger.id)
        return {
          kind: 'verdict' as const,
          verdict: {
            specId: 'msg.user.v2',
            specVersion: 2,
            msgType: 'consult' as const,
            needsFollowup: true,
            projectRelated: true,
            urgency: 0.5,
            confidence: 0.8,
            action: 'reply' as const,
            toolScope: 'member-analysis-read' as const,
            degraded: false,
          },
        }
      },
    } as unknown as DecisionAgent
    const loop = new AgentLoop({
      engine,
      decisionEngine: {
        async assess(req) {
          assessed = req.trigger.id
          return {
            proposal: { triggerId: req.trigger.id, decision: 'ignore', strength: req.strength, reason: '不该走到这里', rules: [] },
            audit: { engine: 'pi', triggerId: req.trigger.id, durationMs: 0, toolCalls: [], tokens: { input: 0, output: 0, total: 0 }, promptChars: { system: 0, user: 0 } },
          }
        },
        async reply() { return '' },
      },
      clock,
      batchWindowMs: 0,
      source: 'feishu',
      dispatch,
      replyAlwaysChats: ['oc_dev'],
      intake: { llm, settings: intakeSettings(), decisionAgent },
    })
    // Bob 不在授权名单里：他 @了机器人也要先过决策层。
    engine.ingest(trigger({ id: 't_member', actorId: 'ou_bob', actorName: 'Bob', addressed: 'mention', text: '这个开关在哪？' }))

    await loop.tick()

    expect(decided).toEqual(['t_member'])
    expect(assessed).toBe('')
    // 咨询类消息建咨询会话，不开单。
    expect(store.latestIntakeByThread('feishu:oc_dev:om_1')?.kind).toBe('question')
    expect(engine.store.listTickets()).toHaveLength(0)
  })

  it('普通成员的分析可以基于项目代码：群里开了只读代码才读', async () => {
    // 第一轮是初筛（不看代码），第二轮才是分析 Agent（可读项目代码）。
    const llm = new FakeIntake([QUESTIONS, { action: 'answer', reply: '是登录态过期' }])
    const { engine, loop } = setup(llm, {
      codeAccess: true,
      resolveProjectPath: async () => '/tmp/project',
    })
    engine.ingest(trigger())

    await loop.tick()
    expect(llm.requests[0]?.readCode).toBe(false)
    expect(llm.requests[1]?.readCode).toBe(true)
    expect(llm.requests[1]?.projectPath).toBe('/tmp/project')
  })

  it('群里没开只读代码时，分析只看对话不读项目文件', async () => {
    const llm = new FakeIntake([QUESTIONS, { action: 'answer', reply: '先看下报错信息' }])
    const { engine, loop } = setup(llm, {
      codeAccess: false,
      resolveProjectPath: async () => '/tmp/project',
    })
    engine.ingest(trigger())

    await loop.tick()
    expect(llm.requests[1]?.readCode).toBe(false)
    expect(llm.requests[1]?.projectPath).toBeUndefined()
  })
  it('发起人补充信息后收口：生成需求单并 @管理员终审', async () => {
    const llm = new FakeIntake([
      QUESTIONS,
      { action: 'reply', reply: '麻烦补充报错原文' },
      {
        action: 'report',
        reply: '信息整理好了',
        report: { title: '登录 500', problem: '点击登录返回 500', steps: '登录页点登录', impact: '全员' },
      },
    ])
    const { engine, loop, store, advance } = setup(llm)
    engine.ingest(trigger())
    await loop.tick()
    advance('2026-11-12T10:01:10.000Z')
    engine.ingest(trigger({
      id: 't2',
      externalId: 'om_2',
      threadId: 'feishu:oc_dev:om_1',
      text: '报错是 internal server error，Chrome 120',
      receivedAt: '2026-11-12T10:01:00.000Z',
    }))
    await loop.tick()

    const intake = store.latestIntakeByThread('feishu:oc_dev:om_1')
    expect(intake?.status).toBe('ready')
    expect(intake?.report?.title).toBe('登录 500')
    expect(engine.store.listTickets()).toHaveLength(0)

    const review = store.listOutbox().find(item => item.text.includes('<at id="ou_admin"></at>'))
    expect(review?.text).toContain('确认派单')
    expect(review?.text).toContain('登录 500')
  })

  it('管理员确认派单后走原有 Engine 开单，scope 来自需求单', async () => {
    const llm = new FakeIntake([
      QUESTIONS,
      {
        action: 'report',
        reply: '整理好了',
        report: { title: '登录 500', problem: '点击登录返回 500', background: '日常使用', steps: '登录页点登录' },
      },
    ])
    const { engine, loop, store, advance } = setup(llm)
    engine.ingest(trigger())
    await loop.tick()
    now = '2026-11-12T10:03:10.000Z'
    engine.ingest(trigger({
      id: 't_approve',
      externalId: 'om_approve',
      threadId: 'feishu:oc_dev:om_1',
      actorId: 'ou_admin',
      actorName: '管理员',
      text: '确认派单',
      addressed: 'none',
      receivedAt: '2026-11-12T10:02:00.000Z',
    }))
    await loop.tick()

    const tickets = engine.store.listTickets()
    expect(tickets).toHaveLength(1)
    expect(tickets[0]?.title).toBe('登录 500')
    expect(tickets[0]?.repo).toBe('name:dsh/router-agent')
    expect(tickets[0]?.branch).toBe('main')
    const mandate = engine.store.getMandate(tickets[0]!.mandateId)
    expect(mandate?.scope).toContain('问题描述：点击登录返回 500')
    // 工单归属提出人，而不是点「确认派单」的管理员。
    expect(mandate?.actorId).toBe('ou_bob')
    expect(mandate?.actorName).toBe('Bob')
    expect(store.latestIntakeByThread('feishu:oc_dev:om_1')?.status).toBe('approved')
  })

  it('非管理员回复「确认派单」无效：不会开单', async () => {
    const llm = new FakeIntake([
      QUESTIONS,
      { action: 'report', reply: '整理好了', report: { title: '登录 500', problem: '500' } },
    ])
    const { engine, loop, advance } = setup(llm)
    engine.ingest(trigger())
    await loop.tick()
    advance('2026-11-12T10:02:10.000Z')
    engine.ingest(trigger({
      id: 't_bob',
      externalId: 'om_bob',
      threadId: 'feishu:oc_dev:om_1',
      actorId: 'ou_bob',
      text: '确认派单',
      receivedAt: '2026-11-12T10:02:00.000Z',
    }))
    await loop.tick()
    expect(engine.store.listTickets()).toHaveLength(0)
  })

  it('管理员的需求分级不通过时先澄清再直接开单：不经终审', async () => {
    const llm = new FakeIntake([
      { action: 'reply', reply: '登录这块具体要改什么？超时时长还是失败重试？' },
      {
        action: 'report',
        reply: '整理好了',
        report: { title: '登录超时改 30 秒', problem: '登录超过 10 秒就失败', background: '日常使用' },
      },
    ])
    const store = new Store(':memory:')
    const clock = { now: () => now }
    let n = 0
    const engine = new Engine({ store, policy: { ...policy, allowed: ['ou_admin'] }, clock, ids: { next: p => `${p}_${++n}` } })
    const loop = new AgentLoop({
      engine,
      decisionEngine: {
        async assess(req) {
          return {
            proposal: { triggerId: req.trigger.id, decision: 'stop', strength: req.strength, reason: '需求不明确', rules: [], clarify: true },
            audit: { engine: 'pi', triggerId: req.trigger.id, durationMs: 0, toolCalls: [], tokens: { input: 0, output: 0, total: 0 }, promptChars: { system: 0, user: 0 } },
          }
        },
        async reply() { return '' },
      },
      clock,
      batchWindowMs: 0,
      source: 'feishu',
      dispatch,
      replyAlwaysChats: ['oc_dev'],
      intake: { llm, settings: intakeSettings() },
    })
    engine.ingest(trigger({
      id: 't_admin',
      externalId: 'om_admin',
      actorId: 'ou_admin',
      actorName: '管理员',
      text: '登录那块改一下',
      addressed: 'mention',
    }))
    await loop.tick()

    // 需求不明确：进澄清会话，还没开单。
    const intake = store.latestIntakeByThread('feishu:oc_dev:om_1')
    expect(intake?.kind).toBe('request')
    expect(intake?.status).toBe('clarifying')
    expect(engine.store.listTickets()).toHaveLength(0)

    // 讨论清楚后直接开单：发起人就是管理员，不需要再等终审。
    now = '2026-11-12T10:02:10.000Z'
    engine.ingest(trigger({
      id: 't_admin_2',
      externalId: 'om_admin_2',
      threadId: 'feishu:oc_dev:om_1',
      actorId: 'ou_admin',
      actorName: '管理员',
      text: '登录超过 10 秒就失败，改成 30 秒',
      addressed: 'mention',
      receivedAt: '2026-11-12T10:02:00.000Z',
    }))
    await loop.tick()

    const tickets = engine.store.listTickets()
    expect(tickets).toHaveLength(1)
    expect(tickets[0]?.title).toBe('登录超时改 30 秒')
    expect(store.latestIntakeByThread('feishu:oc_dev:om_1')?.status).toBe('approved')
  })

  it('管理员驳回后需求单结束，不派单', async () => {
    const llm = new FakeIntake([
      QUESTIONS,
      { action: 'report', reply: '整理好了', report: { title: '登录 500', problem: '500' } },
    ])
    const { engine, loop, store, advance } = setup(llm)
    engine.ingest(trigger())
    await loop.tick()
    advance('2026-11-12T10:02:10.000Z')
    engine.ingest(trigger({
      id: 't_reject',
      externalId: 'om_reject',
      threadId: 'feishu:oc_dev:om_1',
      actorId: 'ou_admin',
      text: '驳回',
      receivedAt: '2026-11-12T10:02:00.000Z',
    }))
    await loop.tick()
    expect(engine.store.listTickets()).toHaveLength(0)
    expect(store.latestIntakeByThread('feishu:oc_dev:om_1')?.status).toBe('rejected')
  })

  it('群级名单外的人只是普通成员：消息进决策层，但开不出工单', async () => {
    const llm = new FakeIntake([QUESTIONS])
    const store = new Store(':memory:')
    const clock = { now: () => '2026-11-12T10:00:10.000Z' }
    let n = 0
    const engine = new Engine({
      store,
      policy: { ...policy, allowedByChat: { oc_dev: ['ou_alice'] }, allowedByChatOpenIds: { oc_dev: ['ou_alice'] } },
      clock,
      ids: { next: p => `${p}_${++n}` },
    })
    const loop = new AgentLoop({
      engine,
      decisionEngine: { async assess() { throw new Error('不应研判') }, async reply() { throw new Error('不应回复') } },
      clock,
      batchWindowMs: 0,
      source: 'feishu',
      dispatch,
      replyAlwaysChats: ['oc_dev'],
      intake: {
        llm,
        settings: intakeSettings(),
      },
    })
    engine.ingest(trigger({ actorId: 'ou_mallory', actorName: 'Mallory' }))
    await loop.tick()
    // 名单只决定谁能当管理员，普通成员照样能提需求。
    expect(llm.requests.length).toBeGreaterThan(0)
    expect(store.latestIntakeByThread('feishu:oc_dev:om_1')?.kind).toBe('issue')
    // 但他开不出工单：工单只由管理员终审产生。
    expect(engine.store.listTickets()).toHaveLength(0)
  })

  it('「仅接受管理员消息」的群不接管普通成员：普通成员的消息直接忽略，不进研判', async () => {
    const llm = new FakeIntake([QUESTIONS])
    const store = new Store(':memory:')
    const clock = { now: () => now }
    let n = 0
    const engine = new Engine({ store, policy: { ...policy, scopeByChat: { oc_dev: 'admins' } }, clock, ids: { next: p => `${p}_${++n}` } })
    const loop = new AgentLoop({
      engine,
      decisionEngine: { async assess() { throw new Error('不应研判') }, async reply() { throw new Error('不应回复') } },
      clock,
      batchWindowMs: 0,
      source: 'feishu',
      dispatch,
      replyAlwaysChats: ['oc_dev'],
      // 消息范围按群配置：oc_dev 只接受管理员消息，普通成员不接管。
      intake: { llm, settings: intakeSettings({ enabledChats: ['oc_ops'] }) },
    })
    engine.ingest(trigger())
    await loop.tick()
    expect(llm.requests).toHaveLength(0)
    expect(store.latestIntakeByThread('feishu:oc_dev:om_1')).toBeNull()
  })

  it('终审管理员按群取：别的群的管理员在本群不能拍板', async () => {
    const llm = new FakeIntake([
      QUESTIONS,
      { action: 'report', reply: '整理好了', report: { title: '登录 500', problem: '500' } },
    ])
    const store = new Store(':memory:')
    const clock = { now: () => now }
    let n = 0
    const engine = new Engine({ store, policy, clock, ids: { next: p => `${p}_${++n}` } })
    const loop = new AgentLoop({
      engine,
      decisionEngine: { async assess() { throw new Error('不应研判') }, async reply() { throw new Error('不应回复') } },
      clock,
      batchWindowMs: 0,
      source: 'feishu',
      dispatch: {
        projects: [{ name: 'router-agent', repo: 'name:dsh/router-agent', defaultBranch: 'main' }],
        bindings: [
          chatEntry('oc_dev', { scope: 'all', repo: 'router-agent', branch: 'main' }),
          chatEntry('oc_ops', { scope: 'all', repo: 'router-agent', branch: 'main' }),
        ],
      },
      replyAlwaysChats: ['oc_dev', 'oc_ops'],
      intake: {
        llm,
        settings: intakeSettings({
          enabledChats: ['oc_dev', 'oc_ops'],
          approversByChat: { oc_dev: ['ou_admin'], oc_ops: ['ou_lead'] },
        }),
      },
    })
    engine.ingest(trigger({ chatId: 'oc_ops', threadId: 'feishu:oc_ops:om_1' }))
    await loop.tick()
    now = '2026-11-12T10:02:10.000Z'
    // oc_dev 的管理员在 oc_ops 里不是管理员：不能拍板。
    engine.ingest(trigger({
      id: 't_approve',
      externalId: 'om_approve',
      chatId: 'oc_ops',
      threadId: 'feishu:oc_ops:om_1',
      actorId: 'ou_admin',
      text: '确认派单',
      receivedAt: '2026-11-12T10:02:00.000Z',
    }))
    await loop.tick()
    expect(engine.store.listTickets()).toHaveLength(0)

    // 本群的管理员可以拍板。
    now = '2026-11-12T10:03:10.000Z'
    engine.ingest(trigger({
      id: 't_approve_lead',
      externalId: 'om_approve_lead',
      chatId: 'oc_ops',
      threadId: 'feishu:oc_ops:om_1',
      actorId: 'ou_lead',
      text: '确认派单',
      receivedAt: '2026-11-12T10:03:00.000Z',
    }))
    await loop.tick()
    expect(engine.store.listTickets()).toHaveLength(1)
    expect(store.latestIntakeByThread('feishu:oc_ops:om_1')?.status).toBe('approved')
  })

  it('管理员 @机器人 时不被待审需求单截走，走原研判', async () => {
    const llm = new FakeIntake([
      QUESTIONS,
      { action: 'report', reply: '整理好了', report: { title: '登录 500', problem: '500' } },
    ])
    const store = new Store(':memory:')
    const clock = { now: () => now }
    let n = 0
    const engine = new Engine({ store, policy, clock, ids: { next: p => `${p}_${++n}` } })
    let assessed = ''
    const loop = new AgentLoop({
      engine,
      decisionEngine: {
        async assess(req) {
          assessed = req.trigger.id
          return {
            proposal: { triggerId: req.trigger.id, decision: 'ignore', strength: req.strength, reason: '新指令', rules: [] },
            audit: { engine: 'pi', triggerId: req.trigger.id, durationMs: 0, toolCalls: [], tokens: { input: 0, output: 0, total: 0 }, promptChars: { system: 0, user: 0 } },
          }
        },
        async reply() { return '' },
      },
      clock,
      batchWindowMs: 0,
      source: 'feishu',
      dispatch,
      replyAlwaysChats: ['oc_dev'],
      intake: { llm, settings: intakeSettings() },
    })
    engine.ingest(trigger())
    await loop.tick()
    now = '2026-11-12T10:02:10.000Z'
    engine.ingest(trigger({
      id: 't_admin_mention',
      externalId: 'om_admin_mention',
      threadId: 'feishu:oc_dev:om_1',
      actorId: 'ou_alice',
      actorName: 'Alice',
      text: '把登录超时改到 30 秒',
      addressed: 'mention',
      receivedAt: '2026-11-12T10:02:10.000Z',
    }))
    await loop.tick()
    expect(assessed).toBe('t_admin_mention')
    expect(engine.store.listTickets()).toHaveLength(0)
  })

  it('群没有绑定项目时不接管：继续走原有忽略路径', async () => {
    const llm = new FakeIntake([QUESTIONS])
    const store = new Store(':memory:')
    const clock = { now: () => '2026-11-12T10:00:10.000Z' }
    let n = 0
    const engine = new Engine({ store, policy, clock, ids: { next: p => `${p}_${++n}` } })
    const loop = new AgentLoop({
      engine,
      decisionEngine: { async assess() { throw new Error('不应研判') }, async reply() { throw new Error('不应回复') } },
      clock,
      batchWindowMs: 0,
      source: 'feishu',
      dispatch: { projects: [], bindings: [] },
      replyAlwaysChats: ['oc_dev'],
      intake: {
        llm,
        settings: intakeSettings(),
      },
    })
    engine.ingest(trigger())
    await loop.tick()
    expect(llm.requests).toHaveLength(0)
  })

  it('追问到上限仍无结构化结果时用现有信息收口', async () => {
    const llm = new FakeIntake([
      QUESTIONS,
      { action: 'reply', reply: '补充一下复现步骤' },
      { action: 'reply', reply: '再补充一下设备' },
    ])
    const { engine, loop, store, advance } = setup(llm, { maxQuestions: 2 })
    engine.ingest(trigger())
    await loop.tick()
    advance('2026-11-12T10:01:10.000Z')
    engine.ingest(trigger({
      id: 't2',
      externalId: 'om_2',
      threadId: 'feishu:oc_dev:om_1',
      text: 'Chrome 上点登录就 500',
      receivedAt: '2026-11-12T10:01:00.000Z',
    }))
    await loop.tick()
    const intake = store.latestIntakeByThread('feishu:oc_dev:om_1')
    expect(intake?.status).toBe('ready')
    expect(intake?.report?.problem).toBe('登录页面一直报 500')
  })

  it('追问额度为 0 时不追问，直接按现有信息收口', async () => {
    const llm = new FakeIntake([
      QUESTIONS,
      { action: 'reply', reply: '麻烦补充一下报错原文' },
    ])
    const { engine, loop, store } = setup(llm, { maxQuestions: 0 })
    engine.ingest(trigger())

    const result = await loop.tick()
    const intake = store.latestIntakeByThread('feishu:oc_dev:om_1')
    expect(intake?.status).toBe('ready')
    expect(intake?.questions).toBe(0)
    expect(intake?.report?.problem).toBe('登录页面一直报 500')
    // 没有追问消息，直接进入待审。
    expect(store.listOutbox().some(item => item.text.includes('补充一下报错原文'))).toBe(false)
    expect(result.ignored).toBe(1)
    expect(store.getTrigger('t1')?.disposition).toBe('evaluated')
  })

  it('模型直接给结论时结束会话，不产出需求单也不打扰管理员', async () => {
    const llm = new FakeIntake([
      QUESTIONS,
      { action: 'reply', reply: '麻烦补充一下报错原文' },
      { action: 'answer', reply: '重启一下服务就好了' },
    ])
    const { engine, loop, store, advance } = setup(llm)
    engine.ingest(trigger())
    await loop.tick()
    advance('2026-11-12T10:01:10.000Z')
    engine.ingest(trigger({
      id: 't2',
      externalId: 'om_2',
      threadId: 'feishu:oc_dev:om_1',
      text: '重启一下服务就好了',
      receivedAt: '2026-11-12T10:01:00.000Z',
    }))
    await loop.tick()

    const intake = store.latestIntakeByThread('feishu:oc_dev:om_1')
    expect(intake?.status).toBe('answered')
    expect(intake?.report).toBeUndefined()
    expect(engine.store.listTickets()).toHaveLength(0)
    expect(store.listOutbox().some(item => item.text.includes('<at id="ou_admin"></at>'))).toBe(false)
  })

  it('发起人补充信息时旧报告作废，需求单回到澄清中', async () => {
    const llm = new FakeIntake([
      QUESTIONS,
      { action: 'report', reply: '整理好了', report: { title: '登录 500', problem: '点击登录返回 500' } },
      { action: 'reply', reply: '还要补充一下设备信息' },
    ])
    const { engine, loop, store, advance } = setup(llm)
    engine.ingest(trigger())
    await loop.tick()
    expect(store.latestIntakeByThread('feishu:oc_dev:om_1')?.status).toBe('ready')

    advance('2026-11-12T10:01:10.000Z')
    engine.ingest(trigger({
      id: 't2',
      externalId: 'om_2',
      threadId: 'feishu:oc_dev:om_1',
      text: '只有 Safari 会这样',
      receivedAt: '2026-11-12T10:01:00.000Z',
    }))
    await loop.tick()

    const intake = store.latestIntakeByThread('feishu:oc_dev:om_1')
    expect(intake?.status).toBe('clarifying')
    // 上一版的结论不能还挂着让管理员去终审。
    expect(intake?.report).toBeUndefined()
  })

  it('普通成员能提需求，但不能自己拍板：不在终审名单里确认不开单', async () => {
    const llm = new FakeIntake([
      QUESTIONS,
      { action: 'report', reply: '整理好了', report: { title: '登录 500', problem: '500' } },
    ])
    const { engine, loop, store, advance } = setup(llm, {
      approvers: ['ou_alice'],
      policy: {
        allowedByChat: { oc_dev: ['ou_alice'] },
        allowedByChatOpenIds: { oc_dev: ['ou_alice'] },
      },
    })
    // Bob 不在群名单里：普通成员，消息进决策层并建了需求会话。
    engine.ingest(trigger({ actorId: 'ou_bob', actorName: 'Bob' }))
    await loop.tick()
    expect(store.latestIntakeByThread('feishu:oc_dev:om_1')?.kind).toBe('issue')

    advance('2026-11-12T10:01:10.000Z')
    engine.ingest(trigger({
      id: 't2',
      externalId: 'om_2',
      threadId: 'feishu:oc_dev:om_1',
      actorId: 'ou_bob',
      actorName: 'Bob',
      text: '确认派单',
      receivedAt: '2026-11-12T10:01:00.000Z',
    }))
    await loop.tick()

    // Bob 不在终审名单里：不能自己拍板，不会开单。
    expect(engine.store.listTickets()).toHaveLength(0)
  })

  it('群里配的终审管理员可以拍板，不要求同时在管理员名单里', async () => {
    const llm = new FakeIntake([
      QUESTIONS,
      { action: 'report', reply: '整理好了', report: { title: '登录 500', problem: '500' } },
    ])
    const { engine, loop, store, advance } = setup(llm, {
      approvers: ['ou_admin'],
      policy: {
        allowedByChat: { oc_dev: ['ou_alice'] },
        allowedByChatOpenIds: { oc_dev: ['ou_alice'] },
      },
    })
    engine.ingest(trigger())
    await loop.tick()
    advance('2026-11-12T10:02:10.000Z')
    engine.ingest(trigger({
      id: 't_approve',
      externalId: 'om_approve',
      threadId: 'feishu:oc_dev:om_1',
      actorId: 'ou_admin',
      actorName: '管理员',
      text: '确认派单',
      receivedAt: '2026-11-12T10:02:00.000Z',
    }))
    await loop.tick()
    expect(engine.store.listTickets()).toHaveLength(1)
  })

  it('终审重试不重复建单：复用已存在的工单', async () => {
    const llm = new FakeIntake([
      QUESTIONS,
      { action: 'report', reply: '整理好了', report: { title: '登录 500', problem: '500' } },
    ])
    const { engine, loop, store, advance } = setup(llm)
    engine.ingest(trigger())
    await loop.tick()
    advance('2026-11-12T10:02:10.000Z')
    engine.ingest(trigger({
      id: 't_approve',
      externalId: 'om_approve',
      threadId: 'feishu:oc_dev:om_1',
      actorId: 'ou_admin',
      actorName: '管理员',
      text: '确认派单',
      receivedAt: '2026-11-12T10:02:00.000Z',
    }))
    await loop.tick()
    expect(engine.store.listTickets()).toHaveLength(1)

    // 模拟「工单已建、需求单还没回写就中断」：再拍一次板不能建出第二张。
    const intake = store.latestIntakeByThread('feishu:oc_dev:om_1')!
    intake.status = 'ready'
    store.updateIntake(intake)
    // 工单已结束，消息不再被扇给 worker，才会回到终审分支。
    engine.closeTicket('tk-1', 'done')
    advance('2026-11-12T10:04:10.000Z')
    engine.ingest(trigger({
      id: 't_approve_retry',
      externalId: 'om_approve_retry',
      threadId: 'feishu:oc_dev:om_1',
      actorId: 'ou_admin',
      actorName: '管理员',
      text: '确认派单',
      receivedAt: '2026-11-12T10:04:00.000Z',
    }))
    await loop.tick()

    expect(engine.store.listTickets()).toHaveLength(1)
    const after = store.latestIntakeByThread('feishu:oc_dev:om_1')
    expect(after?.status).toBe('approved')
    expect(after?.ticketId).toBe('tk-1')
  })

  it('超过 72 小时的待审需求单不再接受终审', async () => {
    const llm = new FakeIntake([
      QUESTIONS,
      { action: 'report', reply: '整理好了', report: { title: '登录 500', problem: '500' } },
    ])
    const { engine, loop, store, advance } = setup(llm)
    engine.ingest(trigger())
    await loop.tick()
    expect(store.latestIntakeByThread('feishu:oc_dev:om_1')?.status).toBe('ready')

    // 需求单挂了三天没人处理，管理员再来拍板。
    advance('2026-11-15T10:02:10.000Z')
    engine.ingest(trigger({
      id: 't_approve',
      externalId: 'om_approve',
      threadId: 'feishu:oc_dev:om_1',
      actorId: 'ou_admin',
      actorName: '管理员',
      text: '确认派单',
      receivedAt: '2026-11-15T10:02:00.000Z',
    }))
    await loop.tick()
    expect(engine.store.listTickets()).toHaveLength(0)
    expect(store.latestIntakeByThread('feishu:oc_dev:om_1')?.status).toBe('dismissed')
  })
})
