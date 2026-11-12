import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store/db.js'
import type { Assignment, Input, Intake, Report, Ticket, Trigger } from '../../src/core/model.js'
import { DEFAULT_ADMISSION, type Policy } from '../../src/core/policy.js'

function store(): Store {
  return new Store(':memory:')
}

const policy: Policy = {
  version: 'p1',
  acceptMode: 'observe',
  maxWorkers: 4,
  allowed: ['ou_alice'],
  bots: [],
  admission: DEFAULT_ADMISSION,
  receiveAll: true,
}

function trigger(over: Partial<Trigger> = {}): Trigger {
  return {
    id: 't1',
    source: 'feishu',
    externalId: 'om_1',
    threadId: 'feishu:oc_chat:om_root',
    chatId: 'oc_chat',
    chatName: '研发群',
    actorId: 'ou_alice',
    actorName: 'Alice',
    isBot: false,
    text: '帮我把登录超时改成 30 秒',
    addressed: 'mention',
    receivedAt: '2026-11-06T10:00:00.000Z',
    disposition: 'pending',
    ...over,
  }
}

const ticket: Ticket = {
  id: 'tk1',
  title: '修复登录超时',
  threadId: 'feishu:oc_chat:om_root',
  source: 'feishu',
  chatId: 'oc_chat',
  mandateId: 'md1',
  stage: 'todo',
  repo: 'dsh/router-agent',
  branch: 'main',
  prNumber: 0,
  prUrl: '',
  prState: 'none',
  createdAt: '2026-11-06T10:00:01.000Z',
  updatedAt: '2026-11-06T10:00:01.000Z',
}

const assignment: Assignment = {
  id: 'as1',
  ticketId: 'tk1',
  runtimeId: 'orca',
  handle: 'term-1',
  workdir: '/tmp/wt',
  status: 'running',
  startedAt: '2026-11-06T10:00:02.000Z',
}

