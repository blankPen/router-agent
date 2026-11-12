import { describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'

const AT = '2026-11-11T04:18:00.000Z'

function store(): Store {
  return new Store(':memory:')
}

describe('线程别名解析', () => {
  it('同一话题的不同标识解析到同一个 Thread', () => {
    const db = store()

    // 话题首帖：同时带话题 ID 与自己的 message_id
    const first = db.resolveThread({
      source: 'feishu',
      chatId: 'oc_1',
      keys: ['omt_topic_1', 'om_x_first'],
      canonicalId: 'feishu:oc_1:omt_topic_1',
      createdAt: AT,
    })
    expect(first).toEqual({ threadId: 'feishu:oc_1:omt_topic_1', created: true })

    // 话题内直接回复：只有话题 ID + 新的 message_id
    const direct = db.resolveThread({
      source: 'feishu',
      chatId: 'oc_1',
      keys: ['omt_topic_1', 'om_x_second'],
      canonicalId: 'feishu:oc_1:omt_topic_1',
      createdAt: AT,
    })
    expect(direct).toEqual({ threadId: 'feishu:oc_1:omt_topic_1', created: false })

    // 只带话题首帖 ID（旧客户端只有 root_id）：靠首帖登记过的别名命中
    const byRoot = db.resolveThread({
      source: 'feishu',
      chatId: 'oc_1',
      keys: ['om_x_first', 'om_x_third'],
      canonicalId: 'feishu:oc_1:om_x_third',
      createdAt: AT,
    })
    expect(byRoot).toEqual({ threadId: 'feishu:oc_1:omt_topic_1', created: false })
  })

  it('存量线程保持原 ID，后续话题 ID 只作为别名接进来', () => {
    const db = store()
    // 模拟历史数据：tk 的线程 ID 是 om_ 根消息
    db.upsertThread({ id: 'feishu:oc_1:om_x_root', source: 'feishu', rootId: 'om_x_root', chatId: 'oc_1', createdAt: AT })
    db.registerThreadAlias({ source: 'feishu', alias: 'omt_topic_old', threadId: 'feishu:oc_1:om_x_root', createdAt: AT })

    const resolved = db.resolveThread({
      source: 'feishu',
      chatId: 'oc_1',
      keys: ['omt_topic_old', 'om_x_new'],
      canonicalId: 'feishu:oc_1:omt_topic_old',
      createdAt: AT,
    })
    expect(resolved).toEqual({ threadId: 'feishu:oc_1:om_x_root', created: false })
  })

  it('没有命中时创建新线程，并把所有标识登记为别名', () => {
    const db = store()
    const created = db.resolveThread({
      source: 'feishu',
      chatId: 'oc_2',
      keys: ['omt_topic_2', 'om_x_a', 'om_x_b'],
      canonicalId: 'feishu:oc_2:omt_topic_2',
      createdAt: AT,
    })
    expect(created).toEqual({ threadId: 'feishu:oc_2:omt_topic_2', created: true })

    // 三个标识都能反查到同一个线程
    for (const key of ['omt_topic_2', 'om_x_a', 'om_x_b']) {
      const again = db.resolveThread({
        source: 'feishu',
        chatId: 'oc_2',
        keys: [key],
        canonicalId: `feishu:oc_2:${key}`,
        createdAt: AT,
      })
      expect(again.threadId).toBe('feishu:oc_2:omt_topic_2')
    }
  })

  it('同一消息带多个标识时按传入顺序取优先级最高的，而不是按登记时间', () => {
    const db = store()
    // 历史误拆的线程：消息自身 ID 成了线程根，登记得更早
    db.upsertThread({ id: 'feishu:oc_1:om_x_msg', source: 'feishu', rootId: 'om_x_msg', chatId: 'oc_1', createdAt: '2026-11-01T00:00:00.000Z' })
    db.registerThreadAlias({ source: 'feishu', alias: 'om_x_msg', threadId: 'feishu:oc_1:om_x_msg', createdAt: '2026-11-01T00:00:00.000Z' })
    // 正确的话题线程
    db.upsertThread({ id: 'feishu:oc_1:om_x_root', source: 'feishu', rootId: 'om_x_root', chatId: 'oc_1', createdAt: AT })
    db.registerThreadAlias({ source: 'feishu', alias: 'omt_topic', threadId: 'feishu:oc_1:om_x_root', createdAt: AT })
    db.registerThreadAlias({ source: 'feishu', alias: 'om_x_root', threadId: 'feishu:oc_1:om_x_root', createdAt: AT })

    const resolved = db.resolveThread({
      source: 'feishu',
      chatId: 'oc_1',
      keys: ['omt_topic', 'om_x_msg'],
      canonicalId: 'feishu:oc_1:om_x_msg',
      createdAt: AT,
    })
    expect(resolved).toEqual({ threadId: 'feishu:oc_1:om_x_root', created: false })
  })

  it('不同来源的相同标识互不干扰', () => {
    const db = store()
    db.resolveThread({ source: 'feishu', chatId: 'oc_1', keys: ['same'], canonicalId: 'feishu:oc_1:same', createdAt: AT })
    const other = db.resolveThread({ source: 'github', chatId: 'owner/repo', keys: ['same'], canonicalId: 'github:owner/repo:same', createdAt: AT })
    expect(other).toEqual({ threadId: 'github:owner/repo:same', created: true })
  })

  it('空标识时退回 canonicalId，不写别名', () => {
    const db = store()
    const resolved = db.resolveThread({
      source: 'feishu',
      chatId: 'oc_3',
      keys: [],
      canonicalId: 'feishu:oc_3:om_x_only',
      createdAt: AT,
    })
    expect(resolved).toEqual({ threadId: 'feishu:oc_3:om_x_only', created: true })
    expect(db.listThreadAliases('feishu', 'feishu:oc_3:om_x_only')).toEqual([])
  })
})
describe('话题是否绑在办工单（只读查询）', () => {
  it('别名换算到在办工单才算命中；已关闭与未订阅都不算', () => {
    const db = store()
    db.upsertThread({ id: 'feishu:oc_1:om_root', source: 'feishu', rootId: 'om_root', chatId: 'oc_1', createdAt: AT })
    db.registerThreadAlias({ source: 'feishu', alias: 'omt_topic_1', threadId: 'feishu:oc_1:om_root', createdAt: AT })

    // 线程有了，但还没有工单订阅它
    expect(db.hasLiveTicketForThreadKeys('feishu', ['omt_topic_1'])).toBe(false)

    db.subscribe({ threadId: 'feishu:oc_1:om_root', ticketId: 'tk_1', contextOnly: false, createdAt: AT })
    db.insertTicket({
      id: 'tk_1',
      title: '改登录超时',
      threadId: 'feishu:oc_1:om_root',
      source: 'feishu',
      chatId: 'oc_1',
      mandateId: 'md_1',
      stage: 'running',
      repo: '',
      branch: '',
      prNumber: 0,
      prUrl: '',
      prState: 'none',
      createdAt: AT,
      updatedAt: AT,
    })
    expect(db.hasLiveTicketForThreadKeys('feishu', ['omt_topic_1'])).toBe(true)
    // 消息只带根消息 ID 也能命中：别名表把两个标识收敛到同一条线程
    expect(db.hasLiveTicketForThreadKeys('feishu', ['om_root'])).toBe(false)
    expect(db.hasLiveTicketForThreadKeys('feishu', ['omt_topic_1', 'om_2'])).toBe(true)

    // 工单关闭后不再算绑定
    db.updateTicket({ ...db.getTicket('tk_1')!, stage: 'done', closedAt: AT, updatedAt: AT })
    expect(db.hasLiveTicketForThreadKeys('feishu', ['omt_topic_1'])).toBe(false)
  })

  it('认不出的标识返回 false，且不创建线程', () => {
    const db = store()
    expect(db.hasLiveTicketForThreadKeys('feishu', [])).toBe(false)
    expect(db.hasLiveTicketForThreadKeys('feishu', ['omt_unknown'])).toBe(false)
    expect(db.findThreadIdByAlias('feishu', 'omt_unknown')).toBeNull()
    expect(db.findThreadIdByAlias('feishu', '  ')).toBeNull()
    expect(db.listThreads('feishu')).toEqual([])
  })
})
