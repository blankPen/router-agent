import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_LOG_LINES, readLogTail, readLogs } from '../../src/router/log-tail.js'

function jsonLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify(payload)}\n`
}

describe('日志增量读取', () => {
  let dir: string
  let path: string

  function setup(content: string): void {
    dir = mkdtempSync(join(tmpdir(), 'ra-log-tail-'))
    path = join(dir, 'router-agent.log')
    writeFileSync(path, content, 'utf8')
  }

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('文件不存在时返回 exists=false', () => {
    setup('')
    const result = readLogs(join(dir, 'missing.log'))
    expect(result.exists).toBe(false)
    expect(result.entries).toEqual([])
    expect(result.cursor).toBe(0)
  })

  it('首次读取返回尾部日志并解析出结构化字段', () => {
    setup([
      jsonLine({ at: '2026-11-09T10:00:00.000Z', level: 'info', message: 'api:listening', port: 8787 }),
      jsonLine({ at: '2026-11-09T10:00:01.000Z', level: 'warn', message: 'feishu:slow', ms: 1200 }),
    ].join(''))

    const result = readLogs(path)
    expect(result.exists).toBe(true)
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]).toEqual({
      at: '2026-11-09T10:00:00.000Z',
      level: 'info',
      domain: 'api',
      event: 'listening',
      category: 'event',
      message: 'api:listening',
      data: { port: 8787 },
    })
    expect(result.entries[1]?.level).toBe('warn')
    expect(result.more).toBe(false)
    expect(result.cursor).toBeGreaterThan(0)
  })

  it('解析出结构字段 domain / event / trace，且不进业务字段', () => {
    setup([
      jsonLine({
        at: '2026-11-09T10:00:00.000Z',
        level: 'info',
        domain: 'trigger',
        event: 'ingested',
        message: 'trigger:ingested',
        trace: 'trg-1',
        id: 'trg-1',
      }),
    ].join(''))

    const result = readLogs(path)
    expect(result.entries[0]).toEqual({
      at: '2026-11-09T10:00:00.000Z',
      level: 'info',
      domain: 'trigger',
      event: 'ingested',
      category: 'message',
      trace: 'trg-1',
      message: 'trigger:ingested',
      data: { id: 'trg-1' },
    })
  })

  it('解析群、发起人、运行时与工单等维度，不混进业务字段', () => {
    setup([
      jsonLine({
        at: '2026-11-09T10:00:00.000Z',
        level: 'info',
        message: 'trigger:ingested',
        chat: 'oc_1',
        chatName: '研发群',
        actor: 'ou_alice',
        actorName: '林薇',
        actorType: 'user',
        runtime: 'orca',
        ticketId: 'tk-1',
        id: 'trg-1',
      }),
    ].join(''))

    const entry = readLogs(path).entries[0]
    expect(entry).toMatchObject({
      domain: 'trigger',
      event: 'ingested',
      category: 'message',
      chat: 'oc_1',
      chatName: '研发群',
      actor: 'ou_alice',
      actorName: '林薇',
      actorType: 'user',
      runtime: 'orca',
      ticket: 'tk-1',
    })
    // 维度已经单独成列，业务字段里不再重复出现。
    expect(entry?.data).toEqual({ id: 'trg-1' })
  })

  it('旧日志没有结构字段时按事件名与业务字段补齐', () => {
    setup(jsonLine({ at: '2026-11-09T10:00:00.000Z', level: 'warn', message: 'worker:status-failed', ticketId: 'tk-84' }))

    const result = readLogs(path)
    expect(result.entries[0]).toMatchObject({ domain: 'worker', event: 'status-failed', trace: 'tk-84' })
  })

  it('带 cursor 只返回之后新增的行', () => {
    setup(jsonLine({ at: '2026-11-09T10:00:00.000Z', level: 'info', message: 'first' }))
    const first = readLogs(path)
    expect(first.entries).toHaveLength(1)

    appendFileSync(path, jsonLine({ at: '2026-11-09T10:00:05.000Z', level: 'info', message: 'second' }))
    const next = readLogs(path, { cursor: first.cursor })
    expect(next.entries.map(entry => entry.message)).toEqual(['second'])
    expect(next.reset).toBeUndefined()

    // 没有新内容时再拉一次应为空，且游标不再前进。
    const empty = readLogs(path, { cursor: next.cursor })
    expect(empty.entries).toEqual([])
    expect(empty.cursor).toBe(next.cursor)
  })

  it('版本号单独解析出来，不混进业务字段', () => {
    setup(jsonLine({ at: '2026-11-09T10:00:00.000Z', level: 'info', message: 'api:listening', version: '1.2.3', port: 8787 }))

    const result = readLogs(path)

    expect(result.entries[0]?.version).toBe('1.2.3')
    expect(result.entries[0]?.data).toEqual({ port: 8787 })
  })

  it('末尾写了一半的行不下发，补全后能读到', () => {
    setup(jsonLine({ at: '2026-11-09T10:00:00.000Z', level: 'info', message: 'complete' }))
    const first = readLogs(path)

    appendFileSync(path, '{"at":"2026-11-09T10:00:01.000Z","level":"info"')
    const partial = readLogs(path, { cursor: first.cursor })
    expect(partial.entries).toEqual([])
    expect(partial.cursor).toBe(first.cursor)

    appendFileSync(path, ',"message":"finished"}\n')
    const finished = readLogs(path, { cursor: partial.cursor })
    expect(finished.entries.map(entry => entry.message)).toEqual(['finished'])
  })

  it('非 JSON 行按原文返回，不拖累后续行', () => {
    setup(`这是旧格式日志\n${jsonLine({ at: '2026-11-09T10:00:00.000Z', level: 'info', message: 'after' })}`)
    const result = readLogs(path)
    expect(result.entries[0]).toEqual({ at: '', level: 'raw', domain: '', event: '', category: '', message: '这是旧格式日志' })
    expect(result.entries[1]?.message).toBe('after')
  })

  it('cursor 超出文件大小（截断/轮转）时从头重读并标记 reset', () => {
    setup(jsonLine({ level: 'info', message: 'old-a' }) + jsonLine({ level: 'info', message: 'old-b' }))
    const first = readLogs(path)
    expect(first.cursor).toBeGreaterThan(0)

    // 模拟日志轮转：文件被替换成更短的内容。
    writeFileSync(path, jsonLine({ level: 'info', message: 'fresh' }), 'utf8')
    const result = readLogs(path, { cursor: first.cursor })
    expect(result.reset).toBe(true)
    expect(result.entries.map(entry => entry.message)).toEqual(['fresh'])
  })

  it('首次读取只返回最近 limit 行，且 limit 有上限', () => {
    const content = Array.from({ length: 30 }, (_, index) => jsonLine({ level: 'info', message: `line-${index}` })).join('')
    setup(content)
    expect(readLogs(path, { limit: 5 }).entries.map(entry => entry.message)).toEqual([
      'line-25', 'line-26', 'line-27', 'line-28', 'line-29',
    ])

    const many = Array.from({ length: MAX_LOG_LINES + 50 }, (_, index) => jsonLine({ level: 'info', message: `m-${index}` })).join('')
    writeFileSync(path, many, 'utf8')
    expect(readLogs(path, { limit: 99_999 }).entries).toHaveLength(MAX_LOG_LINES)
  })

  it('中文内容按字节游标读取不会截断成乱码', () => {
    setup(jsonLine({ level: 'info', message: '第一行中文日志', note: '飞书消息进入' }))
    const first = readLogs(path)
    expect(first.entries[0]?.message).toBe('第一行中文日志')

    appendFileSync(path, jsonLine({ level: 'info', message: '第二行中文日志' }))
    const next = readLogs(path, { cursor: first.cursor })
    expect(next.entries[0]?.message).toBe('第二行中文日志')
  })
})

describe('排查助手回看日志', () => {
  let dir: string
  let path: string

  function setup(content: string): void {
    dir = mkdtempSync(join(tmpdir(), 'ra-log-tail-assistant-'))
    path = join(dir, 'router-agent.log')
    writeFileSync(path, content, 'utf8')
  }

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('文件不存在时返回空数组', () => {
    setup('')
    expect(readLogTail(join(dir, 'missing.log'))).toEqual([])
  })

  it('能回看超过面板上限的行数，错误日志不被挤掉', () => {
    // 先写一条错误，再写 3000 条 info：错误落在面板 1000 行窗口之外。
    const content = [
      jsonLine({ at: '2026-11-09T10:00:00.000Z', level: 'error', message: 'effect:failed', error: 'boom' }),
      ...Array.from({ length: 3000 }, (_, index) =>
        jsonLine({ at: '2026-11-09T10:01:00.000Z', level: 'info', message: `m-${index}` })),
    ].join('')
    setup(content)

    expect(readLogs(path).entries.some(entry => entry.level === 'error')).toBe(false)
    const entries = readLogTail(path, { lines: 5000 })
    expect(entries.some(entry => entry.level === 'error')).toBe(true)
    expect(entries[0]?.message).toBe('effect:failed')
  })

  it('按行数上限截断', () => {
    setup(Array.from({ length: 100 }, (_, index) => jsonLine({ level: 'info', message: `m-${index}` })).join(''))
    expect(readLogTail(path, { lines: 10 })).toHaveLength(10)
  })
})
