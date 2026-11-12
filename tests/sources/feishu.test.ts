import { chatEntry } from '../../src/config.js'
import { describe, expect, it } from 'vitest'
import { attachQuotedMessage, FeishuSender, feishuCard, feishuCardSendCommand, feishuCreateDocCommand, feishuReactionCommand, fitIdempotencyKey, normalizeCardMarkdown, normalizeFeishuEvent, normalizeFeishuEventDetailed, parseDocumentUrl, parseMessageThreadIds, parseQuotedMessage, quotedMessageCommand, shouldSendAsText, type FeishuConfig, type UnaddressedContext } from '../../src/sources/feishu.js'

const cfg: FeishuConfig = {
  chats: [chatEntry('oc_dev'), chatEntry('oc_other', { mode: 'mention' })],
  directMessages: true,
  botOpenIds: ['ou_bot'],
  botNames: ['router-agent'],
}

function evt(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'im.message.receive_v1',
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

class RecordingRunner {
  calls: string[][] = []
  fail = false
  response = '{}'
  async run(argv: string[]) {
    this.calls.push(argv)
    return this.fail ? { code: 1, stdout: '', stderr: 'boom' } : { code: 0, stdout: this.response, stderr: '' }
  }
}

describe('回执表情', () => {
  it('生成 reactions create 命令，body 带 emoji_type', () => {
    const argv = feishuReactionCommand('om_1', 'OK')
    expect(argv.slice(0, 3)).toEqual(['im', 'reactions', 'create'])
    expect(argv).toContain('--message-id')
    expect(argv).toContain('om_1')
    expect(JSON.parse(argv[argv.indexOf('--data') + 1]!)).toEqual({ reaction_type: { emoji_type: 'OK' } })
  })

  it('react 返回 reaction_id；空表情跳过；失败抛出可读错误', async () => {
    const runner = new RecordingRunner()
    runner.response = JSON.stringify({ ok: true, data: { reaction_id: 're_1' } })
    const sender = new FeishuSender(runner as never)
    expect(await sender.react('om_1', 'Typing')).toBe('re_1')
    expect(runner.calls[0]).toEqual(feishuReactionCommand('om_1', 'Typing'))
    expect(await sender.react('om_1', '')).toBeNull()
    expect(runner.calls).toHaveLength(1)

    runner.fail = true
    await expect(sender.react('om_2', 'Typing')).rejects.toThrow(/react-failed/)
  })

  it('unreact 用 reaction_id 撤销表情', async () => {
    const runner = new RecordingRunner()
    const sender = new FeishuSender(runner as never)
    await sender.unreact('om_1', 're_1')
    expect(runner.calls[0]).toEqual(['im', 'reactions', 'delete', '--message-id', 'om_1', '--reaction-id', 're_1', '--as', 'bot', '--json'])
  })
})

describe('飞书事件归一化', () => {
  it('监控群里的消息被转成 Trigger，线程按根消息归并', () => {
    const t = normalizeFeishuEvent(evt({ root_id: 'om_root' }), cfg)!
    expect(t).toMatchObject({
      source: 'feishu',
      externalId: 'om_100',
      threadId: 'feishu:oc_dev:om_root',
      chatId: 'oc_dev',
      actorId: 'ou_alice',
      isBot: false,
      addressed: 'none',
      disposition: 'pending',
    })
    expect(t.text).toBe('帮我把登录超时改成 30 秒')
  })

  it('没有 root_id 时自身消息即线程根', () => {
    expect(normalizeFeishuEvent(evt(), cfg)!.threadId).toBe('feishu:oc_dev:om_100')
  })

  it('@机器人 被识别为 mention；私聊被识别为 direct', () => {
    expect(normalizeFeishuEvent(evt({ mentions: [{ id: 'ou_bot', name: 'router-agent' }] }), cfg)!.addressed).toBe('mention')
    expect(normalizeFeishuEvent(evt({ chat_type: 'p2p', chat_id: 'oc_dm' }), cfg)!.addressed).toBe('direct')
  })

  it('机器人自己的消息被丢弃', () => {
    expect(normalizeFeishuEvent(evt({ sender_id: 'ou_bot', sender_type: 'bot' }), cfg)).toBeNull()
  })

  it('其它机器人保留为 isBot，交策略层判断', () => {
    const t = normalizeFeishuEvent(evt({ sender_id: 'ou_ci', sender_type: 'bot' }), cfg)!
    expect(t.isBot).toBe(true)
  })

  it('未监控的群直接丢弃', () => {
    expect(normalizeFeishuEvent(evt({ chat_id: 'oc_stranger' }), cfg)).toBeNull()
  })

  it('关闭私聊时丢弃 p2p 消息', () => {
    expect(normalizeFeishuEvent(evt({ chat_type: 'p2p', chat_id: 'oc_dm' }), { ...cfg, directMessages: false })).toBeNull()
  })

  it('非文本消息用预渲染 content，空内容丢弃', () => {
    expect(normalizeFeishuEvent(evt({ message_type: 'post', content: '图片描述' }), cfg)!.text).toBe('图片描述')
    expect(normalizeFeishuEvent(evt({ content: '   ' }), cfg)).toBeNull()
  })

  it('系统消息与互动卡片不进入领域', () => {
    // system：建群 / 拉人 / 改群名，都是噪音；interactive：content 是原始卡片 JSON，不能当需求。
    expect(normalizeFeishuEventDetailed(evt({ message_type: 'system', content: '阿振(Pz) started the group chat.' }), cfg))
      .toMatchObject({ dropped: 'system-message' })
    expect(normalizeFeishuEventDetailed(evt({ message_type: 'interactive', content: '{"title":"聊完了","elements":[]}' }), cfg))
      .toMatchObject({ dropped: 'card-message' })
  })

  it('附件消息保留预渲染文本，但标记 mediaOnly', () => {
    const image = normalizeFeishuEvent(evt({ message_type: 'image', content: '[图片]' }), cfg)!
    expect(image.mediaOnly).toBe(true)
    expect(image.text).toBe('[图片]')
    expect(normalizeFeishuEvent(evt({ message_type: 'file', content: '报告.pdf' }), cfg)!.mediaOnly).toBe(true)
    expect(normalizeFeishuEvent(evt({ message_type: 'sticker', content: '[表情]' }), cfg)!.mediaOnly).toBe(true)
    expect(normalizeFeishuEvent(evt(), cfg)!.mediaOnly).toBe(false)
    expect(normalizeFeishuEvent(evt({ message_type: 'post', content: '有文字的富文本' }), cfg)!.mediaOnly).toBe(false)
  })

  it('图片消息在 raw 里记下 messageType 和 image_key，供入库前下载转文本', () => {
    const image = normalizeFeishuEvent(evt({ message_type: 'image', content: '![Image](img_v3_abc)' }), cfg)!
    expect(image.raw).toMatchObject({ messageType: 'image', imageKeys: ['img_v3_abc'] })
    // 预渲染成 [图片]、拿不到 key 时也保留 messageType，后续走 mget 回查
    expect(normalizeFeishuEvent(evt({ message_type: 'image', content: '[图片]' }), cfg)!.raw).toMatchObject({ messageType: 'image' })
    const post = normalizeFeishuEvent(evt({ message_type: 'post', content: '看下 ![Image](img_v3_post)' }), cfg)!
    expect(post.raw).toMatchObject({ messageType: 'post', imageKeys: ['img_v3_post'] })
    // 纯文本消息不带这些字段，避免把正文里的字面量当图片
    expect(normalizeFeishuEvent(evt({ content: '![Image](img_v3_fake)' }), cfg)!.raw).toEqual({})
  })

  it('被丢弃的消息带上原因，便于日志追踪', () => {
    expect(normalizeFeishuEventDetailed(evt({ chat_id: 'oc_stranger' }), cfg)).toEqual({ dropped: 'chat:not-monitored', chatId: 'oc_stranger' })
    expect(normalizeFeishuEventDetailed(evt({ chat_type: 'p2p', chat_id: 'oc_dm' }), { ...cfg, directMessages: false })).toMatchObject({ dropped: 'dm:disabled' })
    expect(normalizeFeishuEventDetailed(evt({ sender_id: 'ou_bot', sender_type: 'bot' }), cfg)).toMatchObject({ dropped: 'sender:self' })
    expect(normalizeFeishuEventDetailed(evt({ chat_id: 'oc_only_at' }), { ...cfg, chats: [chatEntry('oc_only_at', { mode: 'mention' })] })).toMatchObject({ dropped: 'mention:required' })
    expect(normalizeFeishuEventDetailed(evt({ content: '   ' }), cfg)).toMatchObject({ dropped: 'empty-content' })
    expect(normalizeFeishuEventDetailed(evt(), cfg).trigger?.externalId).toBe('om_100')
  })

  it('时间戳转成 ISO，非法时间回退到当前时间', () => {
    expect(normalizeFeishuEvent(evt(), cfg)!.receivedAt).toMatch(/^20\d\d-\d\d-\d\dT/)
    expect(normalizeFeishuEvent(evt({ create_time: 'abc' }), cfg)!.receivedAt).toMatch(/^20\d\d-/)
  })
})

describe('线程归属（话题 ID 参与别名收敛）', () => {
  it('话题内直接回复：只有 thread_id、没有 root_id，话题 ID 也要带进别名', () => {
    // 实测飞书：在话题面板里直接发言时 root_id / parent_id 都为空，只有 thread_id。
    // 规范 ID 仍用可回复的消息 ID，话题 ID 交给 Store 别名收敛到已有线程。
    const t = normalizeFeishuEvent(evt({ thread_id: 'omt_topic_1' }), cfg)!
    expect(t.threadId).toBe('feishu:oc_dev:om_100')
    expect(t.threadKeys).toEqual(['omt_topic_1', 'om_100'])
  })

  it('话题内引用回复：别名同时登记话题 ID 与被引用消息', () => {
    const t = normalizeFeishuEvent(evt({ thread_id: 'omt_topic_1', root_id: 'om_quoted', parent_id: 'om_quoted' }), cfg)!
    expect(t.threadId).toBe('feishu:oc_dev:om_quoted')
    expect(t.threadKeys).toEqual(['omt_topic_1', 'om_quoted', 'om_100'])
  })

  it('普通群引用回复：没有 thread_id 时按 root_id 归并', () => {
    const t = normalizeFeishuEvent(evt({ root_id: 'om_root' }), cfg)!
    expect(t.threadId).toBe('feishu:oc_dev:om_root')
    expect(t.threadKeys).toEqual(['om_root', 'om_100'])
  })

  it('没有 thread_id 也没有 root_id：消息自身即线程根', () => {
    const t = normalizeFeishuEvent(evt(), cfg)!
    expect(t.threadId).toBe('feishu:oc_dev:om_100')
    expect(t.threadKeys).toEqual(['om_100'])
  })

  it('话题内直接发言：飞书自动填的 reply_to=root_id 不算引用（tk-51）', () => {
    // 实测飞书：在话题里直接发言时，会把 reply_to / parent_id 填成话题根消息。
    // 这不是用户主动引用，拿它回查正文会让每条回复都拼上根消息。
    const t = normalizeFeishuEvent(evt({ thread_id: 'omt_topic_1', root_id: 'om_root', reply_to: 'om_root' }), cfg)!
    expect(t.raw).not.toHaveProperty('parentId')
    expect(t.raw).toMatchObject({ quoteIgnored: 'om_root' })
    expect(t.text).toBe('帮我把登录超时改成 30 秒')
  })

  it('话题内真正引用另一条消息时仍然回查正文', () => {
    const t = normalizeFeishuEvent(evt({ thread_id: 'omt_topic_1', root_id: 'om_root', reply_to: 'om_quoted' }), cfg)!
    expect(t.raw).toMatchObject({ parentId: 'om_quoted' })
  })

  it('线程标识去重：root_id 与 message_id 相同时不重复登记', () => {
    const t = normalizeFeishuEvent(evt({ root_id: 'om_100' }), cfg)!
    expect(t.threadKeys).toEqual(['om_100'])
  })
})

describe('线程标识回查', () => {
  it('从 mget 输出里取每条消息的 thread_id', () => {
    const map = parseMessageThreadIds(JSON.stringify({
      ok: true,
      data: {
        messages: [
          { message_id: 'om_a', thread_id: 'omt_1' },
          { message_id: 'om_b' },
          { message_id: 'om_c', thread_id: 'omt_2' },
        ],
      },
    }))
    expect([...map.entries()]).toEqual([['om_a', 'omt_1'], ['om_c', 'omt_2']])
  })

  it('输出不是 JSON 或没有 messages 时返回空表，不抛错', () => {
    expect(parseMessageThreadIds('not json').size).toBe(0)
    expect(parseMessageThreadIds(JSON.stringify({ ok: true, data: {} })).size).toBe(0)
  })
})

describe('飞书文档交付', () => {
  it('正文走 stdin，避免超长参数和转义问题', async () => {
    const calls: { argv: string[]; input?: string }[] = []
    const sender = new FeishuSender({
      async run(argv, opts) {
        calls.push({ argv, ...(opts?.input !== undefined ? { input: opts.input } : {}) })
        return { code: 0, stdout: JSON.stringify({ ok: true, data: { document: { url: 'https://x.feishu.cn/docx/abc' } } }), stderr: '' }
      },
    })

    const url = await sender.createDocument('可优化点清单', '# 全文')

    expect(url).toBe('https://x.feishu.cn/docx/abc')
    expect(calls[0]!.argv).toEqual(feishuCreateDocCommand('可优化点清单'))
    expect(calls[0]!.argv).toContain('-')
    expect(calls[0]!.input).toBe('# 全文')
  })

  it('创建失败时抛错，交给上层降级为长消息', async () => {
    const sender = new FeishuSender({ async run() { return { code: 1, stdout: '', stderr: 'missing scope' } } })
    await expect(sender.createDocument('t', 'x')).rejects.toThrow(/doc-create-failed/)
  })

  it('兼容不同层级的返回结构', () => {
    expect(parseDocumentUrl(JSON.stringify({ data: { document: { url: 'u1' } } }))).toBe('u1')
    expect(parseDocumentUrl(JSON.stringify({ document: { url: 'u2' } }))).toBe('u2')
    expect(parseDocumentUrl('not-json')).toBe('')
  })
})

describe('卡片消息', () => {
  /** 取出 `--flag=value` 形式的参数值。 */
  function valueOf(argv: string[], flag: string): string {
    const hit = argv.find(item => item.startsWith(`${flag}=`))
    if (hit === undefined) throw new Error(`argv 缺少 ${flag}: ${argv.join(' ')}`)
    return hit.slice(flag.length + 1)
  }

  it('把 Markdown 包成 interactive 卡片，不再发源码文本', () => {
    const card = JSON.parse(feishuCard('## 标题\n- A\n- B'))
    expect(card.elements[0]).toEqual({ tag: 'markdown', content: '**标题**\n- A\n- B' })
    expect(card.config.wide_screen_mode).toBe(true)
  })

  it('卡片内 Markdown 归一化：标题、引用、表格、任务列表、图片、换行标签', () => {
    const markdown = [
      '# 总览',
      '> 引用一段说明',
      '| 名称 | 状态 |',
      '| --- | --- |',
      '| router | 完成 |',
      '| worker | 进行中 |',
      '- [x] 已修完',
      '- [ ] 待验证',
      '![架构图](https://example.com/a.png)',
      '第一行<br>第二行',
    ].join('\n')
    const content = normalizeCardMarkdown(markdown)
    expect(content).toContain('**总览**')
    expect(content).not.toContain('# 总览')
    expect(content).toContain('▍引用一段说明')
    expect(content).toContain('**名称** · **状态**')
    expect(content).toContain('- router · 完成')
    expect(content).toContain('- ☑ 已修完')
    expect(content).toContain('- ☐ 待验证')
    expect(content).toContain('[架构图](https://example.com/a.png)')
    expect(content).toContain('第一行\n第二行')
  })

  it('归一化不碰代码块里的内容，并压缩多余空行', () => {
    const content = normalizeCardMarkdown('# 标题\n\n\n```bash\n# 这是注释\n| a | b |\n```')
    expect(content.startsWith('**标题**')).toBe(true)
    expect(content).toContain('```bash\n# 这是注释\n| a | b |\n```')
    expect(content).not.toContain('\n\n\n')
  })

  it('发送走 --msg-type interactive，正文直接放在 --content 参数里', async () => {
    const calls: { argv: string[]; input?: string }[] = []
    const sender = new FeishuSender({
      async run(argv, opts) {
        calls.push({ argv, ...(opts?.input !== undefined ? { input: opts.input } : {}) })
        return { code: 0, stdout: '{}', stderr: '' }
      },
    })
    await sender.sendCard('oc_dev', '**粗体**', 'k')
    const argv = calls[0]!.argv
    expect(argv).toEqual(feishuCardSendCommand('oc_dev', feishuCard('**粗体**'), 'k'))
    expect(argv).toContain('interactive')
    // lark-cli 的 im 命令不读 stdin，正文必须落到参数值上
    expect(valueOf(argv, '--content')).not.toBe('-')
    expect(JSON.parse(valueOf(argv, '--content')).elements[0].content).toBe('**粗体**')
    expect(calls[0]!.input).toBeUndefined()
  })

  it('卡片失败时自动降级为 post markdown', async () => {
    const argvList: string[][] = []
    let n = 0
    const sender = new FeishuSender({
      async run(argv) {
        argvList.push(argv)
        n += 1
        return n === 1 ? { code: 1, stdout: '', stderr: 'bad card' } : { code: 0, stdout: '{}', stderr: '' }
      },
    })
    await sender.sendCard('oc_dev', '内容', 'k')
    expect(argvList[1]!.join(' ')).toContain('--markdown')
  })

  it('卡片降级为 post markdown 时正文是原文，不是 "-" 占位', async () => {
    const argvList: string[][] = []
    let n = 0
    const sender = new FeishuSender({
      async run(argv) {
        argvList.push(argv)
        n += 1
        return n === 1 ? { code: 1, stdout: '', stderr: 'bad card' } : { code: 0, stdout: '{}', stderr: '' }
      },
    })
    await sender.sendCard('oc_dev', '真实正文', 'k')
    expect(valueOf(argvList[1]!, '--markdown')).toBe('真实正文')
  })

  it('话题回复的卡片与富文本同样直接带正文', async () => {
    const argvList: string[][] = []
    let n = 0
    const sender = new FeishuSender({
      async run(argv) {
        argvList.push(argv)
        n += 1
        return n === 1 ? { code: 1, stdout: '', stderr: 'bad card' } : { code: 0, stdout: '{}', stderr: '' }
      },
    })
    await sender.replyCard('om_x1', '真实正文', 'k')
    const card = argvList[0]!
    const fallback = argvList[1]!
    expect(valueOf(card, '--content')).not.toBe('-')
    expect(JSON.parse(valueOf(card, '--content')).elements[0].content).toBe('真实正文')
    expect(valueOf(fallback, '--markdown')).toBe('真实正文')
  })

  it('正文以 "---" 开头时用等号传参，不会被当成 flag', async () => {
    const calls: string[][] = []
    const sender = new FeishuSender({
      async run(argv) {
        calls.push(argv)
        return { code: 0, stdout: '{}', stderr: '' }
      },
    })
    await sender.send('oc_dev', '---\n分隔线', 'k')
    await sender.reply('om_x1', '---\n分隔线', 'k2')
    expect(valueOf(calls[0]!, '--text')).toBe('---\n分隔线')
    expect(valueOf(calls[1]!, '--text')).toBe('---\n分隔线')
  })
})

describe('消息形态分流', () => {
  it('单行、无 Markdown、长度可控的回复走纯文本', () => {
    expect(shouldSendAsText('已帮你创建工单「登录超时」，后续进展会在这个话题里更新。')).toBe(true)
    expect(shouldSendAsText('PR：https://github.com/o/r/pull/42')).toBe(true)
    expect(shouldSendAsText('  已改完  ')).toBe(true)
  })

  it('带 Markdown、多行或超长的回复走卡片', () => {
    expect(shouldSendAsText('**已改完**，请验证')).toBe(false)
    expect(shouldSendAsText('- 先改 A\n- 再改 B')).toBe(false)
    expect(shouldSendAsText('`npm test` 已通过')).toBe(false)
    expect(shouldSendAsText('[PR](https://github.com/o/r/pull/42) 已开')).toBe(false)
    expect(shouldSendAsText('## 标题')).toBe(false)
    expect(shouldSendAsText('一'.repeat(201))).toBe(false)
    expect(shouldSendAsText('   ')).toBe(false)
  })
})

describe('幂等 key', () => {
  it('短 key 原样保留', () => {
    expect(fitIdempotencyKey('ack:tk_1')).toBe('ack:tk_1')
  })

  it('超过 50 字符时压缩，且同一输入稳定、不同输入不碰撞', () => {
    const long = 'ready:tk_c2ff9054-84db-4f0a-bff2-84b192ee8e74:1:2026-11-06T06:34:14Z'
    const fitted = fitIdempotencyKey(long)
    expect(fitted.length).toBeLessThanOrEqual(50)
    expect(fitIdempotencyKey(long)).toBe(fitted)
    expect(fitIdempotencyKey(`${long}x`)).not.toBe(fitted)
  })

  it('发送时使用压缩后的 key', async () => {
    const keys: string[] = []
    const sender = new FeishuSender({
      async run(argv) {
        keys.push(argv[argv.indexOf('--idempotency-key') + 1]!)
        return { code: 0, stdout: '{}', stderr: '' }
      },
    })
    await sender.send('oc_dev', 'hi', 'ready:tk_0123456789abcdef0123456789abcdef:12:2026-11-06T06:34:14Z')
    expect(keys[0]!.length).toBeLessThanOrEqual(50)
  })
})

describe('引用消息', () => {
  it('归一化时保留被引用消息 ID（lark-cli 的 reply_to 与原始 parent_id 都认）', () => {
    expect(normalizeFeishuEvent(evt({ reply_to: 'om_parent' }), cfg)!.raw).toEqual({ parentId: 'om_parent' })
    expect(normalizeFeishuEvent(evt({ parent_id: 'om_parent' }), cfg)!.raw).toEqual({ parentId: 'om_parent' })
  })

  it('从 mget 结果里取正文，并还原 @ 占位符', () => {
    const quoted = parseQuotedMessage(JSON.stringify({
      ok: true,
      data: {
        messages: [{
          message_id: 'om_parent',
          msg_type: 'text',
          content: '@_user_1 看下这个项目有什么可优化的么',
          mentions: [{ key: '@_user_1', name: '皮皮虾' }],
          sender: { name: '阿振(Pz)' },
        }],
      },
    }))!
    expect(quoted).toEqual({ id: 'om_parent', text: '@皮皮虾 看下这个项目有什么可优化的么', author: '阿振(Pz)', images: [] })
  })

  it('attach 把引用正文拼到消息前面，并写回 raw', async () => {
    const runner = new RecordingRunner()
    runner.response = JSON.stringify({
      data: { messages: [{ message_id: 'om_parent', msg_type: 'text', content: '看下最近改了什么', sender: { name: '阿振' } }] },
    })
    const base = normalizeFeishuEvent(evt({ parent_id: 'om_parent', content: '@router-agent' }), cfg)!
    const t = await attachQuotedMessage(base, runner as never)

    expect(runner.calls[0]).toEqual(quotedMessageCommand('om_parent'))
    expect(t.text).toBe('[引用 阿振的消息] 看下最近改了什么\n\n@router-agent')
    expect((t.raw as Record<string, any>).quote.text).toBe('看下最近改了什么')
  })

  it('引用的是纯图片消息时记录 image_key，交给图片转文本链路', async () => {
    const runner = new RecordingRunner()
    runner.response = JSON.stringify({
      data: { messages: [{ message_id: 'om_parent', msg_type: 'image', content: '{"image_key":"img_v3_quote"}', sender: { name: '阿振' } }] },
    })
    const base = normalizeFeishuEvent(evt({ parent_id: 'om_parent', content: '照这个改' }), cfg)!
    const t = await attachQuotedMessage(base, runner as never)

    expect(t.text).toBe('照这个改')
    expect((t.raw as Record<string, any>).quoteImages).toEqual([{ key: 'img_v3_quote', messageId: 'om_parent' }])
  })

  it('回查失败时保持原消息，不阻塞入库', async () => {
    const runner = new RecordingRunner()
    runner.fail = true
    const base = normalizeFeishuEvent(evt({ parent_id: 'om_parent' }), cfg)!
    expect(await attachQuotedMessage(base, runner as never)).toBe(base)
  })

  it('没有 parent_id 时不调用 lark-cli', async () => {
    const runner = new RecordingRunner()
    const base = normalizeFeishuEvent(evt(), cfg)!
    expect(await attachQuotedMessage(base, runner as never)).toBe(base)
    expect(runner.calls).toHaveLength(0)
  })
})

describe('飞书通信日志', () => {
  function recorder() {
    const logs: { level: string; message: string; extra?: Record<string, unknown> }[] = []
    return {
      logs,
      logger: {
        info: () => {},
        warn: (message: string, extra?: Record<string, unknown>) => logs.push({ level: 'warn', message, ...(extra ? { extra } : {}) }),
        error: () => {},
      },
    }
  }

  it('卡片发送失败并降级为富文本时记 feishu:card-fallback', async () => {
    const { logs, logger } = recorder()
    let n = 0
    const sender = new FeishuSender({
      async run() {
        n += 1
        return n === 1 ? { code: 1, stdout: '', stderr: 'bad card' } : { code: 0, stdout: '{}', stderr: '' }
      },
    }, logger)
    await sender.sendCard('oc_dev', '内容', 'k')
    expect(logs[0]).toMatchObject({ level: 'warn', message: 'feishu:card-fallback' })
    expect(logs[0]?.extra).toMatchObject({ target: 'oc_dev', code: 1, message: 'bad card' })
  })

  it('引用消息回查失败时记 feishu:quote-fetch-failed，并保持原消息', async () => {
    const { logs, logger } = recorder()
    const runner = new RecordingRunner()
    runner.fail = true
    const base = normalizeFeishuEvent(evt({ parent_id: 'om_parent' }), cfg)!
    const t = await attachQuotedMessage(base, runner as never, { logger })
    expect(t).toBe(base)
    expect(logs[0]).toMatchObject({ level: 'warn', message: 'feishu:quote-fetch-failed' })
    expect(logs[0]?.extra).toMatchObject({ messageId: 'om_parent', code: 1 })
  })
})

describe('未寻址消息放行（tk-59：已绑定工单话题内名单内成员）', () => {
  const mentionCfg: FeishuConfig = { ...cfg, chats: [chatEntry('oc_only_at', { mode: 'mention' })] }

  it('判定放行时不丢弃消息，地址类型保持 none', () => {
    const result = normalizeFeishuEventDetailed(evt({ chat_id: 'oc_only_at', thread_id: 'omt_topic_1' }), mentionCfg, '', () => true)
    expect(result.dropped).toBeUndefined()
    expect(result.trigger?.addressed).toBe('none')
  })

  it('放行的消息标记 unaddressedAdmitted，后面加表情与回执都靠它', () => {
    const result = normalizeFeishuEventDetailed(evt({ chat_id: 'oc_only_at', thread_id: 'omt_topic_1' }), mentionCfg, '', () => true)
    expect(result.trigger?.unaddressedAdmitted).toBe(true)
  })

  it('正常 @ 的消息不带放行标记', () => {
    const result = normalizeFeishuEventDetailed(evt({ chat_id: 'oc_only_at', mentions: [{ id: 'ou_bot' }] }), mentionCfg, '', () => true)
    expect(result.trigger?.unaddressedAdmitted).toBeUndefined()
  })

  it('放行判定拿得到群、发送者与线程标识', () => {
    const seen: UnaddressedContext[] = []
    normalizeFeishuEventDetailed(evt({ chat_id: 'oc_only_at', thread_id: 'omt_topic_1' }), mentionCfg, '', ctx => {
      seen.push(ctx)
      return true
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ chatId: 'oc_only_at', actorId: 'ou_alice' })
    expect(seen[0]?.threadKeys).toEqual(['omt_topic_1', 'om_100'])
  })

  it('判定不放行时照旧丢弃', () => {
    expect(normalizeFeishuEventDetailed(evt({ chat_id: 'oc_only_at' }), mentionCfg, '', () => false)).toMatchObject({ dropped: 'mention:required' })
  })

  it('没有注入判定时行为不变：只 @ 模式群仍然只收 @', () => {
    expect(normalizeFeishuEventDetailed(evt({ chat_id: 'oc_only_at' }), mentionCfg)).toMatchObject({ dropped: 'mention:required' })
  })

  it('全量接收的群不受影响，本来就不丢弃', () => {
    const result = normalizeFeishuEventDetailed(evt({ chat_id: 'oc_dev' }), cfg, '', () => false)
    expect(result.dropped).toBeUndefined()
  })
})

describe('发送人显示名', () => {
  it('actorNames 里查到人时填上显示名', () => {
    const named: FeishuConfig = { ...cfg, actorNames: new Map([['ou_alice', '阿振(Pz)']]) }
    expect(normalizeFeishuEvent(evt(), named)!.actorName).toBe('阿振(Pz)')
  })

  it('actorNames 为空或查不到这个人时留空且不报错', () => {
    expect(normalizeFeishuEvent(evt(), cfg)!.actorName).toBe('')
    const named: FeishuConfig = { ...cfg, actorNames: new Map([['ou_bob', '别人']]) }
    expect(normalizeFeishuEvent(evt(), named)!.actorName).toBe('')
  })
})
