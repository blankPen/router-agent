import { describe, expect, it } from 'vitest'
import {
  nextCronTime,
  nextRunAt,
  scheduleKinds,
  validateCron,
  validateSchedule,
} from '../src/automation-schedule.js'

describe('自动化触发计划', () => {
  it('注册表提供四种计划', () => {
    expect(scheduleKinds()).toEqual(['hourly', 'daily', 'weekly', 'cron'])
  })

  it('每小时计划落在下一个整点', () => {
    const next = nextRunAt({ kind: 'hourly' }, new Date(2026, 2, 1, 10, 20))
    const at = new Date(next!)
    expect(at.getHours()).toBe(11)
    expect(at.getMinutes()).toBe(0)
    expect(at.getDate()).toBe(1)
  })

  it('每天计划在当天时刻未过时落在当天', () => {
    const next = nextRunAt({ kind: 'daily', at: '09:00' }, new Date(2026, 2, 1, 10, 20))
    const at = new Date(next!)
    expect(at.getDate()).toBe(2)
    expect(at.getHours()).toBe(9)
  })

  it('每天计划在时刻未到时落在当天', () => {
    const next = nextRunAt({ kind: 'daily', at: '23:30' }, new Date(2026, 2, 1, 10, 20))
    const at = new Date(next!)
    expect(at.getDate()).toBe(1)
    expect(at.getHours()).toBe(23)
    expect(at.getMinutes()).toBe(30)
  })

  it('每周计划落在指定星期', () => {
    // 2026-03-01 是周日；weekday=3（周三）应落在 3 月 4 日。
    const next = nextRunAt({ kind: 'weekly', weekday: 3, time: '08:15' }, new Date(2026, 2, 1, 10, 20))
    const at = new Date(next!)
    expect(at.getDate()).toBe(4)
    expect(at.getDay()).toBe(3)
    expect(at.getHours()).toBe(8)
  })

  it('Cron 表达式必须是五段', () => {
    expect(validateCron('0 9 * * *')).toBeNull()
    expect(validateCron('0 0 9 * * *')).toContain('5 段')
  })

  it('Cron 越界字段被拒绝', () => {
    expect(validateCron('60 9 * * *')).toContain('第 1 段')
    expect(validateCron('0 24 * * *')).toContain('第 2 段')
    expect(validateCron('0 9 32 * *')).toContain('第 3 段')
    expect(validateCron('0 9 * 13 *')).toContain('第 4 段')
    expect(validateCron('0 9 * * 8')).toContain('第 5 段')
  })

  it('Cron 支持列表、范围与步长', () => {
    expect(validateCron('0,30 9 * * *')).toBeNull()
    expect(validateCron('0 9-18 * * *')).toBeNull()
    expect(validateCron('*/15 9 * * *')).toBeNull()
  })

  it('Cron 下一次触发时间可算出', () => {
    const next = nextCronTime('0 9 * * 1', new Date(2026, 2, 1, 10, 20))
    // 每周一 09:00；2026-03-02 是周一。
    const at = new Date(next!)
    expect(at.getDate()).toBe(2)
    expect(at.getDay()).toBe(1)
    expect(at.getHours()).toBe(9)
  })

  it('非法计划返回错误而不是抛异常', () => {
    expect(validateSchedule({ kind: 'daily', at: '25:00' })).toContain('执行时刻不合法')
    expect(validateSchedule({ kind: 'weekly', weekday: 9, time: '09:00' })).toContain('星期不合法')
    expect(validateSchedule({ kind: 'cron', cron: 'bad' })).toContain('Cron')
  })

  it('未知计划种类被拒绝', () => {
    expect(validateSchedule({ kind: 'yearly' as never })).toContain('未知的触发计划')
  })
})
