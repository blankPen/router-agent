/**
 * 自动化运行时执行桥。
 *
 * 自动化不走工单派工链路（没有发起人、没有话题），但仍然走 runtime：
 * 起一个会话、把契约投进去、等它干完，再把结果与产出收回来。
 *
 * 这里只做「起会话 → 投递 → 等结束 → 收产出」四件事；
 * 具体怎么创建工作区由 runtime 自己决定（和工单派工一致）。
 */
import { writeFileSync } from 'node:fs'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Automation, AutomationRunOutputs } from '#core/automation.js'
import { preview } from '#core/events.js'
import { errorMessage } from '#infra/logger.js'
import type { Assignment, Ticket } from '#core/model.js'
import type { WorkerRuntime } from '#runtime/port.js'
import type { RuntimeRunInput, RuntimeRunOutcome } from './executor.js'

/** 轮询间隔（毫秒）：查一次会话状态要调 CLI，太密没意义。 */
const POLL_INTERVAL_MS = 2_000

/**
 * agent 报告完成用的文件名（写在工作目录里）。
 *
 * 用文件而不是 `ra automation finish` 命令：agent 跑的是用户机器上已安装的
 * ra，版本未必有那条命令；文件永远在。
 */
const RESULT_FILE = '.automation-result'

/** 执行桥需要的宿主能力。 */
export interface AutomationRunnerDeps {
  /** 状态与工单目录根。 */
  home: string
  /** 产出收集：执行期间新建的工单 / 事件。 */
  collectOutputs: (automation: Automation, since: string) => AutomationRunOutputs
  /**
   * agent 改过脚本时回调：把改后的正文写回任务定义。
   *
   * agent 会顺手修跑不起来的脚本；改动发生在 runtime 的工作目录里，
   * 不写回的话下一轮又跑那份旧的坏脚本。
   */
  onScriptChanged?: (automation: Automation, script: string) => void
  logger: {
    info(event: string, fields?: Record<string, unknown>): void
    warn(event: string, fields?: Record<string, unknown>): void
    error(event: string, fields?: Record<string, unknown>): void
  }
  /** 时钟；测试可注入固定时间。 */
  now?: () => number
  /** 轮询等待；测试可注入空等待，免掉真实的两秒间隔。 */
  sleep?: (ms: number) => Promise<void>
}

/** 自动化的内部工单号：让 runtime 的会话目录、状态文件都有地方落。 */
function automationTicketId(automation: Automation): string {
  return `au_${automation.id}`
}

/**
 * 合成一张内部工单。
 *
 * runtime 的接口以工单为中心（repo / branch / workdir 都从工单读），
 * 自动化没有真工单，就在这里造一张只用于跑会话的壳。
 */
