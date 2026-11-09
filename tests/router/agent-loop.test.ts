import { describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { AgentLoop, clarifyFallback, isReopenRequest, isSmallTalk } from '../../src/router/agent-loop.js'
import type {
  DecisionEngine,
  DecisionEngineResult,
  DecisionProposal,
  DecisionRequest,
  ReplyRequest,
} from '../../src/router/decision-engine.js'
import { proposalFromJson } from '../../src/router/decision-engine.js'
import { extractJsonObject } from '../../src/router/model-config.js'
import type { Trigger } from '../../src/core/model.js'
import { DEFAULT_ADMISSION, type Policy } from '../../src/core/policy.js'
import type { DispatchSettings } from '../../src/router/dispatch.js'
import type { SessionKeyParts } from '../../src/router/session-registry.js'

interface FakeResponse {
  content: string | null
  toolCalls: { id: string; name: string; arguments: string }[]
  usage?: { input: number; output: number; total: number }
  /** 研判阶段已经生成好的用户答复（模拟查询 / 清理工具的执行结果）。 */
  reply?: string
}

/** 用确定性响应模拟 Pi 研判与回复两条通道。 */
class FakeEngine implements DecisionEngine {
  requests: { kind: 'assess' | 'reply'; systemPrompt: string; userPrompt: string; canMutate?: boolean; session?: SessionKeyParts }[] = []
  sessions = { reset: [] as string[], transcripts: [] as { key: string; text: string }[] }
  constructor(private responses: FakeResponse[]) {}

  async assess(req: DecisionRequest): Promise<DecisionEngineResult> {
    this.requests.push({ kind: 'assess', systemPrompt: req.systemPrompt, userPrompt: req.userPrompt, canMutate: req.canMutate, ...(req.session ? { session: req.session } : {}) })
    const res = this.responses.shift() ?? { content: '{"decision":"ignore","reason":"no more responses"}', toolCalls: [] }
    const audit = {
      engine: 'pi' as const,
      triggerId: req.trigger.id,
      durationMs: 1,
      toolCalls: [] as { name: string; args: string; ok: boolean }[],
      tokens: res.usage ?? { input: 0, output: 0, total: 0 },
      promptChars: { system: req.systemPrompt.length, user: req.userPrompt.length },
    }
    if (res.toolCalls.length > 0) {
      const decide = res.toolCalls.find(call => call.name === 'router_decide')
      if (!decide) return { unavailableReason: 'no decision', audit }
      let args: Record<string, unknown>
      try {
        args = JSON.parse(decide.arguments) as Record<string, unknown>
      } catch {
        return { unavailableReason: 'invalid-json-arguments', audit }
      }
      const parsed = proposalFromJson(args, req.trigger.id, req.strength)
      if (parsed.kind === 'proposal') {
        audit.toolCalls.push({ name: 'router_decide', args: decide.arguments, ok: true })
        return { proposal: parsed.proposal, ...(res.reply ? { reply: res.reply } : {}), audit }
      }
      return { unavailableReason: parsed.reason, audit }
    }
    const json = extractJsonObject(res.content)
    if (!json) return { unavailableReason: '模型未给出可解析的决定', audit }
    const parsed = proposalFromJson(json, req.trigger.id, req.strength)
    if (parsed.kind === 'proposal') return { proposal: parsed.proposal, ...(res.reply ? { reply: res.reply } : {}), audit }
    return { unavailableReason: parsed.reason, audit }
  }

  async reply(req: ReplyRequest): Promise<string> {
    this.requests.push({ kind: 'reply', systemPrompt: req.systemPrompt, userPrompt: req.userPrompt })
    return this.responses.shift()?.content ?? ''
  }

  async resetSession(session: SessionKeyParts, by: string): Promise<void> {
    this.sessions.reset.push(`${session.key}@${by}`)
  }

  async recordTranscript(session: SessionKeyParts, text: string): Promise<void> {
    this.sessions.transcripts.push({ key: session.key, text })
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

const ACCEPT = (title = '延长登录超时到 30 秒'): FakeResponse => ({ content: JSON.stringify({ decision: 'accept', reason: '明确的可执行请求', title, scope: '只调整登录超时配置' }), toolCalls: [] })
const IGNORE = (reason = '闲聊'): FakeResponse => ({ content: JSON.stringify({ decision: 'ignore', reason }), toolCalls: [] })
const SAY = (text: string): FakeResponse => ({ content: text, toolCalls: [] })

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

function setup(
  responses: FakeResponse[] = [],
  dispatch?: DispatchSettings,
  replyAlwaysChats?: string[],
  sessions = false,
  policyOverride?: Policy,
) {
  const store = new Store(':memory:')
  const clock = { now: () => '2026-11-06T10:00:10.000Z' }
  let n = 0
  const ids = { next: (p: string) => `${p}_${++n}` }
  const engine = new Engine({ store, policy: policyOverride ?? policy, clock, ids })
  const fake = new FakeEngine(responses)
  const loop = new AgentLoop({
    engine,
    decisionEngine: fake,
    clock,
    batchWindowMs: 5000,
    source: 'feishu',
    ...(dispatch ? { dispatch } : {}),
    ...(replyAlwaysChats ? { replyAlwaysChats } : {}),
    ...(sessions ? { sessionsEnabled: true, sessionKeyScope: 'user' as const } : {}),
  })
  return { store, engine, llm: fake, loop }
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

  it('写工具授权只看名单：名单内 @ / 私聊允许，名单外即使 @ 也拒绝', async () => {
    const { engine, llm, loop } = setup([])
    engine.ingest(trigger({ id: 't_listed', externalId: 'om_listed', threadId: 'feishu:oc_dev:om_listed', actorId: 'ou_alice', addressed: 'mention' }))
    engine.ingest(trigger({ id: 't_unlisted', externalId: 'om_unlisted', threadId: 'feishu:oc_dev:om_unlisted', actorId: 'ou_mallory', addressed: 'mention' }))
    engine.ingest(trigger({ id: 't_dm', externalId: 'om_dm', threadId: 'feishu:oc_dev:om_dm', actorId: 'ou_alice', addressed: 'direct' }))

    await loop.tick()

    const assessed = llm.requests
      .filter(item => item.kind === 'assess')
      .map(item => {
        const prompt = JSON.parse(item.userPrompt) as { trigger: { actor: string; addressed: string } }
        return { actor: prompt.trigger.actor, addressed: prompt.trigger.addressed, canMutate: item.canMutate }
      })
    expect(assessed).toEqual(expect.arrayContaining([
      { actor: 'ou_alice', addressed: 'mention', canMutate: true },
      { actor: 'ou_mallory', addressed: 'mention', canMutate: false },
      { actor: 'ou_alice', addressed: 'direct', canMutate: true },
    ]))
    expect(assessed).toHaveLength(3)
  })

  it('查询 / 清理工具已经生成答复时直接发送，不再多调一次回复模型', async () => {
    const { engine, llm, loop, store } = setup([{
      content: JSON.stringify({ decision: 'ignore', reason: 'ops:closed-tk-1' }),
      toolCalls: [],
      reply: '已关闭工单 tk-1，workspace 正在回收。',
    }])
    engine.ingest(trigger({ text: '把 tk-1 关掉' }))

    const result = await loop.tick()
    expect(result.replied).toBe(1)
    expect(llm.requests.filter(item => item.kind === 'reply')).toHaveLength(0)
    const outbox = store.claimOutbox('2026-11-06T10:00:20.000Z', 10)
    expect(outbox).toHaveLength(1)
    expect(outbox[0]?.text).toBe('已关闭工单 tk-1，workspace 正在回收。')
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

  it('接单后只发一条话题消息，不再额外发普通 ack', async () => {
    const { engine, loop, store } = setup([ACCEPT('改登录超时')])
    engine.ingest(trigger({ text: '把登录超时改成 30 秒' }))

    await loop.tick()
    const outbox = store.claimOutbox('2026-11-06T10:00:20.000Z', 10)
    expect(outbox).toHaveLength(1)
    const thread = outbox[0]!
    expect(thread.key).toMatch(/^thread:/)
    expect(thread.threadId).toBe('om_1')
    expect(thread.originMessageId).toBe('om_1')
    expect(thread.text).toContain('已开始执行')
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

  it('mode=all 的群里未 @ 也要回：判闲聊时正常回一句，不开单', async () => {
    const { engine, loop, store } = setup([IGNORE('只是提问'), SAY('这个我看下，先不动代码。')], undefined, ['oc_dev'])
    engine.ingest(trigger({ addressed: 'none', text: 'router agent 有内置什么工具么' }))

    const result = await loop.tick()
    expect(result.accepted).toHaveLength(0)
    expect(result.replied).toBe(1)
    expect(engine.store.listTickets()).toHaveLength(0)
    const outbox = store.claimOutbox('2026-11-06T10:00:20.000Z', 10)
    expect(outbox).toHaveLength(1)
    expect(outbox[0]?.text).toBe('这个我看下，先不动代码。')
    expect(outbox[0]?.threadId).toBe('')
  })

  it('mode=all 的群里未 @ 但判接单：照常开单，只发一条话题消息', async () => {
    const { engine, loop, store } = setup([ACCEPT('加个重试')], undefined, ['oc_dev'])
    engine.ingest(trigger({ addressed: 'none', text: 'router-agent 加个重试' }))

    const result = await loop.tick()
    expect(result.accepted).toHaveLength(1)
    const outbox = store.claimOutbox('2026-11-06T10:00:20.000Z', 10)
    expect(outbox).toHaveLength(1)
    expect(outbox[0]?.key).toMatch(/^thread:/)
    expect(outbox[0]?.text).toContain('已开始执行')
    expect(outbox[0]?.threadId).toBe('om_1')
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
    loop.decisionEngine = {
      async assess() { throw new Error('llm down') },
      async reply() { throw new Error('llm down') },
    }
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
    engine.startAssignment(ticket.id, { runtimeId: 'orca', handle: 'h', workdir: '/tmp/wt' })

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
    loop.decisionEngine = {
      async assess(req) {
        await new Promise(resolve => setTimeout(resolve, 30))
        const proposal: DecisionProposal = {
          triggerId: req.trigger.id,
          decision: 'accept',
          strength: req.strength,
          reason: '明确的可执行请求',
          title: '并发只开一张',
          scope: '只调整登录超时配置',
          rules: [],
        }
        return {
          proposal,
          audit: {
            engine: 'pi',
            triggerId: req.trigger.id,
            durationMs: 30,
            toolCalls: [],
            tokens: { input: 0, output: 0, total: 0 },
            promptChars: { system: 0, user: 0 },
            proposal,
          },
        }
      },
      async reply() { return '' },
    }
    engine.ingest(trigger({ text: '把登录超时改成 30 秒' }))
    const [a, b] = await Promise.all([loop.tick(), loop.tick()])
    expect(a.accepted.length + b.accepted.length).toBe(1)
    expect(engine.store.listTickets()).toHaveLength(1)
    expect(llm.requests).toHaveLength(0)
  })

  it('模型调用未知工具不会产生重复消息', async () => {
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
    expect(outbox).toHaveLength(1)
    expect(outbox[0]?.key).toMatch(/^thread:/)
  })

  it('寒暄判定只拦纯寒暄，不误伤简短需求', () => {
    for (const text of ['你好', '你好，在吗', 'Hi', '在不在？', '测试一下', '谢谢！', '好的']) expect(isSmallTalk(text)).toBe(true)
    for (const text of ['修个 bug', '改登录超时', '在吗，帮我把超时改成 30 秒', '你好，请把 README 端口改成 3083', '']) expect(isSmallTalk(text)).toBe(false)
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
    const draft = store.getDispatchDraft('oc_dev', 'ou_alice')!
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
    expect(store.getDispatchDraft('oc_dev', 'ou_alice')).toBeNull()
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
    const judgeSystem = String(llm.requests[0]?.systemPrompt)
    const chatSystem = String(llm.requests[1]?.systemPrompt)
    for (const system of [judgeSystem, chatSystem]) {
      expect(system).toContain('# 当前会话')
      expect(system).toContain('已确定项目：router-agent')
      expect(system).toContain('起始分支：release（来源：群绑定）')
    }
    // 会话级信息不再塞进每条消息的 payload
    const payload = JSON.parse(String(llm.requests[1]?.userPrompt))
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
    const draft = store.getDispatchDraft('oc_dev', 'ou_alice')!
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
    expect(store.getDispatchDraft('oc_dev', 'ou_alice')).not.toBeNull()
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

describe('已关闭工单话题', () => {
  it('重开关键词识别：否定表达不触发', () => {
    expect(isReopenRequest('重新开工')).toBe(true)
    expect(isReopenRequest('继续做，把超时改成 60 秒')).toBe(true)
    expect(isReopenRequest('不用继续了')).toBe(false)
    expect(isReopenRequest('别重开了')).toBe(false)
  })

  function seedClosed(engine: Engine): string {
    engine.ingest(trigger())
    const outcome = engine.decide({
      triggerId: 't1',
      decision: 'accept',
      strength: 'explicit',
      reason: 'test',
      title: '旧工单',
      scope: '旧范围',
      repo: 'acme/web',
      branch: 'main',
    })
    const ticket = outcome.ticket!
    engine.closeTicket(ticket.id, 'idle:test')
    return ticket.id
  }

  it('回复固定「工单已关闭」，不调模型、不自动开单', async () => {
    const { engine, loop, llm, store } = setup([])
    const closedId = seedClosed(engine)

    engine.ingest(trigger({ id: 't2', externalId: 'om_2', text: '在吗' }))
    const result = await loop.tick()

    expect(llm.requests).toHaveLength(0)
    expect(result.accepted).toHaveLength(0)
    expect(result.replied).toBe(1)
    expect(store.listTickets()).toHaveLength(1)
    const outbox = store.claimOutbox('2026-11-06T10:00:20.000Z', 10)
    const reply = outbox.find(item => item.key.startsWith('closed-thread:'))
    expect(reply?.text).toContain('已于')
    expect(reply?.text).toContain('重新开工')
    expect(reply?.threadId).toBe('om_1')
    expect(store.getDecision(store.listTriggers().find(t => t.id === 't2')!.decisionId!)?.reason).toBe('thread:closed')
    expect(closedId).toBe('tk-1')
  })

  it('回复「重新开工」时基于原工单 repo / 起始分支创建新工单，并带上之前描述的需求', async () => {
    const { engine, loop, llm, store } = setup([])
    const closedId = seedClosed(engine)

    engine.ingest(trigger({ id: 't2', externalId: 'om_2', text: '帮我把 README 的端口改成 3081' }))
    await loop.tick()
    expect(llm.requests).toHaveLength(0)
    expect(store.listTickets()).toHaveLength(1)

    engine.ingest(trigger({ id: 't3', externalId: 'om_3', text: '重新开工' }))
    const result = await loop.tick()

    expect(llm.requests).toHaveLength(0)
    expect(result.accepted).toHaveLength(1)
    const tickets = store.listTickets()
    expect(tickets).toHaveLength(2)
    const reopened = tickets.find(ticket => ticket.id !== closedId)!
    expect(reopened.title).toBe('续作：旧工单')
    expect(reopened.repo).toBe('acme/web')
    expect(reopened.branch).toBe('main')
    expect(store.getMandate(reopened.mandateId)?.scope).toContain('3081')
    const outbox = store.claimOutbox('2026-11-06T10:00:20.000Z', 10)
    expect(outbox.some(item => item.text.includes(`基于原工单 ${closedId}`))).toBe(true)
  })
})

describe('会话复用与 /new', () => {
  it('研判按「群 + 人」传 session key', async () => {
    const { engine, llm, loop } = setup([ACCEPT()], undefined, undefined, true)
    engine.ingest(trigger())

    await loop.tick()

    expect(llm.requests[0]?.session?.key).toBe('chat:oc_dev:user:ou_alice')
  })

  it('mode: mention 群里没 @ 的消息不进 session', async () => {
    const { engine, llm, loop } = setup([IGNORE()], undefined, undefined, true)
    engine.ingest(trigger({ addressed: 'none' }))

    await loop.tick()

    expect(llm.requests[0]?.session).toBeUndefined()
  })

  it('mode: all 群里没 @ 的消息也进 session', async () => {
    const { engine, llm, loop } = setup([IGNORE()], undefined, ['oc_dev'], true)
    engine.ingest(trigger({ addressed: 'none' }))

    await loop.tick()

    expect(llm.requests[0]?.session?.key).toBe('chat:oc_dev:user:ou_alice')
  })

  it('/new 只重置发送者自己的 session', async () => {
    const { engine, llm, loop, store } = setup([], undefined, undefined, true)
    engine.ingest(trigger({ text: '/new' }))

    const result = await loop.tick()

    expect(result.replied).toBe(1)
    expect(llm.sessions.reset).toEqual(['chat:oc_dev:user:ou_alice@ou_alice'])
    const outbox = store.claimOutbox('2026-11-06T10:00:20.000Z', 10)
    expect(outbox[0]?.text).toContain('重新开始')
    expect(outbox[0]?.text).toContain('其他人的会话也不受影响')
  })

  it('/new 对名单外成员静默忽略，不重置任何会话', async () => {
    const { engine, llm, loop } = setup([], undefined, undefined, true)
    engine.ingest(trigger({ text: '/new', actorId: 'ou_bob', actorName: 'Bob' }))

    const result = await loop.tick()

    expect(result.replied).toBe(0)
    expect(result.ignored).toBe(1)
    expect(llm.sessions.reset).toEqual([])
  })

  it('确定性回复会写进当前用户的 transcript', async () => {
    const { engine, llm, loop } = setup([], undefined, undefined, true)
    engine.ingest(trigger({ mediaOnly: true, text: '看下这个图' }))

    await loop.tick()

    expect(llm.sessions.transcripts).toHaveLength(1)
    expect(llm.sessions.transcripts[0]?.key).toBe('chat:oc_dev:user:ou_alice')
    expect(llm.sessions.transcripts[0]?.text).toContain('附件')
  })
})

describe('/new 命令识别', () => {
  it('只认整条消息，允许前面带一个 @机器人', async () => {
    const { parseSessionResetCommand } = await import('../../src/router/agent-loop.js')
    expect(parseSessionResetCommand('/new')).toBe(true)
    expect(parseSessionResetCommand('  /new  ')).toBe(true)
    expect(parseSessionResetCommand('@阿罗 /new')).toBe(true)
    expect(parseSessionResetCommand('/new chat')).toBe(false)
    expect(parseSessionResetCommand('帮我 /new 一下')).toBe(false)
    expect(parseSessionResetCommand('/newer')).toBe(false)
  })
})
