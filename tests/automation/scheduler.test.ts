import { describe, expect, it } from 'vitest'
import type { Automation, AutomationExecutor, AutomationRun, AutomationState, AutomationTool } from '#core/automation.js'
import { executeAutomation, initAutomationStates, tickAutomations, type AutomationSchedulerDeps } from '../../src/automation/scheduler.js'
import { AutomationExecutorRegistry, emptyOutputs } from '../../src/automation/executor.js'

/** 一个可编程的执行器：按脚本决定结果。 */
function fakeExecutor(
  type: Automation['type'],
  behaviour: (attempt: number) => { status: 'success' | 'failed' | 'timeout'; summary: string },
  calls: number[],
): AutomationExecutor {
  return {
    type,
    async execute() {
      const attempt = calls.length + 1
      calls.push(attempt)
      const outcome = behaviour(attempt)
      return { ...outcome, outputs: emptyOutputs() }
    },
  }
}

function task(over: Partial<Automation> = {}): Automation {
  return {
    id: 'auto_1',
    name: '巡检',
    description: '',
    type: 'ai',
    prompt: '检查依赖更新',
    schedule: { kind: 'daily', at: '09:00' },
    runtimeId: '',
    project: 'demo',
    repo: '/tmp/demo',
    branch: 'main',
    enabled: true,
    createdBy: '',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  }
}

interface Harness {
  deps: AutomationSchedulerDeps
  runs: AutomationRun[]
  states: Map<string, AutomationState>
  logs: Array<{ level: string; event: string; fields: Record<string, unknown> }>
}

function harness(options: {
  tasks: Automation[]
  executor?: AutomationExecutor
  maxRetries?: number
  nowMs?: number
}): Harness {
  const runs: AutomationRun[] = []
  const states = new Map<string, AutomationState>()
  const logs: Harness['logs'] = []
  const executors = new AutomationExecutorRegistry()
  if (options.executor) executors.register(options.executor as never)
  const deps: AutomationSchedulerDeps = {
    config: () => ({
      enabled: true,
      tasks: options.tasks,
      timeoutMs: 60_000,
      maxRetries: options.maxRetries ?? 0,
    }),
    executors,
    recordRun: run => runs.push(run),
    updateRun: run => {
      const index = runs.findIndex(item => item.id === run.id)
      if (index >= 0) runs[index] = run
    },
    stateOf: id => states.get(id) ?? { taskId: id },
    saveState: state => states.set(state.taskId, state),
    nextRunId: () => `run_${runs.length + 1}`,
    toolsFor: () => [] as AutomationTool[],
    workdirFor: () => '/tmp/work',
    reportPhase: (run, phase) => {
      run.phase = phase
      const index = runs.findIndex(item => item.id === run.id)
      if (index >= 0) runs[index] = { ...run, phase }
    },
    logger: {
      info: (event, fields) => logs.push({ level: 'info', event, fields: fields ?? {} }),
      warn: (event, fields) => logs.push({ level: 'warn', event, fields: fields ?? {} }),
      error: (event, fields) => logs.push({ level: 'error', event, fields: fields ?? {} }),
    },
    now: () => options.nowMs ?? Date.parse('2026-11-18T09:00:00.000Z'),
  }
  return { deps, runs, states, logs }
}

