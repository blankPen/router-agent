import { describe, expect, it } from 'vitest'
import { FeishuChannel, type FeishuSenderLike } from '@router-agent/channel-feishu'
import { chatEntry } from '../../src/config.js'
import type { FeishuConfig } from '@router-agent/channel-feishu'
import type { Trigger } from '#core/model.js'
import { buildQuestionCard, buildReplyCard, normalizeCardAction } from '../../packages/channel-feishu/src/sources/feishu-reply.js'

const cfg: FeishuConfig = {
  chats: [chatEntry('oc_dev'), chatEntry('oc_other', { scope: 'mention' })],
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
  async sendReply(chatId: string, payload: { fallbackText: string }, key: string) {
    this.calls.push({ method: 'sendReply', target: chatId, content: payload.fallbackText, key })
  }
  async replyReply(messageId: string, payload: { fallbackText: string }, key: string) {
    this.calls.push({ method: 'replyReply', target: messageId, content: payload.fallbackText, key })
  }
  async updateQuestionCard() {}
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
  it('卡片回调消费者启动失败时回调 onError 并记 warn，便于降级按钮', async () => {
    const logs: { message: string; extra?: Record<string, unknown> }[] = []
    const errors: Error[] = []
    const ch = new FeishuChannel({
      config: cfg,
      runner,
      sender: new FakeSender(),
      cardActions: true,
      bin: '/nonexistent/lark-cli-for-test',
      logger: {
        info: () => {},
        warn: (message, extra) => logs.push({ message, ...(extra ? { extra } : {}) }),
        error: () => {},
      },
    })
    await ch.startCardActions(() => {}, { onError: error => errors.push(error) })
    await new Promise(resolve => setImmediate(resolve))
    ch.stopCardActions()

    expect(errors.some(error => error.message.includes('spawn-failed'))).toBe(true)
    expect(logs).toContainEqual({
      message: 'feishu:card-consumer-error',
      extra: { detail: expect.stringContaining('spawn-failed') },
    })
  })

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

describe('飞书富回复', () => {
  it('有结构化块时走卡片发送，而不是把块序列化成文本', async () => {
    const sender = new FakeSender()
    const ch = new FeishuChannel({ config: cfg, runner, sender })
    await ch.send({
      channelId: 'feishu',
      targetId: 'oc_dev',
      text: '兜底正文',
      blocks: [{ type: 'markdown', text: '## 结果\n- A' }],
      format: 'markdown',
      idempotencyKey: 'reply:1',
    })

    expect(sender.calls.at(-1)).toMatchObject({ method: 'sendReply', target: 'oc_dev', key: 'reply:1' })
  })

  it('对比图块上传成功后渲染成两张 img，图注保留 Before / After', () => {
    const images = new Map([
      ['./before.png', { imgKey: 'img_before' }],
      ['./after.png', { imgKey: 'img_after' }],
    ])
    const card = buildReplyCard({
      payload: {
        blocks: [{ type: 'imagePair', before: { path: './before.png' }, after: { path: './after.png' }, caption: '1440×900' }],
        fallbackText: '图片',
      },
      images,
    })
    const elements = card.elements as Record<string, unknown>[]
    expect(elements).toContainEqual({ tag: 'img', img_key: 'img_before', alt: { tag: 'plain_text', content: 'Before' } })
    expect(elements).toContainEqual({ tag: 'img', img_key: 'img_after', alt: { tag: 'plain_text', content: 'After' } })
    expect(elements.some(element => String(element.content ?? '').includes('同一视口'))).toBe(true)
  })

  it('图片上传失败只把那一块降级为文字，不让整条卡片失败', () => {
    const card = buildReplyCard({
      payload: { blocks: [{ type: 'image', image: { path: './missing.png' }, caption: '登录页' }], fallbackText: '图' },
      images: new Map([['./missing.png', { failed: true }]]),
    })
    const elements = card.elements as Record<string, unknown>[]
    expect(elements.some(element => String(element.content ?? '').includes('图片上传失败'))).toBe(true)
  })

  it('卡片字段用 div 容器渲染，fields 数组不被拆散', () => {
    const card = buildReplyCard({
      payload: {
        blocks: [{
          type: 'card',
          title: '部署结果',
          fields: [{ label: '环境', value: 'staging' }],
        }],
        fallbackText: '部署结果',
      },
      images: new Map(),
    })
    const field = (card.elements as Record<string, unknown>[]).find(element => Array.isArray(element.fields))
    expect(field?.tag).toBe('div')
    expect(field?.fields).toEqual([{
      is_short: false,
      text: { tag: 'lark_md', content: '**环境**\nstaging' },
    }])
  })

  it('回调模式的选择题生成按钮，value 里带 questionId 与 optionId', () => {
    const card = buildReplyCard({
      payload: {
        blocks: [{
          type: 'choices',
          questionId: 'q_tk-1_2',
          prompt: '选哪个？',
          options: [{ id: 'A', label: '方案 A' }, { id: 'B', label: '方案 B' }],
          mode: 'callback',
        }],
        fallbackText: '选哪个？',
      },
      images: new Map(),
    })
    const action = (card.elements as Record<string, unknown>[]).find(element => element.tag === 'action')
    expect((action?.actions as Record<string, unknown>[])[0]?.value).toEqual({ questionId: 'q_tk-1_2', optionId: 'A' })
  })

  it('文本模式的选择题不生成按钮，题面写序号', () => {
    const card = buildReplyCard({
      payload: {
        blocks: [{
          type: 'choices',
          questionId: 'q_tk-1_2',
          prompt: '选哪个？',
          options: [{ id: 'A', label: '方案 A' }, { id: 'B', label: '方案 B' }],
          mode: 'text',
        }],
        fallbackText: '选哪个？',
      },
      images: new Map(),
    })
    expect((card.elements as Record<string, unknown>[]).some(element => element.tag === 'action')).toBe(false)
    expect((card.elements as Record<string, unknown>[]).some(element => String(element.content ?? '').includes('1. 方案 A'))).toBe(true)
  })

  it('卡片回调事件解析出操作人、消息与按钮 value', () => {
    const action = normalizeCardAction({
      type: 'card.action.trigger',
      event_id: 'ev_1',
      chat_id: 'oc_dev',
      message_id: 'om_card',
      operator_id: 'ou_alice',
      token: 'tok_1',
      action_tag: 'button',
      action_value: '{"questionId":"q_1","optionId":"A"}',
    })

    expect(action).toMatchObject({
      id: 'ev_1', channelId: 'feishu', chatId: 'oc_dev', messageId: 'om_card',
      operatorId: 'ou_alice', token: 'tok_1', value: { questionId: 'q_1', optionId: 'A' },
    })
  })

  it('已答卡片回写成「已选择」，不再带按钮', () => {
    const card = buildQuestionCard({
      token: 'tok_1',
      operatorId: 'ou_alice',
      question: { id: 'q_1', prompt: '选哪个？', options: [{ id: 'A', label: '方案 A' }, { id: 'B', label: '方案 B' }] },
      selected: ['A'],
    })
    expect(card.header).toMatchObject({ template: 'green' })
    expect((card.elements as Record<string, unknown>[]).some(element => element.tag === 'action')).toBe(false)
    expect((card.elements as Record<string, unknown>[]).some(element => String(element.content ?? '').includes('已选择：方案 A'))).toBe(true)
  })
})
describe('飞书通道的未寻址放行', () => {
  it('范围判定拒绝后，放行判定能救回没 @ 的消息', () => {
    const ch = new FeishuChannel({ config: cfg, runner, sender: new FakeSender(), allowUnaddressed: () => true, admitMessage: () => false })
    const result = ch.normalize(evt({ chat_id: 'oc_other' }))
    expect(result.trigger).toBeDefined()
    expect(result.trigger?.addressed).toBe('none')
  })

  it('范围判定拒绝且没有放行判定时，消息被丢弃', () => {
    const ch = new FeishuChannel({ config: cfg, runner, sender: new FakeSender(), admitMessage: () => false })
    const result = ch.normalize(evt({ chat_id: 'oc_other' }))
    expect(result.trigger).toBeUndefined()
    expect(result.dropped).toBe('scope:excluded')
  })

  it('不注入范围判定时通道不做准入：消息照常进领域', () => {
    const ch = new FeishuChannel({ config: cfg, runner, sender: new FakeSender() })
    const result = ch.normalize(evt({ chat_id: 'oc_other' }))
    expect(result.trigger).toBeDefined()
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
      admitMessage: () => false,
    })
    ch.normalize(evt({ chat_id: 'oc_other', thread_id: 'omt_topic_1' }))
    expect(seen[0]).toMatchObject({ chatId: 'oc_other', actorId: 'ou_alice' })
    expect(seen[0]?.threadKeys).toEqual(['omt_topic_1', 'om_100'])
  })
})
