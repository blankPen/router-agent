import { describe, expect, it } from 'vitest'
import { Cursors } from '../../src/store/cursors.js'
import { noopLogger } from '#infra/logger.js'

/** 假存储：只实现游标三方法，直接看 value 落在哪。 */
function fakeStore(): { rows: Map<string, string>; cursors: Cursors } {
  const rows = new Map<string, string>()
  const cursors = new Cursors(
    {
      getCursor: key => rows.get(key) ?? null,
      setCursor: (key, value) => { rows.set(key, value) },
      deleteCursor: key => { rows.delete(key) },
    },
    () => '2026-11-06T10:00:00.000Z',
    noopLogger,
  )
  return { rows, cursors }
}

describe('游标有类型封装', () => {
  it('key 字符串与拆分前逐字一致，存量数据继续可读', () => {
    const { rows, cursors } = fakeStore()
    cursors.setProgress('t1', 'r1')
    cursors.setLaunchFailure('t1', { attempts: 2, lastSeq: 7, lastReason: 'boom' })
    cursors.setRelaunchSeq('t1', 7)
    cursors.setInterrupted('t1', { turnIds: ['turn-1'], autoRecovered: 1 })
    cursors.setReminder('t1', { remindedAt: 100, closeAt: 200, outboxKey: 'k' })
    cursors.setProbe('t1', { lastProgressAt: 100, lastPostAt: 200, count: 1, snippetHash: 'h' })
    cursors.markPrUrge('t1', 300)
    cursors.markZombie('t1', 400)
    cursors.markUnackedNotice('i1', 500)

    expect([...rows.keys()].sort()).toEqual([
      'input:unacked-notice:i1',
      'interrupted:t1',
      'launch-failure:t1',
      'progress:probe:t1',
      'progress:t1',
      'relaunch:t1',
      'retention:pr-urge:t1',
      'retention:reminder:t1',
      'retention:zombie:t1',
    ])
  })

  it('进展水位存的是 report id 或起点标记', () => {
    const { cursors } = fakeStore()
    expect(cursors.progress('t1')).toBeNull()
    cursors.setProgress('t1', 'r1')
    expect(cursors.progress('t1')).toBe('r1')
  })

  it('派工失败水位往返后字段不变', () => {
    const { cursors } = fakeStore()
    cursors.setLaunchFailure('t1', { attempts: 3, lastSeq: 12, lastReason: 'timeout' })
    expect(cursors.launchFailure('t1')).toEqual({ attempts: 3, lastSeq: 12, lastReason: 'timeout' })
    cursors.clearLaunchFailure('t1')
    expect(cursors.launchFailure('t1')).toBeNull()
  })

  it('重新派工水位读不出正数时按 0 处理', () => {
    const { rows, cursors } = fakeStore()
    expect(cursors.relaunchSeq('t1')).toBe(0)
    rows.set('relaunch:t1', 'abc')
    expect(cursors.relaunchSeq('t1')).toBe(0)
    rows.set('relaunch:t1', '-5')
    expect(cursors.relaunchSeq('t1')).toBe(0)
    cursors.setRelaunchSeq('t1', 9)
    expect(cursors.relaunchSeq('t1')).toBe(9)
  })

  it('中断恢复水位损坏时按全新记录处理', () => {
    const { rows, cursors } = fakeStore()
    rows.set('interrupted:t1', '{not json')
    expect(cursors.interrupted('t1')).toEqual({ turnIds: [], autoRecovered: 0 })
  })

  it('关单提醒水位缺关键字段时按没有提醒处理', () => {
    const { rows, cursors } = fakeStore()
    rows.set('retention:reminder:t1', JSON.stringify({ remindedAt: 100 }))
    expect(cursors.reminder('t1')).toBeNull()
    cursors.setReminder('t1', { remindedAt: 100, closeAt: 200 })
    expect(cursors.reminder('t1')).toEqual({ remindedAt: 100, closeAt: 200 })
  })

  it('时间戳类水位区分「没有」与「有」', () => {
    const { cursors } = fakeStore()
    expect(cursors.hasZombie('t1')).toBe(false)
    expect(cursors.zombie('t1')).toBeNull()
    cursors.markZombie('t1', 400)
    expect(cursors.hasZombie('t1')).toBe(true)
    expect(cursors.zombie('t1')).toBe(400)
    cursors.clearZombie('t1')
    expect(cursors.hasZombie('t1')).toBe(false)
  })

  it('PR 催办水位：有记录才算催过', () => {
    const { cursors } = fakeStore()
    expect(cursors.hasPrUrge('t1')).toBe(false)
    cursors.markPrUrge('t1', 300)
    expect(cursors.hasPrUrge('t1')).toBe(true)
    expect(cursors.prUrge('t1')).toBe(300)
    cursors.clearPrUrge('t1')
    expect(cursors.hasPrUrge('t1')).toBe(false)
  })

  it('未 ack 提醒水位对同一条输入只记一次', () => {
    const { cursors } = fakeStore()
    expect(cursors.hasUnackedNotice('i1')).toBe(false)
    cursors.markUnackedNotice('i1', 500)
    expect(cursors.hasUnackedNotice('i1')).toBe(true)
  })

  it('PR 查询失败标记按工单 + PR 号分别记', () => {
    const { cursors } = fakeStore()
    expect(cursors.hasPrTrackMissed('t1', 42)).toBe(false)
    cursors.markPrTrackMissed('t1', 42, '2026-11-06T10:00:00.000Z')
    expect(cursors.hasPrTrackMissed('t1', 42)).toBe(true)
    expect(cursors.hasPrTrackMissed('t1', 43)).toBe(false)
    expect(cursors.hasPrTrackMissed('t2', 42)).toBe(false)
  })
})
