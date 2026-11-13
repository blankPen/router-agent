import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runReport, type ReportDeps } from '../src/cli/report.js'
import { runReply } from '../src/cli/reply.js'

function makeDeps(home: string, fetchImpl: typeof fetch): ReportDeps & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    home,
    port: 3083,
    stdout: line => out.push(line),
    stderr: line => err.push(line),
    fetchImpl,
    now: () => '2026-11-06T15:30:00+08:00',
    out,
    err,
  }
}

describe('ra report', () => {
  it('POST 给本地 Router，并带上完整交付物', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! })
      return new Response(JSON.stringify({ ok: true, turn: 2 }), { status: 201 })
    }) as typeof fetch
    const deps = makeDeps('/tmp/ra-report-none', fetchImpl)

    const code = await runReport(deps, {
      ticket: 'tk_1',
      state: 'ready',
      summary: '完成梳理',
      reply: '## 结论\n- A',
      ack: ['in_1'],
    })

    expect(code).toBe(0)
    expect(calls[0]!.url).toBe('http://127.0.0.1:3083/api/reports')
    const body = JSON.parse(String(calls[0]!.init.body))
    expect(body).toMatchObject({
      ticketId: 'tk_1', state: 'ready', summary: '完成梳理',
      reply: '## 结论\n- A',
      ackedInputs: ['in_1'],
    })
    expect(deps.out[0]).toContain('turn=2')
  })

  it('透传 --ui-change 声明', async () => {
    let sent: any = null
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init!.body))
      return new Response('{"ok":true,"turn":1}', { status: 201 })
    }) as typeof fetch

    const code = await runReport(makeDeps('/tmp/ra-report-none', fetchImpl), {
      ticket: 'tk_1', state: 'ready', summary: '改了按钮', uiChange: true,
    })

    expect(code).toBe(0)
    expect(sent.uiChange).toBe(true)
  })

  it('正文支持 @文件，避免长文本被 shell 转义', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ra-report-'))
    const answer = join(dir, 'answer.md')
    writeFileSync(answer, '# 完整结论\n很长的正文')
    let sent: any = null
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init!.body))
      return new Response('{"ok":true,"turn":1}', { status: 201 })
    }) as typeof fetch

    const code = await runReport(makeDeps(dir, fetchImpl), {
      ticket: 'tk_1', state: 'ready', summary: '完成', reply: `@${answer}`,
    })

    expect(code).toBe(0)
    expect(sent.reply).toBe('# 完整结论\n很长的正文')
  })

  it('服务不可达时落回 state.json，由 poller 捡起', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-report-'))
    mkdirSync(join(home, 'workers', 'tk_1'), { recursive: true })
    writeFileSync(join(home, 'workers', 'tk_1', 'meta.json'), JSON.stringify({ assignmentId: 'as_1' }))
    writeFileSync(join(home, 'workers', 'tk_1', 'state.json'), JSON.stringify({ turn: 3 }))
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch

    const deps = makeDeps(home, fetchImpl)
    const code = await runReport(deps, { ticket: 'tk_1', state: 'ready', summary: '完成', reply: '正文', uiChange: true })

    expect(code).toBe(3)
    const file = JSON.parse(readFileSync(join(home, 'workers', 'tk_1', 'state.json'), 'utf8'))
    expect(file).toMatchObject({
      ticket_id: 'tk_1', assignment_id: 'as_1', turn: 4, state: 'ready', summary: '完成',
      reply: '正文', ui_change: true,
    })
    expect(deps.err.join('\n')).toContain('不可达')
  })

  it('4xx 参数错误直接失败，不写本地文件', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-report-'))
    const fetchImpl = (async () => new Response('{"error":"ticket-not-found"}', { status: 404 })) as typeof fetch
    const deps = makeDeps(home, fetchImpl)

    const code = await runReport(deps, { ticket: 'tk_x', state: 'ready', summary: 'x' })

    expect(code).toBe(1)
    expect(deps.err.join('\n')).toContain('404')
  })

  it('422 证据门禁把 message 完整带出，便于 worker 按指引修正', async () => {
    const message = 'UI 工单缺少 PR / MR 证据：Before 标识。\n请补齐后重新上报；如果确实无法截图，请改用 --state blocked。'
    const fetchImpl = (async () => new Response(JSON.stringify({ error: 'evidence-missing', message }), { status: 422 })) as typeof fetch
    const deps = makeDeps('/tmp/ra-report-none', fetchImpl)

    const code = await runReport(deps, { ticket: 'tk_1', state: 'ready', summary: '完成' })

    expect(code).toBe(1)
    expect(deps.err.join('\n')).toContain('--state blocked')
  })

  it('拒绝非法 state', async () => {
    const deps = makeDeps('/tmp/none', (async () => new Response('{}')) as typeof fetch)
    expect(await runReport(deps, { ticket: 'tk_1', state: 'done', summary: 'x' })).toBe(2)
  })
})

