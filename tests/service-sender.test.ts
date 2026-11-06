import { describe, expect, it } from 'vitest'
import { createEffectsSender, type FeishuOutbound } from '../src/service.js'

class FakeOutbound implements FeishuOutbound {
  calls: { method: string; target: string; content: string; key: string }[] = []

  async reply(messageId: string, text: string, key: string): Promise<void> {
    this.calls.push({ method: 'reply', target: messageId, content: text, key })
  }

  async send(chatId: string, text: string, key: string): Promise<void> {
    this.calls.push({ method: 'send', target: chatId, content: text, key })
  }

  async sendCard(chatId: string, markdown: string, key: string): Promise<void> {
    this.calls.push({ method: 'sendCard', target: chatId, content: markdown, key })
  }

  async replyCard(messageId: string, markdown: string, key: string): Promise<void> {
    this.calls.push({ method: 'replyCard', target: messageId, content: markdown, key })
  }
}

function item(over: Partial<{ channelKind: string; channelId: string; threadId: string; text: string; key: string }> = {}) {
  return {
    channelKind: 'feishu',
    channelId: 'oc_dev',
    threadId: '',
    text: '已改完',
    key: 'k',
    ...over,
  }
}

describe('回复投递形态', () => {
  it('简单消息回话题时走纯文本 reply', async () => {
    const sender = new FakeOutbound()
    await createEffectsSender(sender).send(item({ threadId: 'om_root', text: '已帮你创建工单「登录超时」。' }))
    expect(sender.calls).toHaveLength(1)
    expect(sender.calls[0]!.method).toBe('reply')
    expect(sender.calls[0]!.content).toBe('已帮你创建工单「登录超时」。')
  })

  it('简单消息发普通消息时走纯文本 send', async () => {
    const sender = new FakeOutbound()
    await createEffectsSender(sender).send(item({ text: '暂不自动开工。' }))
    expect(sender.calls[0]!.method).toBe('send')
    expect(sender.calls[0]!.target).toBe('oc_dev')
  })

  it('带 Markdown 的消息回话题时走卡片，并保留原文交给 Sender 归一化', async () => {
    const sender = new FakeOutbound()
    const text = '## 结果\n- 已改完\n- 待验证'
    await createEffectsSender(sender).send(item({ threadId: 'om_root', text }))
    expect(sender.calls[0]!.method).toBe('replyCard')
    expect(sender.calls[0]!.content).toBe(text)
  })

  it('带 Markdown 的消息发普通消息时走卡片 sendCard', async () => {
    const sender = new FakeOutbound()
    await createEffectsSender(sender).send(item({ text: '- A\n- B' }))
    expect(sender.calls[0]!.method).toBe('sendCard')
  })

  it('非飞书渠道与空正文不投递', async () => {
    const sender = new FakeOutbound()
    await createEffectsSender(sender).send(item({ channelKind: 'other' }))
    await createEffectsSender(sender).send(item({ text: '   ' }))
    expect(sender.calls).toHaveLength(0)
  })
})