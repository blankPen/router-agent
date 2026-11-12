import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ReportPoller, appendEvent, judgeIdle, parseStateFile } from '#runtime/orca/report-poller.js'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ra-poller-'))
}

const valid = {
  ticket_id: 'tk1',
  assignment_id: 'as1',
  turn: 1,
  state: 'progress',
  summary: '已开始',
  human_action: null,
  pr_number: 0,
  pr_url: '',
  acked_inputs: [],
  updated_at: '2026-11-06T10:00:00.000Z',
}

describe('state.json 解析', () => {
  it('接受合法结构并补齐默认值', () => {
    const { ticketId, state } = parseStateFile(JSON.stringify({ ticket_id: 'tk1', turn: 1, state: 'ready', summary: '好了' }))
    expect(ticketId).toBe('tk1')
    expect(state.prNumber).toBe(0)
    expect(state.ackedInputs).toEqual([])
  })

  it('拒绝非法 state 与缺失 summary', () => {
    expect(() => parseStateFile(JSON.stringify({ ticket_id: 'tk1', turn: 1, state: 'done', summary: 'x' }))).toThrow(/state:invalid/)
    expect(() => parseStateFile(JSON.stringify({ ticket_id: 'tk1', turn: 1, state: 'ready' }))).toThrow(/state:invalid/)
  })

  it('拒绝 ticket_id 与目录不匹配的上报', () => {
    expect(() => parseStateFile(JSON.stringify(valid), 'tk2')).toThrow(/state:ticket-mismatch/)
  })

  it('解析完整回复，并兼容旧版 deliverable 字段', () => {
    const reply = parseStateFile(JSON.stringify({
      ...valid,
      state: 'ready',
      reply: '## 结论\n1. 先修 A\n2. 再修 B',
    }))
    expect(reply.state.reply).toBe('## 结论\n1. 先修 A\n2. 再修 B')

    const legacy = parseStateFile(JSON.stringify({
      ...valid,
      state: 'ready',
      deliverable: { kind: 'doc', title: '清单', content: '# 全文', url: 'https://x.feishu.cn/docx/abc' },
    }))
    expect(legacy.state.reply).toBe('# 全文\n\nhttps://x.feishu.cn/docx/abc')
  })

  it('空回复不产生 reply', () => {
    const { state } = parseStateFile(JSON.stringify({ ...valid, state: 'ready', reply: '   ' }))
    expect(state.reply).toBeUndefined()
  })
})

describe('ReportPoller', () => {
  it('只上报 mtime 或内容变化的 state.json', () => {
    const dir = tmp()
    mkdirSync(join(dir, 'tk1'))
    writeFileSync(join(dir, 'tk1', 'state.json'), JSON.stringify(valid))

    const seen: string[] = []
    const poller = new ReportPoller({ workersDir: dir, onState: state => seen.push(state.ticketId) })
    expect(poller.scan()).toBe(1)
    expect(poller.scan()).toBe(0)

    writeFileSync(join(dir, 'tk1', 'state.json'), JSON.stringify({ ...valid, turn: 2, summary: '第二轮' }))
    expect(poller.scan()).toBe(1)
    expect(seen).toEqual(['tk1', 'tk1'])
  })

  it('坏文件不崩溃，交给 onError', () => {
    const dir = tmp()
    mkdirSync(join(dir, 'tk1'))
    writeFileSync(join(dir, 'tk1', 'state.json'), '{ not json')
    const errors: string[] = []
    const poller = new ReportPoller({ workersDir: dir, onState: () => {}, onError: (ticketId, err) => errors.push(`${ticketId}:${err.message}`) })
    expect(poller.scan()).toBe(0)
    expect(errors[0]).toContain('tk1')
    expect(errors[0]).toContain('invalid-json')
  })

  it('忽略没有 state.json 的目录与临时文件', () => {
    const dir = tmp()
    mkdirSync(join(dir, 'tk1'))
    writeFileSync(join(dir, 'tk1', 'state.json.tmp'), JSON.stringify(valid))
    mkdirSync(join(dir, 'empty'))
    const poller = new ReportPoller({ workersDir: dir, onState: () => {} })
    expect(poller.scan()).toBe(0)
  })

  it('reset 后允许同一内容再次上报（用于重启对账）', () => {
    const dir = tmp()
    mkdirSync(join(dir, 'tk1'))
    writeFileSync(join(dir, 'tk1', 'state.json'), JSON.stringify(valid))
    let count = 0
    const poller = new ReportPoller({ workersDir: dir, onState: () => { count += 1 } })
    poller.scan()
    poller.reset()
    poller.scan()
    expect(count).toBe(2)
  })

  it('把 meta.json 一起读出来，用于 handle / workdir 对账', () => {
    const dir = tmp()
    mkdirSync(join(dir, 'tk1'))
    writeFileSync(join(dir, 'tk1', 'state.json'), JSON.stringify(valid))
    writeFileSync(join(dir, 'tk1', 'meta.json'), JSON.stringify({ ticketId: 'tk1', assignmentId: 'as1', handle: 'term-1', workdir: '/tmp/wt' }))
    let meta: Record<string, unknown> | null = null
    const poller = new ReportPoller({ workersDir: dir, onState: (_s, m) => { meta = m } })
    poller.scan()
    expect(meta).toMatchObject({ handle: 'term-1', workdir: '/tmp/wt' })
  })
})