describe('自动化调度器', () => {
  it('到期的任务被执行并落一条执行记录', async () => {
    const calls: number[] = []
    const h = harness({
      tasks: [task()],
      executor: fakeExecutor('ai', () => ({ status: 'success', summary: '做完了' }), calls),
    })
    h.states.set('auto_1', { taskId: 'auto_1', nextRunAt: '2026-11-18T08:59:00.000Z' })

    const result = await tickAutomations(h.deps)

    expect(calls).toEqual([1])
    expect(result.runs).toHaveLength(1)
    expect(result.runs[0]!.status).toBe('success')
    expect(result.runs[0]!.summary).toBe('做完了')
    expect(h.runs).toHaveLength(1)
    expect(h.runs[0]!.automationId).toBe('auto_1')
  })

  it('没到期的任务不执行', async () => {
    const calls: number[] = []
    const h = harness({
      tasks: [task()],
      executor: fakeExecutor('ai', () => ({ status: 'success', summary: '' }), calls),
    })
    h.states.set('auto_1', { taskId: 'auto_1', nextRunAt: '2026-11-18T09:30:00.000Z' })

    const result = await tickAutomations(h.deps)

    expect(calls).toEqual([])
    expect(result.runs).toHaveLength(0)
  })

  it('执行过程中上报的阶段写回执行记录', async () => {
    const calls: number[] = []
    const h = harness({
      tasks: [task()],
      executor: {
        type: 'ai',
        async execute(input) {
          input.onPhase?.('generating-script')
          calls.push(1)
          return { status: 'success', summary: '做完了', outputs: emptyOutputs() }
        },
      },
    })
    h.states.set('auto_1', { taskId: 'auto_1', nextRunAt: '2026-11-18T08:59:00.000Z' })

    await tickAutomations(h.deps)

    expect(h.runs[0]!.phase).toBe('generating-script')
  })

  it('过期太久的任务记为 missed 且不补跑', async () => {
    const calls: number[] = []
    const h = harness({
      tasks: [task()],
      executor: fakeExecutor('ai', () => ({ status: 'success', summary: '' }), calls),
    })
    // 计划时间是 40 分钟前，超过 missed 阈值。
    h.states.set('auto_1', { taskId: 'auto_1', nextRunAt: '2026-11-18T08:20:00.000Z' })

    const result = await tickAutomations(h.deps)

    expect(calls).toEqual([])
    expect(result.runs[0]!.status).toBe('missed')
    expect(h.logs.some(log => log.event === 'automation:missed' && log.level === 'warn')).toBe(true)
  })

  it('失败会按配置重试', async () => {
    const calls: number[] = []
    const h = harness({
      tasks: [task()],
      maxRetries: 1,
      executor: fakeExecutor('ai', () => ({ status: 'failed', summary: '炸了' }), calls),
    })
    h.states.set('auto_1', { taskId: 'auto_1', nextRunAt: '2026-11-18T08:59:00.000Z' })

    const result = await tickAutomations(h.deps)

    expect(calls).toEqual([1, 2])
    expect(result.runs[0]!.status).toBe('failed')
    expect(h.logs.some(log => log.event === 'automation:retry')).toBe(true)
  })

  it('执行结束后记录下一次触发时间与上次状态', async () => {
    const calls: number[] = []
    const h = harness({
      tasks: [task()],
      executor: fakeExecutor('ai', () => ({ status: 'success', summary: 'ok' }), calls),
    })
    h.states.set('auto_1', { taskId: 'auto_1', nextRunAt: '2026-11-18T08:59:00.000Z' })

    await tickAutomations(h.deps)

    const state = h.states.get('auto_1')!
    expect(state.lastStatus).toBe('success')
    expect(state.nextRunAt).toBeTruthy()
    expect(Date.parse(state.nextRunAt!)).toBeGreaterThan(Date.parse('2026-11-18T09:00:00.000Z'))
  })

  it('禁用的任务不执行', async () => {
    const calls: number[] = []
    const h = harness({
      tasks: [task({ enabled: false })],
      executor: fakeExecutor('ai', () => ({ status: 'success', summary: '' }), calls),
    })
    h.states.set('auto_1', { taskId: 'auto_1', nextRunAt: '2026-11-18T08:00:00.000Z' })

    await tickAutomations(h.deps)

    expect(calls).toEqual([])
  })

  it('没有对应类型的执行器时执行失败并留日志', async () => {
    const h = harness({ tasks: [task({ type: 'script' })] })
    h.states.set('auto_1', { taskId: 'auto_1', nextRunAt: '2026-11-18T08:59:00.000Z' })

    const result = await tickAutomations(h.deps)

    expect(result.runs[0]!.status).toBe('failed')
    expect(result.runs[0]!.error).toContain('executor:unavailable')
    expect(h.logs.some(log => log.event === 'automation:executor-missing' && log.level === 'error')).toBe(true)
  })

  it('手动触发会被标记为 manual', async () => {
    const calls: number[] = []
    const h = harness({
      tasks: [task()],
      executor: fakeExecutor('ai', () => ({ status: 'success', summary: 'ok' }), calls),
    })

    const run = await executeAutomation(task(), '2026-11-18T09:00:00.000Z', h.deps, true)

    expect(run.manual).toBe(true)
    expect(calls).toEqual([1])
  })

  it('初始化时给没有状态的任务补下一次触发时间', () => {
    const states = new Map<string, AutomationState>()
    initAutomationStates([task()], {
      stateOf: id => states.get(id) ?? { taskId: id },
      saveState: state => states.set(state.taskId, state),
    }, Date.parse('2026-11-18T09:00:00.000Z'))

    expect(states.get('auto_1')!.nextRunAt).toBeTruthy()
  })
})
