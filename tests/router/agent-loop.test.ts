import { describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { AgentLoop, clarifyFallback, isSmallTalk } from '../../src/router/agent-loop.js'
import type { LlmClient, LlmResponse } from '../../src/router/llm.js'
import type { Trigger } from '../../src/core/model.js'
import { DEFAULT_ADMISSION, type Policy } from '../../src/core/policy.js'
import { ROUTER_TOOLS, normalizeMessageId } from '../../src/router/tools.js'
import type { DispatchSettings } from '../../src/router/dispatch.js'

class FakeLlm implements LlmClient {
  requests: { messages: { role: string; content: string | null }[]; tools?: unknown }[] = []
  constructor(private responses: LlmResponse[]) {}
  async complete(req: { messages: { role: string; content: string | null }[]; tools?: unknown }): Promise<LlmResponse> {
    this.requests.push(req)
    return this.responses.shift() ?? { content: '{"decision":"ignore","reason":"no more responses","title":"","scope":""}', toolCalls: [] }
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

const ACCEPT = (title = '延长登录超时到 30 秒') => ({ content: JSON.stringify({ decision: 'accept', reason: '明确的可执行请求', title, scope: '只调整登录超时配置' }), toolCalls: [] })
const IGNORE = (reason = '闲聊') => ({ content: JSON.stringify({ decision: 'ignore', reason }), toolCalls: [] })
const SAY = (text: string) => ({ content: text, toolCalls: [] })

function trigger(over: Partial<Trigger> = {}): Trigger {
  return {
    id: 't1',
    source: 'feishu',
    externalId: 'om_1',
    threadId: 'feishu:oc_dev:om_1',
    chatId: 'oc_dev',
    chatName: '研发群',
    actorId: 'ou_alice',
    actorName: 'Alice',
    isBot: false,
    text: '登录总是 10 秒就超时，帮我改成 30 秒',
    addressed: 'mention',
    receivedAt: '2026-11-06T10:00:00.000Z',
    disposition: 'pending',
    ...over,
  }
}

function setup(responses: LlmResponse[] = [], dispatch?: DispatchSettings) {
  const store = new Store(':memory:')
  const clock = { now: () => '2026-11-06T10:00:10.000Z' }
  let n = 0
  const ids = { next: (p: string) => `${p}_${++n}` }
  const engine = new Engine({ store, policy, clock, ids })
  const llm = new FakeLlm(responses)
  const loop = new AgentLoop({ engine, llm, clock, batchWindowMs: 5000, source: 'feishu', maxToolRounds: 3, ...(dispatch ? { dispatch } : {}) })
  return { store, engine, llm, loop }
}

describe('Router 常驻 Agent Loop', () => {
  it('显式请求经 LLM 确认后接单，强度保持 explicit', async () => {
    const { engine, llm, loop } = setup([ACCEPT()])
    engine.ingest(trigger())

    const result = await loop.tick()
    expect(llm.requests).toHaveLength(1)
    expect(result.accepted).toHaveLength(1)
    expect(result.accepted[0]?.title).toBe('延长登录超时到 30 秒')
    const decision = engine.store.getDecision(engine.store.listTriggers()[0]!.decisionId!)
    expect(decision?.strength).toBe('explicit')
  })

  it('显式寒暄：用模型生成的礼貌回复，不开单，且是普通消息而非话题', async () => {
    const { engine, loop, store } = setup([SAY('你好呀，需要我帮你改点什么？')])
    engine.ingest(trigger({ text: '你好，在吗' }))

    const result = await loop.tick()
    expect(result.accepted).toHaveLength(0)
    expect(result.replied).toBe(1)
    expect(engine.store.listTickets()).toHaveLength(0)

    const outbox = store.claimOutbox('2026-11-06T10:00:20.000Z', 10)
    expect(outbox).toHaveLength(1)
    expect(outbox[0]?.text).toBe('你好呀，需要我帮你改点什么？')
    expect(outbox[0]?.threadId).toBe('')
  })

  it('纯附件消息不开单：不调模型，回一句请补充文字', async () => {
    const { engine, llm, loop, store } = setup([])
    engine.ingest(trigger({ id: 't_img', externalId: 'om_img', mediaOnly: true, text: '[图片]' }))

    const result = await loop.tick()
    expect(result.accepted).toHaveLength(0)
    expect(result.replied).toBe(1)
    expect(llm.requests).toHaveLength(0)
    expect(engine.store.listTickets()).toHaveLength(0)
    const outbox = store.claimOutbox('2026-11-06T10:00:20.000Z', 10)
    expect(outbox).toHaveLength(1)
    expect(outbox[0]?.text).toContain('文字')
  })

  it('群里的纯附件消息（未被 @）完全静默', async () => {
    const { engine, loop, store } = setup([])
    engine.ingest(trigger({ id: 't_img2', externalId: 'om_img2', mediaOnly: true, text: '[图片]', addressed: 'none' }))

    await loop.tick()
    expect(store.claimOutbox('2026-11-06T10:00:20.000Z', 10)).toHaveLength(0)
  })

  it('接单后发普通消息 ack，并用话题开场接 worker', async () => {    const { engine, loop, store } = setup([ACCEPT('改登录超时')])
    engine.ingest(trigger({ text: '把登录超时改成 30 秒' }))

    await loop.tick()
    const outbox = store.claimOutbox('2026-11-06T10:00:20.000Z', 10)
    const ack = outbox.find(item => item.key.startsWith('ack:'))!
    const thread = outbox.find(item => item.key.startsWith('thread:'))!
    expect(ack.text).toContain('我帮你创建了工单')
    expect(ack.threadId).toBe('')
    expect(ack.originMessageId).toBe('om_1')
    expect(thread.threadId).toBe('om_1')
    expect(thread.originMessageId).toBe('om_1')
    expect(thread.text).toContain('后续进展会在这个话题里更新')
  })

  it('推断候选通过工具调用接单，强度仍是 inferred', async () => {
    const { engine, llm, loop } = setup([{
      content: null,
      toolCalls: [{
        id: 'call_1',
        name: 'router_decide',
        arguments: JSON.stringify({ trigger_id: 't1', decision: 'accept', reason: '明确请求', title: '延长登录超时', scope: '只调配置', rules: ['bugfix'] }),
      }],
    }])
    engine.ingest(trigger({ addressed: 'none' }))

    const result = await loop.tick()
    expect(llm.requests).toHaveLength(1)
    expect(result.accepted[0]?.title).toBe('延长登录超时')
    const decision = engine.store.getDecision(engine.store.listTriggers()[0]!.decisionId!)
    expect(decision?.strength).toBe('inferred')
    expect(engine.store.getMandate(engine.store.listTickets()[0]!.mandateId)?.rules).toEqual(['bugfix'])
  })

  it('未 @ 的群消息被判闲聊时完全静默，不刷屏', async () => {
    const { engine, loop, store } = setup([IGNORE('闲聊')])
    engine.ingest(trigger({ addressed: 'none', text: '哈哈哈今天天气不错' }))

    const result = await loop.tick()
    expect(result.accepted).toHaveLength(0)
    expect(store.claimOutbox('2026-11-06T10:00:20.000Z', 10)).toHaveLength(0)
  })

  it('私聊被判闲聊时礼貌回一句（普通消息）', async () => {
    const { engine, loop, store } = setup([IGNORE('只是在问候'), SAY('收到～需要我改哪块？')])
    engine.ingest(trigger({ addressed: 'direct', text: '在吗' }))

    const result = await loop.tick()
    expect(result.replied).toBe(1)
    const outbox = store.claimOutbox('2026-11-06T10:00:20.000Z', 10)
    expect(outbox[0]?.text).toBe('收到～需要我改哪块？')
    expect(outbox[0]?.threadId).toBe('')
  })

  it('模型输出不是合法 JSON 时记为 unavailable，不建单也不打扰未 @ 的群', async () => {
    const { engine, loop, store } = setup([{ content: '我觉得可以看看', toolCalls: [] }])
    engine.ingest(trigger({ addressed: 'none' }))

    const result = await loop.tick()
    expect(result.unavailable).toBe(1)
    const decision = engine.store.getDecision(engine.store.listTriggers()[0]!.decisionId!)
    expect(decision?.decision).toBe('unavailable')
    expect(store.claimOutbox('2026-11-06T10:00:20.000Z', 10)).toHaveLength(0)
  })

  it('模型调用失败同样记 unavailable，但不会反复重试同一条', async () => {
    const { engine, loop } = setup([])
    loop.llm = { complete: async () => { throw new Error('llm down') } }
    engine.ingest(trigger({ addressed: 'none' }))

    expect((await loop.tick()).unavailable).toBe(1)
    expect((await loop.tick()).unavailable).toBe(0)
    expect(engine.store.listOpenTickets()).toHaveLength(0)
  })

  it('accept mode off 时只回复说明，不开工，也不调用模型', async () => {
    const { engine, loop, store, llm } = setup([])
    engine.updatePolicy({ ...policy, acceptMode: 'off' })
    engine.ingest(trigger({ addressed: 'none' }))

    const result = await loop.tick()
    expect(result.accepted).toHaveLength(0)
    expect(result.replied).toBe(1)
    expect(llm.requests).toHaveLength(0)
    const outbox = store.claimOutbox('2026-11-06T10:00:20.000Z', 10)
    expect(outbox[0]?.text).toContain('暂不自动开工')
  })

  it('批处理只取窗口之前的消息，且一轮内多条各自出决定', async () => {
    const { engine, loop, llm } = setup([ACCEPT('A'), IGNORE('闲聊')])
    engine.ingest(trigger({ id: 't1', externalId: 'e1', addressed: 'none', receivedAt: '2026-11-06T10:00:00.000Z' }))
    engine.ingest(trigger({ id: 't2', externalId: 'e2', addressed: 'none', text: '随便聊聊', receivedAt: '2026-11-06T10:00:09.000Z' }))

    const result = await loop.tick()
    expect(llm.requests).toHaveLength(1)
    expect(result.accepted).toHaveLength(1)
    expect(engine.store.getTrigger('t2')?.disposition).toBe('pending')
  })

  it('已经订阅的线程走扇出，不再进研判', async () => {
    const { engine, loop } = setup([ACCEPT()])
    engine.ingest(trigger({ id: 't0', externalId: 'e0' }))
    await loop.tick()
    const ticket = engine.store.listTickets()[0]!
    engine.startAssignment(ticket.id, { backendId: 'orca', handle: 'h', workdir: '/tmp/wt' })

    engine.ingest(trigger({ id: 't1', externalId: 'e1', addressed: 'none', text: '顺便把超时改成 60 秒' }))
    const result = await loop.tick()
    expect(result.fannedOut).toBe(1)
    expect(engine.store.pendingInputs(ticket.id)[0]?.text).toContain('60 秒')
  })

  it('工单已接但还没派工时，同线程的新消息挂到该工单而不是重复开单', async () => {
    const { engine, loop } = setup([ACCEPT('改登录超时')])
    engine.ingest(trigger({ id: 't0', externalId: 'e0', text: '改登录超时' }))
    await loop.tick()
    expect(engine.store.listTickets()).toHaveLength(1)

    engine.ingest(trigger({ id: 't1', externalId: 'e1', text: '顺便把超时改成 60 秒', addressed: 'none' }))
    const result = await loop.tick()
    expect(result.fannedOut).toBe(1)
    expect(engine.store.listTickets()).toHaveLength(1)
    const ticket = engine.store.listTickets()[0]!
    const inputs = engine.store.listInputs(ticket.id)
    expect(inputs[0]?.text).toContain('60 秒')
    expect(inputs[0]?.assignmentId).toBe('')
  })

  it('重叠的 tick 不会重复研判同一条消息', async () => {
    const { engine, loop, llm } = setup([])
    loop.llm = {
      async complete() {
        await new Promise(resolve => setTimeout(resolve, 30))
        return ACCEPT('并发只开一张')
      },
    }
    engine.ingest(trigger({ text: '把登录超时改成 30 秒' }))
    const [a, b] = await Promise.all([loop.tick(), loop.tick()])
    expect(a.accepted.length + b.accepted.length).toBe(1)
    expect(engine.store.listTickets()).toHaveLength(1)
    expect(llm.requests).toHaveLength(0)
  })

  it('消息 id 归一化：内部 id 会被剥掉前缀，非法值变空（发普通消息）', () => {
    expect(normalizeMessageId('om_x100b61e2c5cb6cb')).toBe('om_x100b61e2c5cb6cb')
    expect(normalizeMessageId('feishu_om_x100b61e2c5cb6cb')).toBe('om_x100b61e2c5cb6cb')
    expect(normalizeMessageId('feishu_om_x100b61e2c5cb6cb4b08efe52a9e518a')).toBe('om_x100b61e2c5cb6cb4b08efe52a9e518a')
    expect(normalizeMessageId('')).toBe('')
    expect(normalizeMessageId('oc_123')).toBe('')
  })

  it('模型调用 router_reply 不会产生重复消息', async () => {
    const { engine, loop, store } = setup([{
      content: null,
      toolCalls: [
        { id: 'c1', name: 'router_reply', arguments: JSON.stringify({ chat_id: 'oc_dev', text: '重复的回复', thread_id: 'feishu_om_x' }) },
        { id: 'c2', name: 'router_decide', arguments: JSON.stringify({ trigger_id: 't1', decision: 'accept', reason: 'ok', title: '改超时', scope: 'x' }) },
      ],
    }])
    engine.ingest(trigger({ text: '把登录超时改成 30 秒' }))
    await loop.tick()
    const outbox = store.claimOutbox('2026-11-06T10:00:20.000Z', 10)
    expect(outbox.some(item => item.text === '重复的回复')).toBe(false)
    expect(outbox.filter(item => item.key.startsWith('ack:'))).toHaveLength(1)
  })

  it('寒暄判定只拦纯寒暄，不误伤简短需求', () => {
    for (const text of ['你好', '你好，在吗', 'Hi', '在不在？', '测试一下', '谢谢！', '好的']) expect(isSmallTalk(text)).toBe(true)
    for (const text of ['修个 bug', '改登录超时', '在吗，帮我把超时改成 30 秒', '你好，请把 README 端口改成 3083', '']) expect(isSmallTalk(text)).toBe(false)
  })

  it('暴露给模型的工具集合覆盖设计文档的五个 router_* 工具', () => {
    expect(ROUTER_TOOLS.map(t => t.function.name).sort()).toEqual(
      ['router_decide', 'router_read', 'router_reply', 'router_subscribe', 'router_ticket'],
    )
  })
})
describe('多项目 / 多分支派工', () => {
  const dispatch: DispatchSettings = {
    projects: [{ name: 'router-agent', repo: 'name:dsh/router-agent', branches: [], defaultBranch: '' }],
    bindings: [],
  }

  const decide = (args: Record<string, unknown>) => ({
    content: null as string | null,
    toolCalls: [{ id: 'call_1', name: 'router_decide', arguments: JSON.stringify({ trigger_id: 't1', decision: 'accept', reason: '可执行', title: '改登录超时', scope: '只改超时', ...args }) }],
  })

  it('缺项目与分支时不开单，先追问并把请求记成草稿', async () => {
    const ambiguous: DispatchSettings = {
      projects: [dispatch.projects[0]!, { name: 'super-agent', repo: 'name:dsh/super-agent', branches: [], defaultBranch: '' }],
      bindings: [],
    }
    const { engine, loop, store } = setup([decide({}), SAY('要改哪个项目、从哪个分支开始？')], ambiguous)
    engine.ingest(trigger())

    const result = await loop.tick()

    expect(result.accepted).toHaveLength(0)
    expect(result.ignored).toBe(1)
    expect(result.replied).toBe(1)
    expect(store.listTickets()).toHaveLength(0)
    const draft = store.getDispatchDraft('oc_dev')!
    expect(draft.task).toBe('登录总是 10 秒就超时，帮我改成 30 秒')
    expect(draft.repo).toBe('')
    const outbox = store.claimOutbox('2026-11-06T10:00:20.000Z', 10)
    expect(outbox[0]?.text).toContain('哪个项目')
    const decision = store.getDecision(store.listTriggers()[0]!.decisionId!)
    expect(decision?.decision).toBe('ignore')
    expect(decision?.reason).toBe('clarify:missing-repo+branch')
  })

  it('用户补齐分支后，继承草稿并真正开单，工单带上 repo/branch', async () => {
    const { engine, loop, store } = setup([decide({})], dispatch)
    store.saveDispatchDraft({
      chatId: 'oc_dev',
      threadId: 'feishu:oc_dev:om_1',
      actorId: 'ou_alice',
      task: '登录总是 10 秒就超时，帮我改成 30 秒',
      repo: 'router-agent',
      branch: 'main',
      updatedAt: '2026-11-06T10:00:00.000Z',
    })
    engine.ingest(trigger({ text: '用 main 分支就行' }))

    const result = await loop.tick()

    expect(result.accepted).toHaveLength(1)
    expect(result.accepted[0]?.repo).toBe('name:dsh/router-agent')
    expect(result.accepted[0]?.branch).toBe('main')
    expect(result.accepted[0]?.title).toBe('改登录超时')
    expect(store.getDispatchDraft('oc_dev')).toBeNull()
  })

  it('群绑定 repo/branch 时直接开单，不再追问', async () => {
    const bound: DispatchSettings = { ...dispatch, bindings: [{ chat: 'oc_dev', repo: 'router-agent', branch: 'release' }] }
    const { engine, loop, llm } = setup([decide({})], bound)
    engine.ingest(trigger())

    const result = await loop.tick()

    expect(result.accepted).toHaveLength(1)
    expect(result.accepted[0]?.branch).toBe('release')
    // 只调用了一次模型（研判），没有额外的追问调用
    expect(llm.requests).toHaveLength(1)
  })

  it('会话级绑定写进 system prompt：研判与回话两条通道都看得到', async () => {
    const bound: DispatchSettings = { ...dispatch, bindings: [{ chat: 'oc_dev', repo: 'router-agent', branch: 'release' }] }
    const { engine, loop, llm } = setup([IGNORE('只是询问项目信息'), SAY('这个会话用的是 router-agent 的 release 分支。')], bound)
    engine.ingest(trigger({ text: '这个项目地址是什么' }))

    await loop.tick()

    // 第一次是研判，第二次是回话；两者的 system 段都带「当前会话」
    const judgeSystem = String(llm.requests[0]?.messages[0]?.content)
    const chatSystem = String(llm.requests[1]?.messages[0]?.content)
    for (const system of [judgeSystem, chatSystem]) {
      expect(system).toContain('# 当前会话')
      expect(system).toContain('已确定项目：router-agent')
      expect(system).toContain('起始分支：release（来源：群绑定）')
    }
    // 会话级信息不再塞进每条消息的 payload
    const payload = JSON.parse(String(llm.requests[1]?.messages.at(-1)?.content))
    expect(payload.current).toBeUndefined()
    expect(payload.dispatch).toBeUndefined()
  })

  it('用户给的分支不在白名单时，不建单并带着拒绝原因追问', async () => {
    const guarded: DispatchSettings = { projects: [{ ...dispatch.projects[0]!, branches: ['main', 'release'] }], bindings: [] }
    const { engine, loop, store } = setup([decide({ branch: 'feature/x' }), SAY('只支持 main 或 release，从哪个开始？')], guarded)
    engine.ingest(trigger())

    const result = await loop.tick()

    expect(result.accepted).toHaveLength(0)
    expect(store.listTickets()).toHaveLength(0)
    const draft = store.getDispatchDraft('oc_dev')!
    expect(draft.branch).toBe('')
    const decision = store.getDecision(store.listTriggers()[0]!.decisionId!)
    expect(decision?.reason).toBe('clarify:missing-branch')
  })

  it('模型不可用时，派工追问走确定性兜底话术', () => {
    const projects = [{ name: 'router-agent', branches: ['main', 'release'] }, { name: 'super-agent', branches: [] }]
    expect(clarifyFallback({ missing: ['repo', 'branch'], repo: '', branch: '', task: 'x' }, projects)).toBe(
      '确认一下再开工：要改哪个项目（router-agent、super-agent），从哪个分支开始？',
    )
    expect(clarifyFallback({ missing: ['branch'], repo: 'r', branch: '', task: 'x' }, projects)).toContain('从哪个分支开始')
    expect(clarifyFallback({ missing: ['repo'], repo: '', branch: 'main', rejectedRepo: 'nope', task: 'x' }, projects)).toContain('没有找到项目「nope」')
    expect(clarifyFallback({ missing: ['branch'], repo: 'r', branch: '', rejectedBranch: 'dev', task: 'x' }, projects)).toContain('main、release')
  })

  it('JSON 兜底路径同样受派工校验：缺分支不建单', async () => {
    const { engine, loop, store } = setup([ACCEPT(), SAY('从哪个分支开始改？')], dispatch)
    engine.ingest(trigger())

    const result = await loop.tick()

    expect(result.accepted).toHaveLength(0)
    expect(store.listTickets()).toHaveLength(0)
    expect(store.getDispatchDraft('oc_dev')).not.toBeNull()
    expect(store.claimOutbox('2026-11-06T10:00:20.000Z', 10)[0]?.text).toContain('分支')
  })
})

describe('群级白名单', () => {
  it('群白名单外的人 @bot：直接忽略，不调模型也不回复', async () => {
    const dispatch: DispatchSettings = { projects: [{ name: 'router-agent', repo: 'name:dsh/router-agent', branches: [], defaultBranch: 'main' }], bindings: [] }
    const { engine, loop, llm, store } = setup([], dispatch)
    engine.updatePolicy({ ...policy, allowedByChat: { oc_dev: ['ou_other'] } })
    engine.ingest(trigger({ actorId: 'ou_alice' }))

    const result = await loop.tick()

    expect(result.ignored).toBe(1)
    expect(llm.requests).toHaveLength(0)
    expect(store.claimOutbox('2026-11-06T10:00:20.000Z', 10)).toHaveLength(0)
    const decision = store.getDecision(store.listTriggers()[0]!.decisionId!)
    expect(decision?.reason).toBe('admission:not-in-chat-allowlist')
  })
})