describe('idle 判定', () => {
  const now = new Date('2026-11-06T10:10:00.000Z').getTime()

  it('connected=false 判为 dead', () => {
    expect(judgeIdle({ info: { handle: 'h', connected: false, writable: false, orphaned: false, lastOutputAt: '', worktreePath: '', branch: '' }, turn: 1, lastTurn: 1, now, idleAfterMs: 60000 })).toBe('dead')
  })

  it('orphaned 且不可写判为 orphaned', () => {
    expect(judgeIdle({ info: { handle: 'h', connected: true, writable: false, orphaned: true, lastOutputAt: '2026-11-06T10:09:00.000Z', worktreePath: '', branch: '' }, turn: 1, lastTurn: 1, now, idleAfterMs: 60000 })).toBe('orphaned')
  })

  it('orphaned 但仍可写时按正常终端判定（实测 CLI 创建的终端如此）', () => {
    expect(judgeIdle({ info: { handle: 'h', connected: true, writable: true, orphaned: true, lastOutputAt: '2026-11-06T10:09:00.000Z', worktreePath: '', branch: '' }, turn: 1, lastTurn: 1, now, idleAfterMs: 60000 })).toBe('active')
  })

  it('终端长时间无输出且 turn 未涨判为 idle', () => {
    expect(judgeIdle({ info: { handle: 'h', connected: true, writable: true, orphaned: false, lastOutputAt: '2026-11-06T10:05:00.000Z', worktreePath: '', branch: '' }, turn: 1, lastTurn: 1, now, idleAfterMs: 60000 })).toBe('idle')
  })

  it('turn 涨过则仍算 active', () => {
    expect(judgeIdle({ info: { handle: 'h', connected: true, writable: true, orphaned: false, lastOutputAt: '2026-11-06T10:05:00.000Z', worktreePath: '', branch: '' }, turn: 3, lastTurn: 1, now, idleAfterMs: 60000 })).toBe('active')
  })

  it('终端信息缺失时保守判为 unknown', () => {
    expect(judgeIdle({ info: null, turn: 1, lastTurn: 1, now, idleAfterMs: 60000 })).toBe('unknown')
  })
})

describe('events.log', () => {
  it('追加一行 JSON，保留历史', () => {
    const dir = tmp()
    const path = join(dir, 'events.log')
    appendEvent(path, { kind: 'report', ticketId: 'tk1', at: '2026-11-06T10:00:00.000Z' })
    appendEvent(path, { kind: 'input', ticketId: 'tk1', at: '2026-11-06T10:01:00.000Z' })
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]!).kind).toBe('input')
  })
})
