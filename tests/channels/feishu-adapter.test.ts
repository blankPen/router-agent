import { describe, expect, it } from 'vitest'
import { FeishuChannel, type FeishuSenderLike } from '#channel/feishu/index.js'
import { chatEntry } from '../../src/config.js'
import type { FeishuConfig } from '#channel/sources/feishu.js'
import type { Trigger } from '#core/model.js'

const cfg: FeishuConfig = {
  chats: [chatEntry('oc_dev'), chatEntry('oc_other', { mode: 'mention' })],
  directMessages: true,
  botOpenIds: ['ou_bot'],
  botNames: ['router-agent'],
}

const runner = {
  async run() {
    return { code: 0, stdout: '{}', stderr: '' }
  },
}

function evt(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 'om_100',
    chat_id: 'oc_dev',
    chat_type: 'group',
    message_type: 'text',
    content: '帮我把登录超时改成 30 秒',
    create_time: '1793896001000',
    sender_id: 'ou_alice',
    sender_type: 'user',
    mentions: [],
    ...over,
  }
}

class FakeSender implements FeishuSenderLike {
  calls: { method: string; target: string; content: string; key: string }[] = []
  async reply(messageId: string, text: string, key: string) {
    this.calls.push({ method: 'reply', target: messageId, content: text, key })
  }
  async send(chatId: string, text: string, key: string) {
    this.calls.push({ method: 'send', target: chatId, content: text, key })
  }
  async sendCard(chatId: string, markdown: string, key: string) {
    this.calls.push({ method: 'sendCard', target: chatId, content: markdown, key })
  }
  async replyCard(messageId: string, markdown: string, key: string) {
    this.calls.push({ method: 'replyCard', target: messageId, content: markdown, key })
  }
  async react() {
    return 're_1'
  }
  async unreact() {}
  async createDocument() {
    return 'https://example.com/doc'
  }
}

function channel(sender = new FakeSender()) {
  return { channel: new FeishuChannel({ config: cfg, reaction: 'OnIt', runner, sender }), sender }
}

describe('飞书通道适配器', () => {
  it('归一化后带上通道实例 ID', () => {
    const { channel: ch } = channel()
    const result = ch.normalize(evt())
    expect(result.trigger?.channelId).toBe('feishu')
    expect(result.trigger?.chatId).toBe('oc_dev')
    expect(result.dropped).toBeUndefined()
  })

  it('未监听的群返回 drop 原因与目标，不产生 Trigger', () => {
    const { channel: ch } = channel()
    const result = ch.normalize(evt({ chat_id: 'oc_stranger' }))
    expect(result.trigger).toBeUndefined()
    expect(result.dropped).toBe('chat:not-monitored')
    expect(result.targetId).toBe('oc_stranger')
  })

  it('图片消息需要入库前富化', () => {
    const { channel: ch } = channel()
    const trigger = ch.normalize(evt({ message_type: 'image', content: '![Image](img_v3_fake) ' })).trigger as Trigger
    expect(ch.needsEnrichment(trigger)).toBe(true)
  })

  it('简单消息按纯文本回复到话题根', async () => {
    const { channel: ch, sender } = channel()
    await ch.send({ channelId: 'feishu', targetId: 'oc_dev', threadRef: 'om_root', text: '已改完', format: 'markdown', idempotencyKey: 'k' })
    expect(sender.calls[0]).toMatchObject({ method: 'reply', target: 'om_root', content: '已改完' })
  })

  it('Markdown 消息按卡片发送', async () => {
    const { channel: ch, sender } = channel()
    await ch.send({ channelId: 'feishu', targetId: 'oc_dev', text: '- A\n- B', format: 'markdown', idempotencyKey: 'k' })
    expect(sender.calls[0]?.method).toBe('sendCard')
  })

  it('回执走配置里的 emoji，关闭时不调用', async () => {
    const sender = new FakeSender()
    const on = new FeishuChannel({ config: cfg, reaction: 'OnIt', runner, sender })
    expect(await on.ack('om_1')).toBe('re_1')
    const off = new FeishuChannel({ config: cfg, reaction: '', runner, sender })
    expect(await off.ack('om_1')).toBeNull()
    expect(off.capabilities.ack).toBe(false)
  })
})
describe('飞书通道的未寻址放行', () => {
  it('注入放行判定后，只 @ 模式群里没 @ 的消息也能归一化', () => {
    const ch = new FeishuChannel({ config: cfg, runner, sender: new FakeSender(), allowUnaddressed: () => true })
    const result = ch.normalize(evt({ chat_id: 'oc_other' }))
    expect(result.trigger).toBeDefined()
    expect(result.trigger?.addressed).toBe('none')
  })

  it('不注入放行判定时行为不变：没 @ 的消息被丢弃', () => {
    const ch = new FeishuChannel({ config: cfg, runner, sender: new FakeSender() })
    const result = ch.normalize(evt({ chat_id: 'oc_other' }))
    expect(result.trigger).toBeUndefined()
    expect(result.dropped).toBe('mention:required')
  })

  it('放行判定拿得到群、发送者与线程标识', () => {
    const seen: { chatId: string; actorId: string; threadKeys: string[] }[] = []
    const ch = new FeishuChannel({
      config: cfg,
      runner,
      sender: new FakeSender(),
      allowUnaddressed: ctx => {
        seen.push(ctx)
        return true
      },
    })
    ch.normalize(evt({ chat_id: 'oc_other', thread_id: 'omt_topic_1' }))
    expect(seen[0]).toMatchObject({ chatId: 'oc_other', actorId: 'ou_alice' })
    expect(seen[0]?.threadKeys).toEqual(['omt_topic_1', 'om_100'])
  })
})