describe('ra reply v2', () => {
  function capture(payloads: any[]): typeof fetch {
    return (async (_url: string | URL | Request, init?: RequestInit) => {
      payloads.push(JSON.parse(String(init!.body)))
      return new Response('{"ok":true,"turn":4}', { status: 201 })
    }) as typeof fetch
  }

  it('markdown 正文同时给结构化块与纯文本兜底', async () => {
    const sent: any[] = []
    const code = await runReply(makeDeps('/tmp/ra-reply-none', capture(sent)), {
      ticket: 'tk_1', body: '## 结论\n- A', kind: 'markdown',
    })

    expect(code).toBe(0)
    expect(sent[0]).toMatchObject({
      ticketId: 'tk_1',
      state: 'ready',
      summary: '## 结论',
      reply: '## 结论\n- A',
      replyPayload: { blocks: [{ type: 'markdown', text: '## 结论\n- A' }], fallbackText: '## 结论\n- A' },
    })
  })

  it('before= / after= 合成对比图块，其余图片按单图发送', async () => {
    const sent: any[] = []
    const code = await runReply(makeDeps('/tmp/ra-reply-none', capture(sent)), {
      ticket: 'tk_1', body: 'UI 对比', summary: 'UI 对比',
      image: ['before=./before.png', 'after=./after.png', './extra.png', 'https://cdn.example.com/raw.png'],
    })

    expect(code).toBe(0)
    const blocks = sent[0].replyPayload.blocks
    expect(blocks).toEqual([
      { type: 'markdown', text: 'UI 对比' },
      { type: 'imagePair', before: { path: resolve('./before.png'), alt: 'Before' }, after: { path: resolve('./after.png'), alt: 'After' }, caption: '同一场景、同一视口、同一主题' },
      { type: 'image', image: { path: resolve('./extra.png'), alt: '图片' } },
      { type: 'image', image: { path: 'https://cdn.example.com/raw.png', alt: '图片' } },
    ])
  })

  it('ask 生成选择题块，questionId 交给 Router 生成', async () => {
    const sent: any[] = []
    const code = await runReply(makeDeps('/tmp/ra-reply-none', capture(sent)), {
      ticket: 'tk_1', ask: true, question: '选哪个方案？',
      option: ['A|方案一', 'B|方案二'],
    })

    expect(code).toBe(0)
    expect(sent[0].replyPayload.blocks[0]).toEqual({
      type: 'choices',
      questionId: '',
      prompt: '选哪个方案？',
      options: [
        { id: 'A', label: 'A', description: '方案一' },
        { id: 'B', label: 'B', description: '方案二' },
      ],
    })
  })

  it('ask 少于两个选项时按参数错误退出', async () => {
    const deps = makeDeps('/tmp/ra-reply-none', capture([]))
    const code = await runReply(deps, { ticket: 'tk_1', ask: true, question: '选哪个？', option: ['A'] })

    expect(code).toBe(2)
    expect(deps.err.join('\n')).toContain('至少需要两个')
  })

  it('kind pr 把链接做成卡片按钮，并把 PR 链接放进兜底正文', async () => {
    const sent: any[] = []
    const code = await runReply(makeDeps('/tmp/ra-reply-none', capture(sent)), {
      ticket: 'tk_1', kind: 'pr', body: '## 做了什么\n修好了', pr: '42', prUrl: 'https://github.com/o/r/pull/42',
    })

    expect(code).toBe(0)
    expect(sent[0].replyPayload.blocks[0]).toMatchObject({
      type: 'card',
      title: 'PR #42',
      markdown: '## 做了什么\n修好了',
      actions: [{ label: '打开 PR', url: 'https://github.com/o/r/pull/42' }],
    })
    expect(sent[0].replyPayload.fallbackText).toContain('https://github.com/o/r/pull/42')
  })

  it('服务不可达时结构化载荷也写进 state.json 的 reply_payload', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-reply-'))
    const deps = makeDeps(home, (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch)
    const code = await runReply(deps, { ticket: 'tk_1', kind: 'markdown', body: '正文', summary: '完成' })

    expect(code).toBe(3)
    const file = JSON.parse(readFileSync(join(home, 'workers', 'tk_1', 'state.json'), 'utf8'))
    expect(file.reply_payload.blocks[0]).toEqual({ type: 'markdown', text: '正文' })
  })
})
