import { describe, expect, it } from 'vitest'
import { Store } from '../../src/store/db.js'
import type { AutomationRun } from '#core/automation.js'

function run(over: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run_1',
    automationId: 'auto_1',
    scheduledAt: '2026-11-18T09:00:00.000Z',
    startedAt: '2026-11-18T09:00:01.000Z',
    status: 'running',
    summary: '',
    outputs: { ticketIds: [], eventIds: [] },
    manual: false,
    ...over,
  }
}

describe('自动化执行记录落库', () => {
  it('执行结束后能查到耗时、结果与产出', () => {
    const store = new Store(':memory:')
    try {
      store.insertAutomationRun(run())
      store.updateAutomationRun(run({
        finishedAt: '2026-11-18T09:00:21.000Z',
        durationMs: 20_000,
        status: 'success',
        summary: '检查完成',
        outputs: { ticketIds: ['tk-1'], eventIds: ['evt-1'] },
      }))

      const saved = store.getAutomationRun('run_1')!
      expect(saved.status).toBe('success')
      expect(saved.durationMs).toBe(20_000)
      expect(saved.summary).toBe('检查完成')
      expect(saved.outputs.ticketIds).toEqual(['tk-1'])
    } finally {
      store.close()
    }
  })

  it('执行记录可按任务过滤', () => {
    const store = new Store(':memory:')
    try {
      store.insertAutomationRun(run())
      store.insertAutomationRun(run({
        id: 'run_2',
        automationId: 'auto_2',
        status: 'failed',
        error: 'boom',
      }))

      expect(store.listAutomationRuns({ automationId: 'auto_2' })).toHaveLength(1)
      expect(store.listAutomationRuns()).toHaveLength(2)
    } finally {
      store.close()
    }
  })
})
