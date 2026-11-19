/**
 * 自动化调度器：内嵌在 Router 服务进程内，随服务起停。
 *
 * 调度语义：
 * - 服务重启后不补跑过期任务：过期的执行记为 missed，在执行列表可见；
 * - 每次执行落一条执行记录（触发时间、耗时、状态、结果摘要、错误、产出）；
 * - 超时与重试由执行器统一处理，调度器只管「什么时候触发」。
 */
import type { Automation, AutomationRun, AutomationRunOutputs, AutomationRunPhase, AutomationState, AutomationTool } from '#core/automation.js'
import { nextRunAt, validateSchedule } from '#core/automation-schedule.js'
import { preview } from '#core/events.js'
import { errorMessage } from '#infra/logger.js'
import type { AutomationExecutorRegistry } from './executor.js'
import { emptyOutputs } from './executor.js'

/** 一次调度决策的结果。 */
export interface SchedulerTick {
  /** 本轮触发的执行记录。 */
  runs: AutomationRun[]
}

/** 调度器需要的宿主能力。 */
export interface AutomationSchedulerDeps {
  /** 当前自动化配置（面板改完立即生效）。 */
  config: () => { enabled: boolean; tasks: Automation[]; timeoutMs: number; maxRetries: number }
  /** 执行器注册表。 */
  executors: AutomationExecutorRegistry
  /** 落执行记录。 */
  recordRun: (run: AutomationRun) => void
  /** 更新执行记录（结束后补耗时与结果）。 */
  updateRun: (run: AutomationRun) => void
  /** 读任务调度状态。 */
  stateOf: (taskId: string) => AutomationState
  /** 写任务调度状态。 */
  saveState: (state: AutomationState) => void
  /** 生成执行 id。 */
  nextRunId: () => string
  /** 注入工具（已绑定项目范围）。 */
  toolsFor: (automation: Automation) => AutomationTool[]
  /** 准备工作目录：限定在被选项目范围内。 */
  workdirFor: (automation: Automation) => string
  /** 上报执行中的阶段；面板据此显示进度。 */
  reportPhase?: (run: AutomationRun, phase: AutomationRunPhase) => void
  logger: {
    info(event: string, fields?: Record<string, unknown>): void
    warn(event: string, fields?: Record<string, unknown>): void
    error(event: string, fields?: Record<string, unknown>): void
  }
  /** 时钟；测试可注入固定时间。 */
  now?: () => number
}

/** 超过这个时间窗还没跑的任务算 missed（服务重启后不补跑）。 */
const MISSED_THRESHOLD_MS = 5 * 60_000

/**
 * 调度一轮：挑出到期任务，逐个执行。
 */
export async function tickAutomations(deps: AutomationSchedulerDeps): Promise<SchedulerTick> {
  const config = deps.config()
  const runs: AutomationRun[] = []
  if (!config.enabled) return { runs }
  const now = deps.now ?? (() => Date.now())
  const nowMs = now()

  for (const automation of config.tasks) {
    if (!automation.enabled) continue
    const state = deps.stateOf(automation.id)
    const due = state.nextRunAt ? Date.parse(state.nextRunAt) : Number.NaN
    if (!Number.isFinite(due) || due > nowMs) continue

    const scheduledAt = state.nextRunAt!
    // 过期太久不再补跑：记成 missed，让用户在执行列表里看到漏掉了什么。
    if (nowMs - due > MISSED_THRESHOLD_MS) {
      const missed: AutomationRun = {
        id: deps.nextRunId(),
        automationId: automation.id,
        scheduledAt,
        startedAt: new Date(nowMs).toISOString(),
        finishedAt: new Date(nowMs).toISOString(),
        durationMs: 0,
        status: 'missed',
        summary: '服务未运行，错过了这次触发',
        outputs: emptyOutputs(),
        manual: false,
      }
      deps.recordRun(missed)
      const next = nextRunAt(automation.schedule, new Date(nowMs))
      deps.saveState({
        taskId: automation.id,
        ...(next ? { nextRunAt: next } : {}),
        lastRunAt: scheduledAt,
        lastStatus: 'missed',
      })
      deps.logger.warn('automation:missed', {
        automationId: automation.id,
        scheduledAt,
        delayMs: nowMs - due,
      })
      runs.push(missed)
      continue
    }

    const run = await executeAutomation(automation, scheduledAt, deps)
    runs.push(run)
  }
  return { runs }
}

/**
 * 执行一个任务并落记录。
 */
export async function executeAutomation(
  automation: Automation,
  scheduledAt: string,
  deps: AutomationSchedulerDeps,
  manual = false,
): Promise<AutomationRun> {
  const run = startRun(automation, scheduledAt, deps, manual)
  return executeRun(automation, run, deps)
}