function syntheticTicket(automation: Automation): Ticket {
  const now = new Date().toISOString()
  return {
    id: automationTicketId(automation),
    title: automation.name,
    threadId: `automation:${automation.id}`,
    source: `automation:${automation.id}`,
    chatId: `automation:${automation.id}`,
    mandateId: `md_${automation.id}`,
    stage: 'running',
    repo: automation.repo,
    branch: automation.branch,
    request: automation.prompt,
    requestActorName: `自动化 ${automation.name}`,
    prNumber: 0,
    prUrl: '',
    prState: 'none',
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 通过 runtime 执行一段任务文本，等它结束后收回产出。
 */
export async function runThroughRuntime(
  input: RuntimeRunInput,
  deps: AutomationRunnerDeps,
): Promise<RuntimeRunOutcome> {
  const { automation, runtime, timeoutMs } = input
  const now = deps.now ?? (() => Date.now())
  const startedAt = now()
  const ticket = syntheticTicket(automation)
  const ticketId = ticket.id
  const workerDir = join(deps.home, 'workers', ticketId)
  const assignment: Assignment = {
    id: `as_${automation.id}`,
    ticketId,
    runtimeId: runtime.id,
    handle: '',
    // 工作目录由 runtime 决定：它会在被选项目上开自己的 worktree。
    workdir: '',
    status: 'pending',
    startedAt: new Date(startedAt).toISOString(),
  }

  let handle = ''
  // runtime 决定的工作目录：它在被选项目上开 worktree，自动化不写到项目外。
  let workdir = ''
  input.onPhase?.('starting-runtime')
  try {
    const started = await runtime.start({
      ticket,
      assignment,
      // 空串：工作目录交给 runtime 在被选项目上开 worktree，
      // 这样自动化不会写到项目外的任何地方。
      workdir: '',
      report: {
        statePath: join(workerDir, 'state.json'),
        eventsPath: join(workerDir, 'events.log'),
      },
      brief: {
        ticketId,
        title: automation.name,
        scope: automation.prompt,
        workBranch: `ra/automation-${automation.id}`,
        contract: input.contract,
      },
      // 自动化是无人值守的：文件可写、shell 受限、默认不给网络。
      tools: {
        fileAccess: 'read-write',
        shell: 'allowlist',
        // bash / sh：脚本自动化要执行落盘的脚本；ra：调用自动化内置工具。
        shellAllow: ['ra', 'bash', 'sh', 'git', 'gh', 'glab', 'node', 'python3', 'pnpm', 'npm', 'npx'],
        allowNetwork: false,
      },
    })
    handle = started.handle
    workdir = started.workdir
    deps.logger.info('automation:runtime-started', {
      automationId: automation.id,
      ...(input.runId ? { runId: input.runId } : {}),
      runtime: runtime.id,
      handle,
      workdir,
    })
  } catch (error) {
    deps.logger.error('automation:runtime-start-failed', {
      automationId: automation.id,
      ...(input.runId ? { runId: input.runId } : {}),
      runtime: runtime.id,
      message: errorMessage(error),
    })
    return {
      status: 'failed',
      summary: `运行时启动失败：${preview(errorMessage(error), 200)}`,
      outputs: { ticketIds: [], eventIds: [] },
      error: errorMessage(error),
    }
  }

  const deadline = startedAt + timeoutMs
  const ref = { handle, ticketId, workdir }
  if (!workdir) {
    deps.logger.error('automation:runtime-workdir-missing', {
      automationId: automation.id,
      ...(input.runId ? { runId: input.runId } : {}),
      runtime: runtime.id,
    })
    await stopQuietly(runtime, ref, automation, deps, input.runId)
    return {
      status: 'failed',
      summary: '运行时没有返回工作目录，脚本未执行',
      outputs: { ticketIds: [], eventIds: [] },
      error: 'runtime:workdir-missing',
    }
  }
  // 脚本自动化：把落盘的脚本搬进 runtime 的工作目录，agent 才能执行它。
  if (input.script && input.scriptPath) {
    try {
      const target = join(workdir, 'automation.sh')
      writeFileSync(target, input.script, 'utf8')
      deps.logger.info('automation:script-staged', {
        automationId: automation.id,
        ...(input.runId ? { runId: input.runId } : {}),
        scriptPath: target,
      })
    } catch (error) {
      deps.logger.error('automation:script-stage-failed', {
        automationId: automation.id,
        ...(input.runId ? { runId: input.runId } : {}),
        workdir,
        message: errorMessage(error),
      })
      await stopQuietly(runtime, ref, automation, deps, input.runId)
      return {
        status: 'failed',
        summary: `脚本写入运行时工作目录失败：${preview(errorMessage(error), 200)}`,
        outputs: { ticketIds: [], eventIds: [] },
        error: errorMessage(error),
      }
    }
  }
  // 上一轮遗留的完成信号要先清掉：否则这一轮一开工就被判成「已完成」。
  try {
    rmSync(join(workdir, RESULT_FILE), { force: true })
  } catch (error) {
    deps.logger.warn('automation:result-clean-failed', {
      automationId: automation.id,
      ...(input.runId ? { runId: input.runId } : {}),
      workdir,
      message: errorMessage(error),
    })
  }
  try {
    input.onPhase?.('running')
    const outcome = await waitForCompletion(runtime, ref, deadline, now, deps, automation, workdir, deps.sleep ?? sleep, input.runId)
    input.onPhase?.('collecting')
    // agent 可能顺手修了跑不起来的脚本：改动要写回任务定义，下一轮才有意义。
    if (input.script) collectScriptChange(automation, input.script, workdir, deps, input.runId)
    const outputs = deps.collectOutputs(automation, new Date(startedAt).toISOString())
    if (outcome.status === 'success') {
      deps.logger.info('automation:runtime-finished', {
        automationId: automation.id,
        ...(input.runId ? { runId: input.runId } : {}),
        runtime: runtime.id,
        durationMs: now() - startedAt,
        ticketIds: outputs.ticketIds.length,
        eventIds: outputs.eventIds.length,
      })
    } else {
      deps.logger.error('automation:runtime-failed', {
        automationId: automation.id,
        ...(input.runId ? { runId: input.runId } : {}),
        runtime: runtime.id,
        durationMs: now() - startedAt,
        message: outcome.error ?? outcome.summary,
      })
    }
    return { ...outcome, outputs }
  } finally {
    // 结束会话：自动化是无人值守的，不能留一个常驻 worker 吃并发额度。
    await stopQuietly(runtime, ref, automation, deps, input.runId)
    await removeWorkspaceQuietly(runtime, ref, automation, deps, input.runId)
  }
}

/** 回收工作区；失败只记 warn，不覆盖真正的执行结论。 */
async function removeWorkspaceQuietly(
  runtime: WorkerRuntime,
  ref: { handle: string; ticketId: string; workdir: string },
  automation: Automation,
  deps: AutomationRunnerDeps,
  runId?: string,
): Promise<void> {
  // 运行时不支持回收就跳过：不是每个 runtime 都能回收工作区。
  if (!runtime.removeWorkspace) return
  try {
    // 自动化自己放进 worktree 的文件会让工作区变脏，provider 拒绝删。
    // 这两个文件的内容已经分别落在任务定义与执行记录里，删掉不丢信息。
    for (const name of ['automation.sh', RESULT_FILE]) {
      try {
        rmSync(join(ref.workdir, name), { force: true })
      } catch {
        // 删不掉就让 provider 自己拒绝：强删可能误伤 agent 的改动。
      }
    }
    await runtime.removeWorkspace({ ticketId: ref.ticketId, workdir: ref.workdir, repo: automation.repo })
    deps.logger.info('automation:workspace-removed', {
      automationId: automation.id,
      ...(runId ? { runId } : {}),
      workdir: ref.workdir,
    })
  } catch (error) {
    // 回收失败不影响执行结论：工作区留着也比把执行记录写成失败强。
    deps.logger.warn('automation:workspace-remove-failed', {
      automationId: automation.id,
      ...(runId ? { runId } : {}),
      workdir: ref.workdir,
      message: errorMessage(error),
    })
  }
}

/**
 * 读回工作目录里的脚本，和任务定义里的比一下。
 *
 * 变了才回调：agent 常常会「读一遍但没改」，不该每次都写回配置。
 */
function collectScriptChange(
  automation: Automation,
  original: string,
  workdir: string,
  deps: AutomationRunnerDeps,
  runId?: string,
): void {
  if (!deps.onScriptChanged) return
  const path = join(workdir, 'automation.sh')
  let current: string
  try {
    current = readFileSync(path, 'utf8')
  } catch (error) {
    // 读不到不是问题：脚本可能没落盘，用原定义继续跑。
    deps.logger.warn('automation:script-readback-failed', {
      automationId: automation.id,
      ...(runId ? { runId } : {}),
      path,
      message: errorMessage(error),
    })
    return
  }
  if (current.trim() === original.trim()) return
  deps.logger.info('automation:script-updated-by-agent', {
    automationId: automation.id,
    ...(runId ? { runId } : {}),
    chars: current.length,
  })
  deps.onScriptChanged(automation, current)
}

/** 停会话；失败只记 warn，不覆盖真正的执行结论。 */
async function stopQuietly(
  runtime: WorkerRuntime,
  ref: { handle: string; ticketId: string; workdir: string },
  automation: Automation,
  deps: AutomationRunnerDeps,
  runId?: string,
): Promise<void> {
  try {
    await runtime.stop(ref, 'automation:finished')
  } catch (error) {
    deps.logger.warn('automation:runtime-stop-failed', {
      automationId: automation.id,
      ...(runId ? { runId } : {}),
      runtime: runtime.id,
      message: errorMessage(error),
    })
  }
}

/** 轮询会话状态直到结束或超时。 */
async function waitForCompletion(
  runtime: WorkerRuntime,
  ref: { handle: string; ticketId: string; workdir: string },
  deadline: number,
  now: () => number,
  deps: AutomationRunnerDeps,
  automation: Automation,
  workdir: string,
  wait: (ms: number) => Promise<void>,
  runId?: string,
): Promise<Omit<RuntimeRunOutcome, 'outputs'>> {
  while (now() < deadline) {
    await wait(POLL_INTERVAL_MS)
    // agent 主动报告完成：立即收尾，不再等 runtime 会话自己退出。
    const reported = readResult(workdir)
    if (reported !== null) {
      const summary = reported
      return {
        status: 'success',
        summary: summary || `自动化 ${automation.name} 已完成`,
      }
    }
    let status
    try {
      status = await runtime.status?.(ref)
    } catch (error) {
      deps.logger.warn('automation:status-failed', {
        automationId: automation.id,
        ...(runId ? { runId } : {}),
        runtime: runtime.id,
        message: errorMessage(error),
      })
      continue
    }
    if (!status) continue
    if (status.phase === 'exited' || status.phase === 'lost') {
      const detail = await readOutput(runtime, ref, deps, automation, runId)
      const exitFailed = status.phase === 'exited' && (status.exitCode ?? 0) !== 0
      return {
        status: status.phase === 'lost' || exitFailed ? 'failed' : 'success',
        summary: detail || `自动化 ${automation.name} 已结束`,
        ...(status.phase === 'lost'
          ? { error: '运行时会话丢失' }
          : exitFailed
            ? { error: `运行时退出码 ${status.exitCode}` }
            : {}),
      }
    }
    if (status.phase === 'blocked') {
      const detail = await readOutput(runtime, ref, deps, automation, runId)
      return {
        status: 'failed',
        summary: detail || `自动化 ${automation.name} 需要人工介入`,
        error: '运行时停在需要人工确认的状态',
      }
    }
  }
  return {
    status: 'timeout',
    summary: `自动化 ${automation.name} 执行超时`,
    error: 'timeout',
  }
}

/**
 * 读 agent 写的完成信号文件。
 *
 * 文件不存在说明 agent 还在干；存在则内容就是本次执行的摘要。
 * 内容为空也算完成：agent 可能只想说「做完了」。
 */
function readResult(dir: string): string | null {
  const path = join(dir, RESULT_FILE)
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    // 读不到就当没写：继续等，超时兜底。
    return null
  }
}

/** 读会话尾部输出当结果摘要。 */
async function readOutput(
  runtime: WorkerRuntime,
  ref: { handle: string; ticketId: string; workdir: string },
  deps: AutomationRunnerDeps,
  automation: Automation,
  runId?: string,
): Promise<string> {
  try {
    const output = await runtime.output?.(ref, { limit: 40 })
    if (!output) return ''
    return output.lines.slice(-12).map(line => line.trim()).filter(Boolean).join('\n')
  } catch (error) {
    // 读不到输出不影响执行结论：记一条 warn 后按空摘要继续，失败原因仍可从会话状态判断。
    deps.logger.warn('automation:output-failed', {
      automationId: automation.id,
      ...(runId ? { runId } : {}),
      runtime: runtime.id,
      message: errorMessage(error),
    })
    return ''
  }
}

/** 等待；测试可注入 sleep。 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
