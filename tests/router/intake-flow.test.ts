import { beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { AgentLoop } from '../../src/router/agent-loop.js'
import { DEFAULT_ADMISSION, type Policy } from '../../src/core/policy.js'
import type { Trigger } from '../../src/core/model.js'
import type { IntakeEngine, IntakeRunRequest } from '../../src/router/intake-engine.js'
import type { DispatchSettings } from '../../src/router/dispatch.js'
import type { IntakeSettingsView } from '../../src/router/intake-flow.js'
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
  admission: DEFAULT_ADMISSION,
  receiveAll: true,
}

const dispatch: DispatchSettings = {
  projects: [{ name: 'router-agent', repo: 'name:dsh/router-agent', defaultBranch: 'main' }],
  bindings: [chatEntry('oc_dev', { mode: 'all', repo: 'router-agent', branch: 'main' })],
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

function setup(llm: IntakeEngine, over: { maxQuestions?: number; approvers?: string[] } = {}) {
  const store = new Store(':memory:')
  const clock = { now: () => now }
  let n = 0
  const engine = new Engine({ store, policy, clock, ids: { next: p => `${p}_${++n}` } })
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
    },
  })
  return { store, engine, loop, advance: (at: string) => { now = at } }
}

/** 群级需求分析配置：默认只有 oc_dev 开启，其它群关闭。 */
function intakeSettings(over: {
  maxQuestions?: number
  approvers?: string[]
  enabledChats?: string[]
  approversByChat?: Record<string, string[]>
} = {}): IntakeSettingsView {
  const enabledChats = new Set(over.enabledChats ?? ['oc_dev'])
  return {
    forChat: (chatId: string) => ({
      enabled: enabledChats.has(chatId),
      maxQuestions: over.maxQuestions ?? 2,
      codeAccess: false,
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

  it('群级白名单拦截的消息不会被 intake 绕过', async () => {
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
    expect(llm.requests).toHaveLength(0)
    expect(store.latestIntakeByThread('feishu:oc_dev:om_1')).toBeNull()
  })

  it('没开启需求分析助手的群不接管：走原有研判路径', async () => {
    const llm = new FakeIntake([QUESTIONS])
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
      dispatch,
      replyAlwaysChats: ['oc_dev'],
      // 需求分析助手只在 oc_ops 开启：oc_dev 不受影响。
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
          chatEntry('oc_dev', { mode: 'all', repo: 'router-agent', branch: 'main' }),
          chatEntry('oc_ops', { mode: 'all', repo: 'router-agent', branch: 'main' }),
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
      actorId: 'ou_admin',
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
})
