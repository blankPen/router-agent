import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runReport, type ReportDeps } from '../src/cli/report.js'

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

    expect(code).toBe(0)
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
