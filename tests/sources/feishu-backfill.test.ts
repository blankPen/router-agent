import { chatEntry } from '../../src/config.js'
import { describe, expect, it } from 'vitest'
import { backfillChats, backfillCommand, parseFeishuMessageList, type CursorStore } from '../../src/sources/feishu-backfill.js'
import type { FeishuConfig } from '../../src/sources/feishu.js'

const cfg: FeishuConfig = {
  chats: [chatEntry('oc_dev')],
  directMessages: true,
  botOpenIds: ['ou_bot', 'cli_bot'],
  botNames: ['router-agent'],
}

const sample = JSON.stringify({
  ok: true,
  data: {
    has_more: false,
    messages: [
      {
        chat_id: 'oc_dev',
        message_id: 'om_1',
        msg_type: 'text',
        content: '帮我把登录超时改成 30 秒',
        create_time: '2026-11-06 09:58',
        reply_to: 'om_root',
        sender: { id: 'ou_alice', id_type: 'open_id', sender_type: 'user', name: 'Alice' },
      },
      {
        chat_id: 'oc_dev',
        message_id: 'om_2',
        msg_type: 'text',
        content: '已经看到了',
        create_time: '2026-11-06 09:59',
        sender: { id: 'cli_bot', open_bot_id: 'ou_bot', sender_type: 'app', name: 'router-agent' },
      },
      {
        chat_id: 'oc_other',
        message_id: 'om_3',
        msg_type: 'text',
        content: '不在监控范围',
        create_time: '2026-11-06 09:59',
        sender: { id: 'ou_bob', sender_type: 'user', name: 'Bob' },
      },
    ],
  },
})

describe('飞书历史补拉', () => {
  it('把 chat-messages-list 输出归一化成 Trigger，丢弃机器人自己与范围外消息', () => {
    const triggers = parseFeishuMessageList(sample, cfg)
    expect(triggers).toHaveLength(1)
    expect(triggers[0]).toMatchObject({
      externalId: 'om_1',
      threadId: 'feishu:oc_dev:om_root',
      actorId: 'ou_alice',
      isBot: false,
      text: '帮我把登录超时改成 30 秒',
    })
    expect(triggers[0]?.receivedAt).toBe(new Date(2026, 10, 6, 9, 58).toISOString())
  })

  it('兼容 data.items 与裸数组两种返回', () => {
    const items = JSON.stringify({ data: { items: [{ chat_id: 'oc_dev', message_id: 'om_9', msg_type: 'text', content: '你好', create_time: '2026-11-06 10:00', sender: { id: 'ou_alice', sender_type: 'user' } }] } })
    expect(parseFeishuMessageList(items, cfg)).toHaveLength(1)
    const bare = JSON.stringify([{ chat_id: 'oc_dev', message_id: 'om_10', msg_type: 'text', content: '你好', create_time: '2026-11-06 10:00', sender: { id: 'ou_alice', sender_type: 'user' } }])
    expect(parseFeishuMessageList(bare, cfg)).toHaveLength(1)
  })

  it('非法输出返回空数组而不是抛错', () => {
    expect(parseFeishuMessageList('not json', cfg)).toEqual([])
  })

  it('补拉命令使用 chat-id 与 json 输出', () => {
    const argv = backfillCommand('oc_dev', '2026-11-06T00:00:00.000Z')
    expect(argv.slice(0, 3)).toEqual(['im', '+chat-messages-list', '--chat-id'])
    expect(argv).toContain('--format')
    expect(argv).toContain('json')
  })

  it('时间窗用 --start（ISO 8601），不是 --start-time', () => {
    const argv = backfillCommand('oc_dev', '2026-11-06T00:00:00.000Z')
    expect(argv).toContain('--start')
    expect(argv).not.toContain('--start-time')
    expect(argv[argv.indexOf('--start') + 1]).toBe('2026-11-06T00:00:00.000Z')
  })
})

class ScriptedRunner {
  calls: string[][] = []
  constructor(private responses: { code: number; stdout: string; stderr: string }[]) {}
  async run(argv: string[]) {
    this.calls.push(argv)
    return this.responses.shift() ?? { code: 0, stdout: '{"data":{"messages":[]}}', stderr: '' }
  }
}

function cursors(): CursorStore & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    get: key => values.get(key) ?? null,
    set: (key, value) => { values.set(key, value) },
  }
}

function messages(payload: { id: string; at: string; text?: string }[]): string {
  return JSON.stringify({
    ok: true,
    data: {
      messages: payload.map(item => ({
        chat_id: 'oc_dev',
        message_id: item.id,
        msg_type: 'text',
        content: item.text ?? '把登录超时改成 30 秒',
        create_time: item.at,
        sender: { id: 'ou_alice', sender_type: 'user', name: 'Alice' },
      })),
    },
  })
}

describe('飞书历史补拉：游标与首跑基线', () => {
  it('首次运行只记基线，不把历史消息当新需求', async () => {
    const runner = new ScriptedRunner([{ code: 0, stdout: messages([{ id: 'om_new', at: '2026-11-06 10:00' }]), stderr: '' }])
    const store = cursors()

    const result = await backfillChats({ runner, chats: ['oc_dev'], cfg, cursors: store })

    expect(result.triggers).toEqual([])
    expect(result.baselined).toEqual(['oc_dev'])
    expect(store.values.get('feishu:history:oc_dev')).toBe(String(Date.parse('2026-11-06T10:00:00')))
    // 基线取的是最新一条，不是最早一条
    expect(runner.calls[0]).toContain('desc')
    expect(runner.calls[0]![runner.calls[0]!.indexOf('--page-size') + 1]).toBe('1')
  })

  it('有游标时按游标增量补拉，并推进到最新一条', async () => {
    const cursor = String(Date.parse('2026-11-06T10:00:00'))
    const runner = new ScriptedRunner([{
      code: 0,
      stdout: messages([{ id: 'om_2', at: '2026-11-06 10:05' }, { id: 'om_3', at: '2026-11-06 10:07' }]),
      stderr: '',
    }])
    const store = cursors()
    store.values.set('feishu:history:oc_dev', cursor)

    const result = await backfillChats({ runner, chats: ['oc_dev'], cfg, cursors: store, skewMs: 5000 })

    expect(result.triggers.map(t => t.externalId)).toEqual(['om_2', 'om_3'])
    expect(result.baselined).toEqual([])
    expect(store.values.get('feishu:history:oc_dev')).toBe(String(Date.parse('2026-11-06T10:07:00')))
    const start = runner.calls[0]![runner.calls[0]!.indexOf('--start') + 1]
    expect(start).toBe(new Date(Number(cursor) - 5000).toISOString())
  })

  it('补拉失败时不动游标', async () => {
    const runner = new ScriptedRunner([{ code: 1, stdout: '', stderr: 'boom' }])
    const store = cursors()
    store.values.set('feishu:history:oc_dev', '1000')

    const result = await backfillChats({ runner, chats: ['oc_dev'], cfg, cursors: store })

    expect(result.triggers).toEqual([])
    expect(store.values.get('feishu:history:oc_dev')).toBe('1000')
  })
})
