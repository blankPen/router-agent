import { describe, expect, it } from 'vitest'
import {
  EMPTY_FILTER,
  facetCounts,
  filterLogLines,
  isFilterActive,
  type FilterableLogLine,
} from '../../src/web/client/log-filters.js'

const lines: FilterableLogLine[] = [
  {
    level: 'info',
    message: 'trigger:ingested',
    category: 'message',
    domain: 'trigger',
    event: 'ingested',
    chat: 'oc_1',
    actor: 'ou_alice',
    trace: 'trg-1',
    data: { chatName: '研发群' },
  },
  {
    level: 'warn',
    message: 'worker:status-failed',
    category: 'event',
    domain: 'worker',
    event: 'status-failed',
    chat: 'oc_1',
    actor: 'ou_alice',
    runtime: 'orca',
    ticket: 'tk-84',
    trace: 'tk-84',
    data: { reason: '超时' },
  },
  {
    level: 'error',
    message: 'api:request-failed',
    category: 'event',
    domain: 'api',
    event: 'request-failed',
    runtime: 'codex-app',
    data: { path: '/api/tickets' },
  },
]

describe('日志页多维过滤', () => {
  it('级别过滤只留同级行', () => {
    expect(filterLogLines(lines, { ...EMPTY_FILTER, level: 'warn' }).map(line => line.message)).toEqual([
      'worker:status-failed',
    ])
  })

  it('域过滤只留该域的行', () => {
    expect(filterLogLines(lines, { ...EMPTY_FILTER, domain: 'api' }).map(line => line.message)).toEqual([
      'api:request-failed',
    ])
  })

  it('动作过滤只留该动作的行', () => {
    expect(filterLogLines(lines, { ...EMPTY_FILTER, event: 'ingested' }).map(line => line.message)).toEqual([
      'trigger:ingested',
    ])
  })

  it('链路 ID 过滤把同一条链路的日志聚在一起', () => {
    expect(filterLogLines(lines, { ...EMPTY_FILTER, trace: 'tk-84' }).map(line => line.message)).toEqual([
      'worker:status-failed',
    ])
  })

  it('关键字同时命中消息、维度与业务字段', () => {
    expect(filterLogLines(lines, { ...EMPTY_FILTER, keyword: 'oc_1' }).map(line => line.message)).toEqual([
      'trigger:ingested',
      'worker:status-failed',
    ])
    expect(filterLogLines(lines, { ...EMPTY_FILTER, keyword: '研发群' }).map(line => line.message)).toEqual([
      'trigger:ingested',
    ])
    expect(filterLogLines(lines, { ...EMPTY_FILTER, keyword: 'request-failed' }).map(line => line.message)).toEqual([
      'api:request-failed',
    ])
  })

  it('多个维度同时生效时取交集', () => {
    const visible = filterLogLines(lines, {
      ...EMPTY_FILTER,
      level: 'warn',
      domain: 'worker',
      event: 'status-failed',
      trace: 'tk-84',
      keyword: '超时',
    })
    expect(visible).toHaveLength(1)
    expect(filterLogLines(lines, { ...EMPTY_FILTER, level: 'warn', domain: 'api' })).toEqual([])
  })

  it('默认不过滤', () => {
    expect(filterLogLines(lines, EMPTY_FILTER)).toHaveLength(3)
    expect(isFilterActive(EMPTY_FILTER)).toBe(false)
    expect(isFilterActive({ ...EMPTY_FILTER, domain: 'api' })).toBe(true)
    expect(isFilterActive({ ...EMPTY_FILTER, keyword: ' ' })).toBe(false)
  })

  it('按类别过滤：消息 / 事件 / 动作', () => {
    expect(filterLogLines(lines, { ...EMPTY_FILTER, category: 'message' }).map(line => line.message)).toEqual([
      'trigger:ingested',
    ])
    expect(filterLogLines(lines, { ...EMPTY_FILTER, category: 'event' })).toHaveLength(2)
  })

  it('按群、发起人、运行时、工单过滤', () => {
    expect(filterLogLines(lines, { ...EMPTY_FILTER, chat: 'oc_1' })).toHaveLength(2)
    expect(filterLogLines(lines, { ...EMPTY_FILTER, actor: 'ou_alice' })).toHaveLength(2)
    expect(filterLogLines(lines, { ...EMPTY_FILTER, runtime: 'orca' }).map(line => line.message)).toEqual([
      'worker:status-failed',
    ])
    expect(filterLogLines(lines, { ...EMPTY_FILTER, ticket: 'tk-84' }).map(line => line.message)).toEqual([
      'worker:status-failed',
    ])
  })

  it('分面计数按出现次数从多到少', () => {
    expect(facetCounts(lines, EMPTY_FILTER, 'domain')).toEqual([
      { value: 'api', count: 1 },
      { value: 'trigger', count: 1 },
      { value: 'worker', count: 1 },
    ])
  })

  it('动作分面只统计选中域内的动作', () => {
    expect(facetCounts(lines, { ...EMPTY_FILTER, domain: 'trigger' }, 'event')).toEqual([
      { value: 'ingested', count: 1 },
    ])
    expect(facetCounts(lines, EMPTY_FILTER, 'event')).toEqual([
      { value: 'ingested', count: 1 },
      { value: 'request-failed', count: 1 },
      { value: 'status-failed', count: 1 },
    ])
  })

  it('群与发起人分面忽略没有上下文的行', () => {
    expect(facetCounts(lines, EMPTY_FILTER, 'chat')).toEqual([{ value: 'oc_1', count: 2 }])
    expect(facetCounts(lines, EMPTY_FILTER, 'runtime')).toEqual([
      { value: 'codex-app', count: 1 },
      { value: 'orca', count: 1 },
    ])
  })

  it('链路分面忽略没有链路 ID 的行', () => {
    expect(facetCounts(lines, EMPTY_FILTER, 'trace')).toEqual([
      { value: 'tk-84', count: 1 },
      { value: 'trg-1', count: 1 },
    ])
  })

  it('分面计数不受该维度自身影响，但受其它维度影响', () => {
    // 选中链路后，级别分面只统计这条链路里的行。
    expect(facetCounts(lines, { ...EMPTY_FILTER, trace: 'tk-84' }, 'level')).toEqual([
      { value: 'warn', count: 1 },
    ])
    // 域分面不含域自身：选中了 trigger 也照样列出全部域。
    expect(facetCounts(lines, { ...EMPTY_FILTER, domain: 'trigger' }, 'domain')).toHaveLength(3)
  })
})
