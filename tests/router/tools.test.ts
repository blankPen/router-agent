import { describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import type { Trigger } from '../../src/core/model.js'
import { DEFAULT_ADMISSION, type Policy } from '../../src/core/policy.js'
import { RouterToolbox } from '../../src/router/tools.js'

const policy: Policy = {
  version: 'p1',
  acceptMode: 'auto',
  maxWorkers: 4,
  allowed: ['ou_alice'],
  bots: [],
  admission: DEFAULT_ADMISSION,
  receiveAll: true,
}

const NOW = '2026-11-06T10:00:10.000Z'

function trigger(id: string, text: string, chatId = 'oc_dev'): Trigger {
  return {
    id,
    source: 'feishu',
    externalId: `om_${id}`,
    threadId: `feishu:${chatId}:om_${id}`,
    chatId,
    chatName: '研发群',
    actorId: 'ou_alice',
    actorName: 'Alice',
    isBot: false,
    text,
    addressed: 'mention',
    receivedAt: NOW,
    disposition: 'pending',
  }
}

function setup() {
  const store = new Store(':memory:')
  const clock = { now: () => NOW }
  let n = 0
  const ids = { next: (prefix: string) => `${prefix}_${++n}` }
  const engine = new Engine({ store, policy, clock, ids })
  engine.ingest(trigger('t1', '把登录超时改成 30 秒'))
  const { ticket } = engine.decide({
    triggerId: 't1',
    decision: 'accept',
    strength: 'explicit',
    reason: '明确的可执行请求',
    title: '调整登录超时',
    scope: '只改登录超时配置',
  })
  const toolbox = new RouterToolbox({ store, engine, clock })
  return { store, engine, toolbox, ticket: ticket! }
}

function effectKinds(store: Store): string[] {
  return store.claimEffects(NOW, 20).map(item => item.kind).sort()
}

describe('RouterToolbox 查询工具', () => {
  it('router_ticket_list 按阶段 / 关键词 / 会话过滤，并限制条数', () => {
    const { toolbox, engine } = setup()
    engine.ingest(trigger('t2', '改 README', 'oc_other'))
    engine.decide({ triggerId: 't2', decision: 'accept', strength: 'explicit', reason: 'ok', title: '更新 README' })

    const all = toolbox.list({}) as { count: number; tickets: { id: string }[] }
    expect(all.count).toBe(2)

    const byKeyword = toolbox.list({ keyword: 'README' }) as { tickets: { id: string }[] }
    expect(byKeyword.tickets.map(item => item.id)).toEqual(['tk-2'])

    const byChat = toolbox.list({ chat_id: 'oc_other' }) as { tickets: { id: string }[] }
    expect(byChat.tickets.map(item => item.id)).toEqual(['tk-2'])

    const byStage = toolbox.list({ stage: 'accepted' }) as { count: number }
    expect(byStage.count).toBe(2)

    const limited = toolbox.list({ limit: 1 }) as { count: number }
    expect(limited.count).toBe(1)
  })

  it('router_ticket_progress 返回阶段、上报、待答问题与未处理输入', () => {
    const { store, toolbox, ticket } = setup()
    const assignment = store.latestAssignment(ticket.id)
    const assignmentId = assignment?.id ?? 'as_1'
    // 直接走 Store 造一条上报与一个待答问题，模拟 worker 进行中。
    store.insertReport({
      id: 'rp_1',
      ticketId: ticket.id,
      assignmentId,
      turn: 1,
      state: 'blocked',
      summary: '需要确认超时时间',
      humanAction: '确认超时秒数',
      ackedInputs: [],
      at: NOW,
    })
    store.setAttention(ticket.id, '确认超时秒数', NOW)

    const result = toolbox.progress({ ticket_id: ticket.id }) as {
      ticket: { id: string; stage: string }
      attention: { question: string } | null
      pendingInputs: unknown[]
      reports: { state: string; summary: string }[]
      lastProgressAt: string
    }

    expect(result.ticket.id).toBe(ticket.id)
    expect(result.attention?.question).toBe('确认超时秒数')
    expect(result.reports[0]).toMatchObject({ state: 'blocked', summary: '需要确认超时时间' })
    expect(result.lastProgressAt).toBe(NOW)
    expect(result.pendingInputs).toEqual([])
  })

  it('查询不存在的工单返回 ticket:not-found', () => {
    const { toolbox } = setup()
    expect(toolbox.progress({ ticket_id: 'tk-404' })).toEqual({ error: 'ticket:not-found' })
  })
})

describe('RouterToolbox 清理工具', () => {
  it('未明确对 Router 说话时拒绝写操作', () => {
    const { toolbox, store, ticket } = setup()
    const denied = toolbox.close({ ticket_id: ticket.id, reason: '清理' }, { canMutate: false })
    expect(denied).toMatchObject({ error: 'permission:not-authorized' })
    expect(store.getTicket(ticket.id)?.stage).not.toBe('closed')
    expect(effectKinds(store)).toEqual([])
  })

  it('关单默认同时回收 workspace，并写成一条 Effects', () => {
    const { toolbox, store, ticket } = setup()
    const result = toolbox.close({ ticket_id: ticket.id, reason: '用户要求关闭' }, { canMutate: true }) as {
      ticket: { stage: string }
      alreadyClosed: boolean
      queued: string[]
    }

    expect(result.ticket.stage).toBe('closed')
    expect(result.alreadyClosed).toBe(false)
    expect(result.queued).toEqual(['cleanup-workspace'])
    expect(store.getTicket(ticket.id)?.stage).toBe('closed')
    expect(effectKinds(store)).toEqual(['cleanup-workspace'])
  })

  it('remove_workspace=false 时只停 worker，不删 worktree', () => {
    const { toolbox, store, ticket } = setup()
    toolbox.close({ ticket_id: ticket.id, reason: '先停一下', remove_workspace: false }, { canMutate: true })
    expect(effectKinds(store)).toEqual(['stop-worker'])
  })

  it('PR 还开着时默认拒绝关闭，force 才强制关闭', () => {
    const { toolbox, store, ticket } = setup()
    store.updateTicket({ ...store.getTicket(ticket.id)!, prNumber: 12, prUrl: 'https://example.com/pull/12', prState: 'open' })

    const refused = toolbox.close({ ticket_id: ticket.id, reason: '清理' }, { canMutate: true }) as { error?: string }
    expect(refused.error).toBe('pr:open')
    expect(store.getTicket(ticket.id)?.stage).not.toBe('closed')

    const forced = toolbox.close({ ticket_id: ticket.id, reason: '用户确认连 PR 一起关', force: true }, { canMutate: true }) as {
      ticket: { stage: string }
      forced: boolean
    }
    expect(forced.ticket.stage).toBe('closed')
    expect(forced.forced).toBe(true)
  })

  it('重复关单是幂等的，不会重复排队', () => {
    const { toolbox, store, ticket } = setup()
    toolbox.close({ ticket_id: ticket.id, reason: '关闭' }, { canMutate: true })
    const again = toolbox.close({ ticket_id: ticket.id, reason: '再关一次' }, { canMutate: true }) as { alreadyClosed: boolean }
    expect(again.alreadyClosed).toBe(true)
    expect(store.claimEffects(NOW, 20).filter(item => item.kind === 'cleanup-workspace')).toHaveLength(1)
  })

  it('router_workspace_remove 只允许已关闭工单，并排队回收', () => {
    const { toolbox, store, engine, ticket } = setup()
    engine.startAssignment(ticket.id, { backendId: 'orca', handle: 'term_1', workdir: '/tmp/ra-worktree' })

    const refused = toolbox.removeWorkspace({ ticket_id: ticket.id }, { canMutate: true }) as { error?: string }
    expect(refused.error).toBe('ticket:not-closed')

    toolbox.close({ ticket_id: ticket.id, reason: '关闭' }, { canMutate: true })
    store.claimEffects(NOW, 20)
    const removed = toolbox.removeWorkspace({ ticket_id: ticket.id }, { canMutate: true }) as { queued: string; workdir: string }
    expect(removed.queued).toBe('cleanup-workspace')
    expect(removed.workdir).toBe('/tmp/ra-worktree')
  })
})
