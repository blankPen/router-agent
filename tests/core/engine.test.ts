import { beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import { Engine, type Clock, type IdGen } from '../../src/core/engine.js'
import type { Trigger } from '../../src/core/model.js'
import { DEFAULT_ADMISSION, type Policy } from '../../src/core/policy.js'

class FixedClock implements Clock {
  constructor(private value: string) {}
  now(): string {
    return this.value
  }
  advance(ms: number): void {
    this.value = new Date(new Date(this.value).getTime() + ms).toISOString()
  }
}

class SeqIds implements IdGen {
  private n = 0
  next(prefix: string): string {
    this.n += 1
    return `${prefix}_${this.n}`
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

function makeTrigger(over: Partial<Trigger> = {}): Trigger {
  return {
    id: 'trg_1',
    source: 'feishu',
    externalId: 'om_1',
    threadId: 'feishu:oc_chat:om_root',
    chatId: 'oc_chat',
    chatName: '研发群',
    actorId: 'ou_alice',
    actorName: 'Alice',
    isBot: false,
    text: '帮我把登录超时从 10 秒改成 30 秒',
    addressed: 'mention',
    receivedAt: '2026-11-06T10:00:00.000Z',
    disposition: 'pending',
    ...over,
  }
}

describe('Engine', () => {
  let store: Store
  let clock: FixedClock
  let engine: Engine

  beforeEach(() => {
    store = new Store(':memory:')
    clock = new FixedClock('2026-11-06T10:00:00.000Z')
    engine = new Engine({ store, clock, ids: new SeqIds(), policy })
  })

  it('接单会创建工单与 Mandate，并把 Trigger 标记为已研判', () => {
    engine.ingest(makeTrigger())
    const outcome = engine.decide({ triggerId: 'trg_1', decision: 'accept', strength: 'explicit', reason: '名单成员明确要求', title: '调整登录超时', scope: '只改登录超时，不改鉴权逻辑' })

    expect(outcome.decision.decision).toBe('accept')
    expect(outcome.ticket?.title).toBe('调整登录超时')
    expect(outcome.ticket?.stage).toBe('todo')
    expect(outcome.mandate?.scope).toBe('只改登录超时，不改鉴权逻辑')
    expect(outcome.mandate?.policyVersion).toBe('p1')
    expect(store.getTrigger('trg_1')?.disposition).toBe('evaluated')
    expect(store.getTrigger('trg_1')?.decisionId).toBe(outcome.decision.id)
    expect(store.listOpenTickets()).toHaveLength(1)
  })

  it('工单号是全局短编号，按开单顺序自增', () => {
    engine.ingest(makeTrigger({ id: 't1', externalId: 'e1' }))
    engine.ingest(makeTrigger({ id: 't2', externalId: 'e2' }))
    const first = engine.decide({ triggerId: 't1', decision: 'accept', strength: 'explicit', reason: 'ok' })
    const second = engine.decide({ triggerId: 't2', decision: 'accept', strength: 'explicit', reason: 'ok' })

    expect(first.ticket?.id).toBe('tk-1')
    expect(second.ticket?.id).toBe('tk-2')
    expect(second.ticket?.mandateId).not.toBe(first.ticket?.mandateId)
  })

  it('接单自动把工单订阅回原 Thread，后续消息可扇出', () => {
    engine.ingest(makeTrigger())
    const { ticket } = engine.decide({ triggerId: 'trg_1', decision: 'accept', strength: 'explicit', reason: 'ok' })
    expect(store.listSubscriptions('feishu:oc_chat:om_root').map(s => s.ticketId)).toEqual([ticket!.id])
  })

  it('话题内直接回复（只有 thread_id）也能落到工单线程上', () => {
    // 首帖：话题 ID + 自己的 message_id；规范线程 ID 用可回复的消息 ID
    engine.ingest(makeTrigger({
      id: 't1',
      externalId: 'om_first',
      threadId: 'feishu:oc_chat:om_first',
      threadKeys: ['omt_topic', 'om_first'],
    }))
    const { ticket } = engine.decide({ triggerId: 't1', decision: 'accept', strength: 'explicit', reason: 'ok' })

    // 话题内直发：事件只给话题 ID + 新的 message_id，没有 root_id
    engine.ingest(makeTrigger({
      id: 't2',
      externalId: 'om_second',
      text: '合并',
      threadId: 'feishu:oc_chat:om_second',
      threadKeys: ['omt_topic', 'om_second'],
    }))

    const stored = store.getTrigger('t2')!
    // 靠话题 ID 别名收敛回首帖那条线程
    expect(stored.threadId).toBe('feishu:oc_chat:om_first')
    expect(store.listSubscriptions(stored.threadId).map(s => s.ticketId)).toEqual([ticket!.id])
  })

  it('存量线程（om_ 根）能被后续只带话题 ID 的消息命中', () => {
    engine.ingest(makeTrigger({ id: 't1', externalId: 'om_root', threadId: 'feishu:oc_chat:om_root', threadKeys: ['om_root'] }))
    const { ticket } = engine.decide({ triggerId: 't1', decision: 'accept', strength: 'explicit', reason: 'ok' })
    // 存量线程的规范 ID 是 om_ 根；回填把话题 ID 登记成别名。
    store.registerThreadAlias({ source: 'feishu', alias: 'omt_topic', threadId: 'feishu:oc_chat:om_root', createdAt: clock.now() })

    engine.ingest(makeTrigger({
      id: 't2',
      externalId: 'om_second',
      text: '合并',
      threadId: 'feishu:oc_chat:omt_topic',
      threadKeys: ['omt_topic', 'om_second'],
    }))

    expect(store.getTrigger('t2')!.threadId).toBe('feishu:oc_chat:om_root')
    expect(store.listSubscriptions('feishu:oc_chat:om_root').map(s => s.ticketId)).toEqual([ticket!.id])
  })

  it('ignore / stop / unavailable 不创建工单', () => {
    engine.ingest(makeTrigger({ id: 't1', externalId: 'e1' }))
    engine.ingest(makeTrigger({ id: 't2', externalId: 'e2' }))
    engine.ingest(makeTrigger({ id: 't3', externalId: 'e3' }))
    engine.decide({ triggerId: 't1', decision: 'ignore', strength: 'inferred', reason: '闲聊' })
    engine.decide({ triggerId: 't2', decision: 'stop', strength: 'explicit', reason: '人要求停止' })
    engine.decide({ triggerId: 't3', decision: 'unavailable', strength: 'inferred', reason: '模型超时' })
    expect(store.listOpenTickets()).toHaveLength(0)
  })

  it('observe 模式下推断 accept 被记录为「本应接单」且不开工', () => {
    engine.updatePolicy({ ...policy, acceptMode: 'observe' })
    engine.ingest(makeTrigger({ addressed: 'none' }))
    const outcome = engine.decide({ triggerId: 'trg_1', decision: 'accept', strength: 'inferred', reason: '看起来值得做' })
    expect(outcome.decision.decision).toBe('ignore')
    expect(outcome.decision.wouldAccept).toBe(true)
    expect(outcome.ticket).toBeUndefined()
  })

  it('派工启动后工单进入 running，报告 progress 后保持 running', () => {
    engine.ingest(makeTrigger())
    const { ticket } = engine.decide({ triggerId: 'trg_1', decision: 'accept', strength: 'explicit', reason: 'ok' })
    const assignment = engine.startAssignment(ticket!.id, { runtimeId: 'orca', handle: 'term-1', workdir: '/tmp/wt' })
    expect(store.getTicket(ticket!.id)?.stage).toBe('running')

    engine.report(assignment.id, {
      ticketId: ticket!.id,
      turn: 1,
      state: 'progress',
      summary: '已定位到超时配置',
      ackedInputs: [],
    })
    expect(store.getTicket(ticket!.id)?.stage).toBe('running')
  })

  it('report ready 携带 PR 时进入 review 并记录 PR 状态', () => {
    engine.ingest(makeTrigger())
    const { ticket } = engine.decide({ triggerId: 'trg_1', decision: 'accept', strength: 'explicit', reason: 'ok' })
    const assignment = engine.startAssignment(ticket!.id, { runtimeId: 'orca', handle: 'term-1', workdir: '/tmp/wt' })
    engine.report(assignment.id, {
      ticketId: ticket!.id,
      turn: 1,
      state: 'ready',
      summary: 'PR 已开',
      prNumber: 12,
      prUrl: 'https://github.com/o/r/pull/12',
      ackedInputs: [],
    })
    const t = store.getTicket(ticket!.id)!
    expect(t.stage).toBe('review')
    expect(t.prNumber).toBe(12)
    expect(t.prState).toBe('open')
  })

  it('report 保留完整回复，summary 与正文互不覆盖', () => {
    engine.ingest(makeTrigger())
    const { ticket } = engine.decide({ triggerId: 'trg_1', decision: 'accept', strength: 'explicit', reason: 'ok' })
    const assignment = engine.startAssignment(ticket!.id, { runtimeId: 'orca', handle: 'term-1', workdir: '/tmp/wt' })
    engine.report(assignment.id, {
      ticketId: ticket!.id,
      turn: 1,
      state: 'ready',
      summary: '已完成梳理',
      reply: '## 可优化点\n- A\n- B',
      ackedInputs: [],
    })
    const report = store.latestReport(ticket!.id)!
    expect(report.summary).toBe('已完成梳理')
    expect(report.reply).toBe('## 可优化点\n- A\n- B')
    expect(store.getTicket(ticket!.id)?.stage).toBe('review')
  })

  it('report blocked 携带 humanAction 时进入 blocked 并登记待答问题', () => {
    engine.ingest(makeTrigger())
    const { ticket } = engine.decide({ triggerId: 'trg_1', decision: 'accept', strength: 'explicit', reason: 'ok' })
    const assignment = engine.startAssignment(ticket!.id, { runtimeId: 'orca', handle: 'term-1', workdir: '/tmp/wt' })
    engine.report(assignment.id, {
      ticketId: ticket!.id,
      turn: 1,
      state: 'blocked',
      summary: '缺测试账号',
      humanAction: '请提供一个可用的测试账号',
      ackedInputs: [],
    })
    expect(store.getTicket(ticket!.id)?.stage).toBe('blocked')
    expect(store.getAttention(ticket!.id)?.question).toBe('请提供一个可用的测试账号')
  })

  it('工单结束要求 PR 不再处于 open', () => {
    engine.ingest(makeTrigger())
    const { ticket } = engine.decide({ triggerId: 'trg_1', decision: 'accept', strength: 'explicit', reason: 'ok' })
    const assignment = engine.startAssignment(ticket!.id, { runtimeId: 'orca', handle: 'term-1', workdir: '/tmp/wt' })
    engine.report(assignment.id, { ticketId: ticket!.id, turn: 1, state: 'ready', summary: 'ok', prNumber: 3, prUrl: 'u', ackedInputs: [] })

    expect(() => engine.closeTicket(ticket!.id, 'done')).toThrow(/pr:open/)
    const closed = engine.updatePr(ticket!.id, { number: 3, url: 'u', state: 'merged' })
    expect(closed.stage).toBe('review')
    expect(engine.closeTicket(ticket!.id, 'done').stage).toBe('done')
  })

  it('投递输入有单调 seq，ack 后不再重复投递', () => {
    engine.ingest(makeTrigger())
    const { ticket } = engine.decide({ triggerId: 'trg_1', decision: 'accept', strength: 'explicit', reason: 'ok' })
    const assignment = engine.startAssignment(ticket!.id, { runtimeId: 'orca', handle: 'term-1', workdir: '/tmp/wt' })
    const i1 = engine.deliverInput(ticket!.id, { kind: 'followup', text: '顺便补测试' })
    const i2 = engine.deliverInput(ticket!.id, { kind: 'followup', text: '再补文档' })
    expect([i1.seq, i2.seq]).toEqual([1, 2])
    expect(store.pendingInputs(ticket!.id)).toHaveLength(2)

    engine.report(assignment.id, { ticketId: ticket!.id, turn: 1, state: 'progress', summary: '收到', ackedInputs: [i1.id] })
    expect(store.pendingInputs(ticket!.id).map(i => i.id)).toEqual([i2.id])
  })

  it('同一条来源消息只入库一次：sourceKey 命中已有输入', () => {
    engine.ingest(makeTrigger())
    const { ticket } = engine.decide({ triggerId: 'trg_1', decision: 'accept', strength: 'explicit', reason: 'ok' })

    const first = engine.deliverInput(ticket!.id, { kind: 'followup', text: '继续', sourceKey: 'trigger:om_1' })
    const second = engine.deliverInput(ticket!.id, { kind: 'followup', text: '继续', sourceKey: 'trigger:om_1' })

    expect(second.id).toBe(first.id)
    expect(store.listInputs(ticket!.id)).toHaveLength(1)
  })

  it('跨来源重复（飞书 + 面板各插一条）也只入库一次', () => {
    engine.ingest(makeTrigger())
    const { ticket } = engine.decide({ triggerId: 'trg_1', decision: 'accept', strength: 'explicit', reason: 'ok' })

    const fromFeishu = engine.deliverInput(ticket!.id, { kind: 'followup', text: '继续做', sourceKey: 'trigger:om_2' })
    const fromPanel = engine.deliverInput(ticket!.id, { kind: 'followup', text: '继续做' })

    expect(fromPanel.id).toBe(fromFeishu.id)
    expect(store.listInputs(ticket!.id)).toHaveLength(1)
  })

  it('已经 ack 的输入不参与去重：用户可以再发一遍同样的内容', () => {
    engine.ingest(makeTrigger())
    const { ticket } = engine.decide({ triggerId: 'trg_1', decision: 'accept', strength: 'explicit', reason: 'ok' })
    const first = engine.deliverInput(ticket!.id, { kind: 'followup', text: '继续做' })
    engine.ackInputs(ticket!.id, [first.id])

    const again = engine.deliverInput(ticket!.id, { kind: 'followup', text: '继续做' })

    expect(again.id).not.toBe(first.id)
    expect(store.listInputs(ticket!.id)).toHaveLength(2)
  })

  it('扇出用 trigger 的外部 id 做来源标识，重复扇出不会插两条', () => {
    engine.ingest(makeTrigger({ id: 't1', externalId: 'e1' }))
    const { ticket } = engine.decide({ triggerId: 't1', decision: 'accept', strength: 'explicit', reason: 'ok' })
    engine.startAssignment(ticket!.id, { runtimeId: 'orca', handle: 'term-1', workdir: '/tmp/wt' })

    engine.ingest(makeTrigger({ id: 't2', externalId: 'e2', text: '继续做', addressed: 'none' }))
    engine.fanOut('t2')

    expect(store.listInputs(ticket!.id)[0]?.sourceKey).toBe('trigger:e2')
  })
  it('订阅扇出把新消息作为 Input 投给所有活跃工单，并跳过 contextOnly 授权判断', () => {
    engine.ingest(makeTrigger({ id: 't1', externalId: 'e1' }))
    const { ticket } = engine.decide({ triggerId: 't1', decision: 'accept', strength: 'explicit', reason: 'ok' })
    engine.startAssignment(ticket!.id, { runtimeId: 'orca', handle: 'term-1', workdir: '/tmp/wt' })

    engine.ingest(makeTrigger({ id: 't2', externalId: 'e2', text: '登录超时改成 60 秒', addressed: 'none' }))
    const delivered = engine.fanOut('t2')
    expect(delivered.map(t => t.id)).toEqual([ticket!.id])
    expect(store.pendingInputs(ticket!.id)[0]?.text).toContain('60 秒')
    expect(store.getTrigger('t2')?.disposition).toBe('fanned_out')
  })

  it('开单时把 Trigger 里落盘的原始附件复制到工单，供后续派工透传', () => {
    engine.ingest(makeTrigger({
      raw: { attachments: [{ path: '/tmp/ra-images/t1/img_a.png', mimeType: 'image/png' }] },
    }))
    const { ticket } = engine.decide({ triggerId: 'trg_1', decision: 'accept', strength: 'explicit', reason: 'ok' })

    expect(ticket?.attachments).toEqual([{ path: '/tmp/ra-images/t1/img_a.png', mimeType: 'image/png' }])
    expect(store.getTicket(ticket!.id)?.attachments).toEqual(ticket?.attachments)
  })

  it('追问扇出时把图片路径一并投给 Worker', () => {
    engine.ingest(makeTrigger({ id: 't1', externalId: 'e1' }))
    const { ticket } = engine.decide({ triggerId: 't1', decision: 'accept', strength: 'explicit', reason: 'ok' })
    engine.startAssignment(ticket!.id, { runtimeId: 'orca', handle: 'term-1', workdir: '/tmp/wt' })

    engine.ingest(makeTrigger({
      id: 't2',
      externalId: 'e2',
      text: '按这张图改',
      addressed: 'none',
      raw: { attachments: [{ path: '/tmp/ra-images/t2/img_b.png', mimeType: 'image/png', quoted: true }] },
    }))
    engine.fanOut('t2')

    const input = store.pendingInputs(ticket!.id)[0]!
    expect(input.text).toContain('按这张图改')
    expect(input.text).toContain('/tmp/ra-images/t2/img_b.png')
    expect(input.text).toContain('引用消息里的图片')
  })

  it('停止工单后不再接收扇出', () => {
    engine.ingest(makeTrigger({ id: 't1', externalId: 'e1' }))
    const { ticket } = engine.decide({ triggerId: 't1', decision: 'accept', strength: 'explicit', reason: 'ok' })
    engine.stopTicket(ticket!.id, '人工停止')
    expect(store.getTicket(ticket!.id)?.stage).toBe('done')

    engine.ingest(makeTrigger({ id: 't2', externalId: 'e2', text: '继续做' }))
    expect(engine.fanOut('t2')).toHaveLength(0)
  })

  it('派工时把排队阶段的输入重新绑定到新 Assignment', () => {
    engine.ingest(makeTrigger())
    const { ticket } = engine.decide({ triggerId: 'trg_1', decision: 'accept', strength: 'explicit', reason: 'ok' })
    const queued = engine.deliverInput(ticket!.id, { kind: 'followup', text: '开工前补充一句' })
    expect(queued.assignmentId).toBe('')

    const assignment = engine.startAssignment(ticket!.id, { runtimeId: 'orca', handle: 'h1', workdir: '/w' })
    expect(store.listInputs(ticket!.id)[0]?.assignmentId).toBe(assignment.id)
  })

  it('发出可追踪的事件：决定、排队输入、关单', () => {
    const events: { event: string; [key: string]: unknown }[] = []
    const store2 = new Store(':memory:')
    const engine2 = new Engine({ store: store2, policy, clock, ids: new SeqIds(), onEvent: event => events.push(event) })
    engine2.ingest(makeTrigger({ id: 'e1', externalId: 'x1' }))
    const outcome = engine2.decide({ triggerId: 'e1', decision: 'accept', strength: 'explicit', reason: '明确要求', title: '改超时' })
    engine2.deliverInput(outcome.ticket!.id, { kind: 'followup', text: '顺便补测试' })
    engine2.stopTicket(outcome.ticket!.id, '人工停止')

    const decision = events.find(event => event.event === 'router:decision')!
    expect(decision).toMatchObject({ triggerId: 'e1', decision: 'accept', strength: 'explicit', ticketId: outcome.ticket!.id, title: '改超时' })
    expect(events.find(event => event.event === 'input:queued')).toMatchObject({ ticketId: outcome.ticket!.id, text: '顺便补测试' })
    expect(events.find(event => event.event === 'ticket:closed')).toMatchObject({ ticketId: outcome.ticket!.id, by: 'stop' })
    store2.close()
  })

  it('对未知工单操作会报错而不是静默写入', () => {
    expect(() => engine.startAssignment('nope', { runtimeId: 'orca', handle: 'h', workdir: '/w' })).toThrow(/ticket:not-found/)
  })
})