/**
 * 落一条 running 记录并返回；执行本身还没开始。
 *
 * 手动触发用它「先返回、后执行」：面板拿到 running 记录就能立刻显示进度，
 * 不必等一次执行跑完（可能好几分钟）才拿到响应。
 */
export function startRun(
  automation: Automation,
  scheduledAt: string,
  deps: AutomationSchedulerDeps,
  manual = false,
): AutomationRun {
  const now = deps.now ?? (() => Date.now())
  const startedAtMs = now()
  const run: AutomationRun = {
    id: deps.nextRunId(),
    automationId: automation.id,
    scheduledAt,
    startedAt: new Date(startedAtMs).toISOString(),
    status: 'running',
    summary: '',
    outputs: emptyOutputs(),
    manual,
  }
  deps.recordRun(run)
  return run
}

/**
 * 执行一个任务并把记录收尾。
 *
 * 收尾统一在这里做：耗时、状态、摘要、错误与产出都写回同一条记录，
 * 并顺手排下一次触发时间。
 */
export async function executeRun(
  automation: Automation,
  run: AutomationRun,
  deps: AutomationSchedulerDeps,
): Promise<AutomationRun> {
  const now = deps.now ?? (() => Date.now())
  const startedAtMs = Date.parse(run.startedAt)
  const finish = (status: AutomationRun['status'], summary: string, outputs: AutomationRunOutputs, error?: string): AutomationRun => {
    const finished: AutomationRun = {
      ...run,
      status,
      finishedAt: new Date(now()).toISOString(),
      durationMs: now() - startedAtMs,
      summary,
      ...(error ? { error } : {}),
      outputs,
    }
    deps.updateRun(finished)
    const next = nextRunAt(automation.schedule, new Date(now()))
    deps.saveState({
      taskId: automation.id,
      ...(next ? { nextRunAt: next } : {}),
      lastRunAt: finished.finishedAt,
      lastStatus: finished.status,
    })
    deps.logger.info('automation:run-finished', {
      automationId: automation.id,
      runId: run.id,
      status: finished.status,
      durationMs: finished.durationMs,
      ticketIds: finished.outputs.ticketIds.length,
      eventIds: finished.outputs.eventIds.length,
    })
    return finished
  }

  const executor = deps.executors.get(automation.type)
  if (!executor) {
    deps.logger.error('automation:executor-missing', { automationId: automation.id, runId: run.id, type: automation.type })
    return finish('failed', `没有 ${automation.type} 类型的执行器`, emptyOutputs(), `executor:unavailable:${automation.type}`)
  }

  const scheduleError = validateSchedule(automation.schedule)
  if (scheduleError) {
    deps.logger.error('automation:schedule-invalid', { automationId: automation.id, runId: run.id, message: scheduleError })
    return finish('failed', `触发计划不合法：${scheduleError}`, emptyOutputs(), 'schedule:invalid')
  }

  const tools = deps.toolsFor(automation)
  const workdir = deps.workdirFor(automation)
  const attempts = Math.max(0, deps.config().maxRetries) + 1
  let last: { status: 'success' | 'failed' | 'timeout'; summary: string; outputs: AutomationRunOutputs; error?: string } = {
    status: 'failed',
    summary: '未执行',
    outputs: emptyOutputs(),
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await executor.execute({
        automation,
        tools,
        timeoutMs: deps.config().timeoutMs,
        maxRetries: 0,
        workdir,
        logger: deps.logger,
        runId: run.id,
        ...(deps.reportPhase ? { onPhase: phase => deps.reportPhase?.(run, phase) } : {}),
      })
      last = { status: result.status, summary: result.summary, outputs: result.outputs, error: result.error }
    } catch (error) {
      deps.logger.error('automation:execute-failed', {
        automationId: automation.id,
        runId: run.id,
        attempt,
        message: errorMessage(error),
      })
      last = {
        status: 'failed',
        summary: `执行异常：${preview(errorMessage(error), 200)}`,
        outputs: emptyOutputs(),
        error: errorMessage(error),
      }
    }
    if (last.status === 'success') break
    if (attempt < attempts) {
      deps.logger.warn('automation:retry', { automationId: automation.id, runId: run.id, attempt, status: last.status })
    }
  }

  return finish(last.status, last.summary, last.outputs, last.error)
}

/**
 * 初始化调度状态：给还没算过下次触发的任务补一次。
 *
 * 服务启动时调用：刚建的任务立刻有下次触发时间，不用等面板再保存一次。
 */
export function initAutomationStates(
  tasks: Automation[],
  deps: Pick<AutomationSchedulerDeps, 'stateOf' | 'saveState'>,
  nowMs = Date.now(),
): void {
  for (const task of tasks) {
    const state = deps.stateOf(task.id)
    if (state.nextRunAt) continue
    const next = nextRunAt(task.schedule, new Date(nowMs))
    if (!next) continue
    deps.saveState({ taskId: task.id, nextRunAt: next })
  }
}