describe('Store', () => {
  it('策略以 JSON 形式存取，并保留版本号', () => {
    const s = store()
    s.setPolicy(policy)
    expect(s.getPolicy()).toEqual(policy)
    s.setPolicy({ ...policy, version: 'p2', acceptMode: 'auto' })
    expect(s.getPolicy()!.version).toBe('p2')
    expect(s.getPolicy()!.acceptMode).toBe('auto')
    s.close()
  })

  it('同样的 Source 事件 ID 只入库一次', () => {
    const s = store()
    expect(s.insertTrigger(trigger())).toBe(true)
    expect(s.insertTrigger(trigger({ id: 't1-dup' }))).toBe(false)
    expect(s.listTriggers()).toHaveLength(1)
    s.close()
  })

  it('按时间取出待研判的 Trigger，并可更新去向', () => {
    const s = store()
    s.insertTrigger(trigger({ id: 't1', externalId: 'om_1', receivedAt: '2026-11-06T10:00:00.000Z' }))
    s.insertTrigger(trigger({ id: 't2', externalId: 'om_2', receivedAt: '2026-11-06T10:00:09.000Z' }))
    const batch = s.listPendingTriggers('2026-11-06T10:00:05.000Z')
    expect(batch.map(t => t.id)).toEqual(['t1'])
    s.setTriggerDisposition('t1', 'evaluated', 'd1')
    expect(s.getTrigger('t1')?.disposition).toBe('evaluated')
    expect(s.getTrigger('t1')?.decisionId).toBe('d1')
    s.close()
  })

  it('未 @ 放行标记随 Trigger 落库，取回来还在', () => {
    const s = store()
    s.insertTrigger(trigger({ id: 't1', externalId: 'om_1', addressed: 'none', unaddressedAdmitted: true }))
    s.insertTrigger(trigger({ id: 't2', externalId: 'om_2', addressed: 'none' }))
    expect(s.getTrigger('t1')?.unaddressedAdmitted).toBe(true)
    expect(s.getTrigger('t2')?.unaddressedAdmitted).toBeUndefined()
    s.close()
  })

  it('工单可按阶段查询，并保留 PR 字段', () => {
    const s = store()
    s.insertTicket(ticket)
    s.insertTicket({ ...ticket, id: 'tk2', stage: 'running', prNumber: 7, prUrl: 'https://github.com/o/r/pull/7', prState: 'open' })
    expect(s.listTickets({ stage: 'running' }).map(t => t.id)).toEqual(['tk2'])
    s.updateTicket({ ...ticket, stage: 'review', prNumber: 9, prUrl: 'https://github.com/o/r/pull/9', prState: 'open' })
    const loaded = s.getTicket('tk1')!
    expect(loaded.stage).toBe('review')
    expect(loaded.prNumber).toBe(9)
    s.close()
  })

  it('旧库阶段值读时归一化，查询兼容旧别名且旧终态不算在办', () => {
    const s = store()
    s.insertTicket({ ...ticket, id: 'old1', stage: 'accepted' as never })
    s.insertTicket({ ...ticket, id: 'old2', stage: 'closed' as never })
    s.insertTicket({ ...ticket, id: 'new1', stage: 'todo' })

    expect(s.getTicket('old1')?.stage).toBe('todo')
    expect(s.getTicket('old2')?.stage).toBe('done')
    expect(s.listTickets({ stage: 'todo' }).map(t => t.id).sort()).toEqual(['new1', 'old1'])
    // 旧查询值也能命中（CLI --stage accepted 等历史用法）。
    expect(s.listTickets({ stage: 'accepted' as never }).map(t => t.id)).toContain('old1')
    // 迁移脚本执行前，旧 closed 也不能被当成在办工单。
    expect(s.listOpenTickets().map(t => t.id)).not.toContain('old2')
    s.close()
  })

  it('工单的原始附件会落库并读回', () => {
    const s = store()
    s.insertTicket({
      ...ticket,
      attachments: [
        { path: '/tmp/ra-images/tk1/img_a.png', mimeType: 'image/png' },
        { path: '/tmp/ra-images/tk1/img_b.jpg', mimeType: 'image/jpeg', quoted: true },
      ],
    })
    expect(s.getTicket('tk1')?.attachments).toEqual([
      { path: '/tmp/ra-images/tk1/img_a.png', mimeType: 'image/png' },
      { path: '/tmp/ra-images/tk1/img_b.jpg', mimeType: 'image/jpeg', quoted: true },
    ])
    // 更新其它字段时不能丢掉附件。
    s.updateTicket({ ...s.getTicket('tk1')!, stage: 'running' })
    expect(s.getTicket('tk1')?.attachments).toHaveLength(2)
    s.close()
  })

  it('旧库的 backend_id 列自动迁移为 runtime_id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ra-db-'))
    const path = join(dir, 'ra.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE assignments (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        backend_id TEXT NOT NULL,
        handle TEXT NOT NULL,
        workdir TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      INSERT INTO assignments VALUES
        ('as1', 'tk1', 'claude-cli', 'h1', '/tmp/wt', 'running', '2026-11-06T10:00:02.000Z', NULL);
    `)
    legacy.close()

    const s = new Store(path)
    expect(s.getAssignment('as1')).toMatchObject({ runtimeId: 'claude-cli', handle: 'h1' })
    s.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('派工、报告与投递记录可以按工单取回，seq 单调递增', () => {
    const s = store()
    s.insertTicket(ticket)
    s.insertAssignment(assignment)
    expect(s.latestAssignment('tk1')?.id).toBe('as1')

    const input: Input = {
      id: 'in1',
      ticketId: 'tk1',
      assignmentId: 'as1',
      seq: s.nextInputSeq('tk1'),
      kind: 'followup',
      text: '顺便补个测试',
      status: 'pending',
      createdAt: '2026-11-06T10:03:00.000Z',
    }
    s.insertInput(input)
    expect(s.nextInputSeq('tk1')).toBe(2)

    const report: Report = {
      id: 'rp1',
      ticketId: 'tk1',
      assignmentId: 'as1',
      turn: 1,
      state: 'progress',
      summary: '已定位',
      ackedInputs: ['in1'],
      at: '2026-11-06T10:04:00.000Z',
    }
    s.insertReport(report)
    expect(s.latestReport('tk1')?.summary).toBe('已定位')

    expect(s.ackInputs('tk1', ['in1'], '2026-11-06T10:04:00.000Z')).toEqual(['in1'])
    expect(s.listInputs('tk1')[0]?.status).toBe('acked')
    s.close()
  })

  it('ack 不限定 assignment：换派工后旧派工下投递的输入仍能被新 worker 确认（tk-51）', () => {
    const s = store()
    s.insertTicket(ticket)
    s.insertAssignment(assignment)
    s.insertAssignment({ ...assignment, id: 'as2', handle: 'term-2', startedAt: '2026-11-06T10:05:00.000Z' })
    // 输入创建时挂在 as1 上，实际被 as2 消费
    s.insertInput({
      id: 'in1',
      ticketId: 'tk1',
      assignmentId: 'as1',
      seq: 1,
      kind: 'followup',
      text: '继续',
      status: 'delivered',
      createdAt: '2026-11-06T10:03:00.000Z',
    })

    expect(s.ackInputs('tk1', ['in1'], '2026-11-06T10:06:00.000Z')).toEqual(['in1'])
    expect(s.listInputs('tk1')[0]).toMatchObject({ status: 'acked', ackedAt: '2026-11-06T10:06:00.000Z' })
    // 已 acked 的不再重复返回，避免调用方误以为自己清了新的计数
    expect(s.ackInputs('tk1', ['in1'], '2026-11-06T10:07:00.000Z')).toEqual([])
    s.close()
  })

  it('放错工单的 id 不会被 ack；会话丢失时未确认的输入标记 expired', () => {
    const s = store()
    s.insertTicket(ticket)
    s.insertTicket({ ...ticket, id: 'tk2' })
    s.insertAssignment(assignment)
    s.insertInput({
      id: 'in1',
      ticketId: 'tk1',
      assignmentId: 'as1',
      seq: 1,
      kind: 'followup',
      text: '继续',
      status: 'delivered',
      createdAt: '2026-11-06T10:03:00.000Z',
    })

    expect(s.ackInputs('tk2', ['in1'], '2026-11-06T10:06:00.000Z')).toEqual([])
    expect(s.listInputs('tk1')[0]?.status).toBe('delivered')

    expect(s.expireUnackedInputs('tk1')).toBe(1)
    expect(s.listInputs('tk1')[0]?.status).toBe('expired')
    // expired 既不算待投递，也不算待确认：巡检时不应再被当成重投任务
    expect(s.unackedInputs('tk1')).toHaveLength(0)
    expect(s.pendingInputs('tk1')).toHaveLength(0)
    s.close()
  })

  it('订阅支持同一个 Thread 挂多个工单，并可单独退订', () => {
    const s = store()
    s.subscribe({ threadId: 'th1', ticketId: 'tk1', contextOnly: false, createdAt: '2026-11-06T10:00:00.000Z' })
    s.subscribe({ threadId: 'th1', ticketId: 'tk2', contextOnly: true, createdAt: '2026-11-06T10:00:00.000Z' })
    expect(s.listSubscriptions('th1').map(x => x.ticketId)).toEqual(['tk1', 'tk2'])
    s.unsubscribe('th1', 'tk1')
    expect(s.listSubscriptions('th1').map(x => x.ticketId)).toEqual(['tk2'])
    s.close()
  })

  it('Outbox 按 key 幂等入队，按 next_at 到期领取', () => {
    const s = store()
    expect(s.enqueueOutbox({ id: 'o1', key: 'k1', channelKind: 'feishu', channelId: 'oc_chat', threadId: 'om_root', text: '收到', now: '2026-11-06T10:00:00.000Z' })).toBe(true)
    expect(s.enqueueOutbox({ id: 'o2', key: 'k1', channelKind: 'feishu', channelId: 'oc_chat', threadId: 'om_root', text: '重复', now: '2026-11-06T10:00:00.000Z' })).toBe(false)
    expect(s.claimOutbox('2026-11-06T09:59:59.000Z', 10)).toHaveLength(0)
    const claimed = s.claimOutbox('2026-11-06T10:00:01.000Z', 10)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.text).toBe('收到')
    s.close()
  })

  it('Outbox 失败后指数退避，重试成功后不再出现', () => {
    const s = store()
    s.enqueueOutbox({ id: 'o1', key: 'k1', channelKind: 'feishu', channelId: 'c', threadId: 'r', text: 'hi', now: '2026-11-06T10:00:00.000Z' })
    const [item] = s.claimOutbox('2026-11-06T10:00:01.000Z', 10)
    s.failOutbox(item!.id, 'network', '2026-11-06T10:00:01.000Z')
    // 第一次失败后 2 秒重试
    expect(s.claimOutbox('2026-11-06T10:00:02.000Z', 10)).toHaveLength(0)
    const [retry] = s.claimOutbox('2026-11-06T10:00:03.000Z', 10)
    expect(retry?.attempts).toBe(2)
    s.succeedOutbox(retry!.id, '2026-11-06T10:00:03.000Z')
    expect(s.claimOutbox('2026-11-06T10:10:00.000Z', 10)).toHaveLength(0)
    s.close()
  })

  it('原子领取：同一 Trigger 不会被两个 tick 重复拿到，重启可重置', () => {
    const s = store()
    s.insertTrigger(trigger({ id: 't1', externalId: 'om_1', receivedAt: '2026-11-06T10:00:00.000Z' }))
    const first = s.claimPendingTriggers('2026-11-06T10:00:05.000Z')
    expect(first.map(t => t.id)).toEqual(['t1'])
    expect(s.getTrigger('t1')?.disposition).toBe('evaluating')
    expect(s.claimPendingTriggers('2026-11-06T10:00:05.000Z')).toHaveLength(0)
    s.resetEvaluating()
    expect(s.getTrigger('t1')?.disposition).toBe('pending')
    expect(s.claimPendingTriggers('2026-11-06T10:00:05.000Z')).toHaveLength(1)
    s.close()
  })

  it('回执表情可保存/读取/清除，Outbox 保留来源消息', () => {
    const s = store()
    s.saveReaction('om_1', 're_1', '2026-11-06T10:00:00.000Z')
    expect(s.getReaction('om_1')?.reactionId).toBe('re_1')
    s.clearReaction('om_1')
    expect(s.getReaction('om_1')).toBeNull()

    s.enqueueOutbox({ id: 'o1', key: 'k1', channelKind: 'feishu', channelId: 'c', threadId: '', text: 'hi', now: '2026-11-06T10:00:00.000Z', originMessageId: 'om_9' })
    const [claimed] = s.claimOutbox('2026-11-06T10:00:01.000Z', 10)
    expect(claimed?.originMessageId).toBe('om_9')
    s.close()
  })

  it('Effects 队列同样支持幂等入队与领取', () => {
    const s = store()
    s.enqueueEffect({ id: 'e1', key: 'launch:tk1', kind: 'launch-worker', payload: { ticketId: 'tk1' }, now: '2026-11-06T10:00:00.000Z' })
    s.enqueueEffect({ id: 'e2', key: 'launch:tk1', kind: 'launch-worker', payload: { ticketId: 'tk1' }, now: '2026-11-06T10:00:00.000Z' })
    const [item] = s.claimEffects('2026-11-06T10:00:01.000Z', 10)
    expect(item?.kind).toBe('launch-worker')
    expect(item?.payload).toEqual({ ticketId: 'tk1' })
    s.close()
  })

  it('游标可保存、覆盖与读取，未写入时返回 null', () => {
    const s = store()
    expect(s.getCursor('feishu:history:oc_dev')).toBeNull()
    s.setCursor('feishu:history:oc_dev', '1000', '2026-11-06T10:00:00.000Z')
    expect(s.getCursor('feishu:history:oc_dev')).toBe('1000')
    s.setCursor('feishu:history:oc_dev', '2000', '2026-11-06T10:01:00.000Z')
    expect(s.getCursor('feishu:history:oc_dev')).toBe('2000')
    s.close()
  })

  it('Trigger 的 mediaOnly 会持久化，默认 false', () => {
    const s = store()
    s.insertTrigger(trigger({ id: 't_media', externalId: 'om_media', mediaOnly: true }))
    s.insertTrigger(trigger({ id: 't_text', externalId: 'om_text' }))
    expect(s.getTrigger('t_media')?.mediaOnly).toBe(true)
    expect(s.getTrigger('t_text')?.mediaOnly).toBe(false)
    s.close()
  })
})

describe('派工草稿', () => {
  it('按群保存、覆盖更新、读取与清除', () => {
    const db = store()
    expect(db.getDispatchDraft('oc_chat', 'ou_alice')).toBeNull()

    db.saveDispatchDraft({
      chatId: 'oc_chat',
      threadId: 'feishu:oc_chat:om_1',
      actorId: 'ou_alice',
      task: '把登录超时改成 30 秒',
      repo: '',
      branch: '',
      updatedAt: '2026-11-06T10:00:00.000Z',
    })
    expect(db.getDispatchDraft('oc_chat', 'ou_alice')?.task).toBe('把登录超时改成 30 秒')

    db.saveDispatchDraft({
      chatId: 'oc_chat',
      threadId: 'feishu:oc_chat:om_2',
      actorId: 'ou_alice',
      task: '把登录超时改成 30 秒',
      repo: 'name:dsh/router-agent',
      branch: 'main',
      updatedAt: '2026-11-06T10:01:00.000Z',
    })
    const draft = db.getDispatchDraft('oc_chat', 'ou_alice')!
    expect(draft).toMatchObject({ repo: 'name:dsh/router-agent', branch: 'main', threadId: 'feishu:oc_chat:om_2' })

    db.clearDispatchDraft('oc_chat', 'ou_alice')
    expect(db.getDispatchDraft('oc_chat', 'ou_alice')).toBeNull()
  })

  it('工单的 repo/branch 会落库并读回', () => {
    const db = store()
    db.insertTicket({ ...ticket, repo: 'name:dsh/router-agent', branch: 'release' })
    expect(db.getTicket('tk1')).toMatchObject({ repo: 'name:dsh/router-agent', branch: 'release' })
  })

  it('工单编号计数器原子自增，重启后从上次的值继续', () => {
    const path = join(tmpdir(), `ra-store-${Date.now()}-${Math.random().toString(16).slice(2)}.db`)
    const db = new Store(path)
    expect(db.nextTicketSeq()).toBe(1)
    expect(db.nextTicketSeq()).toBe(2)
    db.close()

    // 重新打开同一个库，编号不能回到 1，否则会和历史工单撞号。
    const reopened = new Store(path)
    expect(reopened.nextTicketSeq()).toBe(3)
    reopened.close()
    rmSync(path, { force: true })
    rmSync(`${path}-wal`, { force: true })
    rmSync(`${path}-shm`, { force: true })
  })
})

describe('会话复用存储', () => {
  it('chat_sessions 按 key 保存、touch、superseded、purged', () => {
    const db = store()
    const record = {
      sessionKey: 'chat:oc_chat:user:ou_alice',
      chatId: 'oc_chat',
      actorId: 'ou_alice',
      threadId: '',
      sessionFile: '/tmp/session.jsonl',
      sessionId: 'sid_1',
      soulVersion: '',
      policyVersion: '',
      createdAt: '2026-11-06T10:00:00.000Z',
      lastUsedAt: '2026-11-06T10:00:00.000Z',
      status: 'active' as const,
      resetAt: null,
      resetBy: null,
      purgedAt: null,
    }
    db.upsertChatSession(record)
    expect(db.getChatSession(record.sessionKey)?.sessionFile).toBe('/tmp/session.jsonl')

    db.touchChatSession(record.sessionKey, '2026-11-06T11:00:00.000Z')
    expect(db.getChatSession(record.sessionKey)?.lastUsedAt).toBe('2026-11-06T11:00:00.000Z')

    expect(db.listSupersededChatSessions('2026-11-10T00:00:00.000Z')).toHaveLength(0)
    db.markChatSessionSuperseded(record.sessionKey, '2026-11-06T12:00:00.000Z', 'ou_alice')
    expect(db.getChatSession(record.sessionKey)).toBeNull()
    expect(db.listSupersededChatSessions('2026-11-10T00:00:00.000Z')).toHaveLength(1)

    db.markChatSessionPurged('/tmp/session.jsonl', '2026-11-20T00:00:00.000Z')
    expect(db.getChatSessionByFile('/tmp/session.jsonl')).toMatchObject({ status: 'purged', purgedAt: '2026-11-20T00:00:00.000Z' })
    expect(db.listSupersededChatSessions('2026-11-10T00:00:00.000Z')).toHaveLength(0)
  })

  it('派工草稿按 (chat, actor) 隔离，互不覆盖', () => {
    const db = store()
    db.saveDispatchDraft({
      chatId: 'oc_chat',
      threadId: 'feishu:oc_chat:om_1',
      actorId: 'ou_alice',
      task: '改登录超时',
      repo: 'router-agent',
      branch: 'main',
      updatedAt: '2026-11-06T10:00:00.000Z',
    })
    db.saveDispatchDraft({
      chatId: 'oc_chat',
      threadId: 'feishu:oc_chat:om_2',
      actorId: 'ou_bob',
      task: '改支付回调',
      repo: 'router-agent',
      branch: 'release',
      updatedAt: '2026-11-06T10:01:00.000Z',
    })

    expect(db.getDispatchDraft('oc_chat', 'ou_alice')?.task).toBe('改登录超时')
    expect(db.getDispatchDraft('oc_chat', 'ou_bob')?.task).toBe('改支付回调')

    db.clearDispatchDraft('oc_chat', 'ou_alice')
    expect(db.getDispatchDraft('oc_chat', 'ou_alice')).toBeNull()
    expect(db.getDispatchDraft('oc_chat', 'ou_bob')?.task).toBe('改支付回调')
  })
})

describe('需求识别存储', () => {
  const intake: Intake = {
    id: 'it_1',
    threadId: 'feishu:oc_chat:om_root',
    chatId: 'oc_chat',
    actorId: 'ou_bob',
    actorName: 'Bob',
    project: 'router-agent',
    repo: 'name:dsh/router-agent',
    branch: 'main',
    status: 'clarifying',
    kind: 'issue',
    rawText: '登录报错',
    turns: [{ role: 'user', text: '登录报错', at: '2026-11-12T10:00:00.000Z', actorId: 'ou_bob' }],
    questions: 1,
    createdAt: '2026-11-12T10:00:00.000Z',
    updatedAt: '2026-11-12T10:00:00.000Z',
  }

  it('读写 intake，turns 与 report 序列化后保持原样', () => {
    const db = store()
    db.insertIntake(intake)
    db.updateIntake({
      ...intake,
      turns: [...intake.turns, { role: 'router', text: '请补充报错原文', at: '2026-11-12T10:01:00.000Z' }],
      report: {
        title: '登录报错',
        problem: '500',
        background: '',
        steps: '点登录',
        environment: '',
        impact: '',
        expected: '',
        assessment: '疑似 BUG',
      },
    })

    const loaded = db.getIntake('it_1')
    expect(loaded?.turns.map(turn => turn.role)).toEqual(['user', 'router'])
    expect(loaded?.report?.title).toBe('登录报错')
    expect(loaded?.report?.steps).toBe('点登录')
    db.close()
  })

  it('activeIntake 只返回 clarifying / ready，且按人隔离', () => {
    const db = store()
    db.insertIntake(intake)
    expect(db.activeIntake(intake.threadId, 'ou_bob')?.id).toBe('it_1')
    expect(db.activeIntake(intake.threadId, 'ou_alice')).toBeNull()

    db.updateIntake({ ...intake, status: 'approved' })
    expect(db.activeIntake(intake.threadId, 'ou_bob')).toBeNull()
    expect(db.latestIntakeByThread(intake.threadId)?.status).toBe('approved')
    db.close()
  })

  it('按工单号反查 intake', () => {
    const db = store()
    db.insertIntake({ ...intake, status: 'approved', ticketId: 'tk-7' })
    expect(db.intakeByTicket('tk-7')?.id).toBe('it_1')
    expect(db.intakeByTicket('tk-8')).toBeNull()
    db.close()
  })
})

describe('身份别名缓存', () => {
  it('写入后能按 (app_id, kind, value) 读回', () => {
    const db = store()
    expect(db.getIdentityAlias('cli_a', 'email', 'a@b.com')).toBeNull()

    db.setIdentityAlias('cli_a', 'email', 'a@b.com', 'ou_x', '阿振')
    expect(db.getIdentityAlias('cli_a', 'email', 'a@b.com')).toEqual({ openId: 'ou_x', name: '阿振' })
    db.close()
  })

  it('换个 appId 缓存不通用：open_id 是应用内唯一的', () => {
    const db = store()
    db.setIdentityAlias('cli_a', 'email', 'a@b.com', 'ou_x', '阿振')

    // 另一个应用里同一个人的 open_id 完全不同，旧应用的缓存不能被复用。
    expect(db.getIdentityAlias('cli_b', 'email', 'a@b.com')).toBeNull()
    db.close()
  })

  it('同一 appId 下不同 kind 互不串', () => {
    const db = store()
    db.setIdentityAlias('cli_a', 'email', 'a@b.com', 'ou_x', '阿振')

    expect(db.getIdentityAlias('cli_a', 'open_id', 'a@b.com')).toBeNull()
    db.close()
  })

  it('缓存落盘，重开数据库后仍能读到', () => {
    const path = join(tmpdir(), `ra-identity-${Date.now()}-${Math.random().toString(16).slice(2)}.db`)
    const db = new Store(path)
    db.setIdentityAlias('cli_a', 'email', 'a@b.com', 'ou_x', '阿振')
    db.close()

    const reopened = new Store(path)
    expect(reopened.getIdentityAlias('cli_a', 'email', 'a@b.com')).toEqual({ openId: 'ou_x', name: '阿振' })
    reopened.close()
    rmSync(path, { force: true })
    rmSync(`${path}-wal`, { force: true })
    rmSync(`${path}-shm`, { force: true })
  })
})
