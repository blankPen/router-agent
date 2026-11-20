/**
 * 自动化执行器：两种类型共用一条执行管线。
 *
 * 统一入参（提示词/脚本 + 目标项目 + 上下文）、统一工具注入、
 * 统一超时与失败重试、统一执行记录。
 *
 * 执行本身走现有 runtime 调用链：脚本自动化不是另起一个解释器，
 * 而是先把脚本落盘，再让 runtime 在被选项目的工作目录里执行它。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  Automation,
  AutomationExecutionInput,
  AutomationExecutionResult,
  AutomationExecutor,
  AutomationRunOutputs,
  AutomationRunPhase,
  AutomationTool,
  AutomationType,
} from '#core/automation.js'
import { errorMessage } from '#infra/logger.js'
import type { WorkerRuntime } from '#runtime/port.js'

/** 执行器需要的宿主能力。 */
export interface AutomationExecutorDeps {
  /** runtime 注册表；按任务选的 runtime id 取适配器，不硬编码任何一个。 */
  runtimes: { get(id: string): WorkerRuntime; has(id: string): boolean; default(): WorkerRuntime }
  /** 把任务交给 runtime 执行并等结果；两种类型都走这一个口子。 */
  runViaRuntime?: (input: RuntimeRunInput) => Promise<RuntimeRunOutcome>
}

/** 交给 runtime 的一次执行。 */
export interface RuntimeRunInput {
  automation: Automation
  runtime: WorkerRuntime
  /** 投给 runtime 的正文（契约）：AI 自动化是任务契约，脚本自动化是「执行这个脚本」的指令。 */
  contract: string
  /** 脚本正文（已落盘）；AI 自动化为空。 */
  script?: string
  /** 脚本文件路径；脚本自动化有，AI 自动化为空。 */
  scriptPath?: string
  /** 工作目录：限定在被选项目范围内。 */
  workdir: string
  /** 注入给任务的工具说明。 */
  tools: AutomationTool[]
  /** 硬超时（毫秒）。 */
  timeoutMs: number
  /** 本次执行的记录 id；日志带上它才能把一条执行记录和它的日志串起来。 */
  runId?: string
  /** 上报当前阶段；面板据此显示「跑到哪一步了」。 */
  onPhase?: (phase: AutomationRunPhase) => void
}

/** 一次执行的结果。 */
export interface RuntimeRunOutcome {
  status: 'success' | 'failed' | 'timeout'
  summary: string
  outputs: AutomationRunOutputs
  error?: string
}

/** 执行器注册表：自动化类型 → 执行器。 */
export class AutomationExecutorRegistry {
  private readonly executors = new Map<AutomationType, AutomationExecutor>()

  register(executor: AutomationExecutor): void {
    this.executors.set(executor.type, executor)
  }

  get(type: AutomationType): AutomationExecutor | undefined {
    return this.executors.get(type)
  }

  types(): AutomationType[] {
    return [...this.executors.keys()]
  }
}

/** 选中的 runtime：任务指定优先，留空跟随默认。 */
function runtimeOf(deps: AutomationExecutorDeps, automation: Automation): WorkerRuntime {
  const id = automation.runtimeId.trim()
  if (!id) return deps.runtimes.default()
  if (!deps.runtimes.has(id)) throw new Error(`runtime:unknown: ${id}`)
  return deps.runtimes.get(id)
}

/**
 * AI 自动化执行器：把提示词交给 runtime 在目标项目里跑。
 *
 * 工具通过任务契约注入，不靠模型自己猜命令。
 */
class AiAutomationExecutor implements AutomationExecutor {
  readonly type: AutomationType = 'ai'

  constructor(private readonly deps: AutomationExecutorDeps) {}

  async execute(input: AutomationExecutionInput): Promise<AutomationExecutionResult> {
    const { automation, tools, timeoutMs, logger } = input
    const runtime = runtimeOf(this.deps, automation)
    logger.info('automation:execute-start', {
      automationId: automation.id,
      ...(input.runId ? { runId: input.runId } : {}),
      type: automation.type,
      runtime: runtime.id,
      project: automation.project,
      timeoutMs,
    })
    const outcome = await this.deps.runViaRuntime?.({
      automation,
      runtime,
      contract: buildContract(automation, tools),
      workdir: input.workdir,
      tools,
      timeoutMs,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.onPhase ? { onPhase: input.onPhase } : {}),
    })
    if (!outcome) {
      // 没有 runtime 执行能力（装配不完整）：不算失败，但要让调用方看到没跑起来。
      return { status: 'failed', summary: '自动化执行器未装配运行时能力', outputs: emptyOutputs() }
    }
    return {
      status: outcome.status,
      summary: outcome.summary,
      outputs: outcome.outputs,
      ...(outcome.error ? { error: outcome.error } : {}),
    }
  }
}

/**
 * 脚本自动化执行器：先用 AI 生成脚本并持久化，再让 runtime 执行脚本。
 *
 * 脚本落盘后不再每次重新生成：面板可以查看与人工编辑，执行的也是人工确认过的那份。
 */
class ScriptAutomationExecutor implements AutomationExecutor {
  readonly type: AutomationType = 'script'

  constructor(private readonly deps: AutomationExecutorDeps) {}

  async execute(input: AutomationExecutionInput): Promise<AutomationExecutionResult> {
    const { automation, tools, timeoutMs, logger, workdir } = input
    // 脚本正文优先用已持久化的那份：面板人工编辑过的内容要真的被执行。
    let script = automation.script?.trim() ?? ''
    if (!script) {
      // 不在执行时偷偷生成脚本：生成结果要人工在面板确认过才算数。
      logger.warn('automation:script-missing', {
        automationId: automation.id,
        ...(input.runId ? { runId: input.runId } : {}),
      })
      return {
        status: 'failed',
        summary: '还没有脚本正文：请在面板点「生成脚本」，确认后再执行',
        outputs: emptyOutputs(),
        error: 'script:missing',
      }
    }
    const runtime = runtimeOf(this.deps, automation)

    mkdirSync(workdir, { recursive: true })
    const scriptPath = join(workdir, 'automation.sh')
    try {
      writeFileSync(scriptPath, script, 'utf8')
    } catch (error) {
      logger.error('automation:script-write-failed', {
        automationId: automation.id,
        ...(input.runId ? { runId: input.runId } : {}),
        scriptPath,
        message: errorMessage(error),
      })
      return { status: 'failed', summary: '脚本落盘失败', outputs: emptyOutputs(), error: errorMessage(error) }
    }
    logger.info('automation:execute-start', {
      automationId: automation.id,
      ...(input.runId ? { runId: input.runId } : {}),
      type: automation.type,
      runtime: runtime.id,
      project: automation.project,
      timeoutMs,
      scriptPath,
    })
    const outcome = await this.deps.runViaRuntime?.({
      automation,
      runtime,
      contract: buildScriptContract(automation, tools),
      script,
      scriptPath,
      workdir,
      tools,
      timeoutMs,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.onPhase ? { onPhase: input.onPhase } : {}),
    })
    if (!outcome) {
      return { status: 'failed', summary: '自动化执行器未装配运行时能力', outputs: emptyOutputs() }
    }
    return {
      status: outcome.status,
      summary: outcome.summary,
      outputs: outcome.outputs,
      ...(outcome.error ? { error: outcome.error } : {}),
    }
  }
}

/** 空产出。 */
export function emptyOutputs(): AutomationRunOutputs {
  return { ticketIds: [], eventIds: [] }
}

/**
 * 把一条工具写进契约。
 *
 * 光给工具名和一句说明不够：模型不知道这个工具要传哪些参数，
 * 只能靠猜——猜错的代价是一次 `missing-<参数>` 的拒绝，
 * 表现为自动化反复调同一个工具却拿不到结果。
 * 所以入参 schema 一起写进契约，必填项单独点名。
 */
export function describeTool(tool: AutomationTool): string {
  const lines = [`- \`${tool.name}\`：${tool.description}`]
  const params = toolParams(tool)
  if (params.length === 0) return lines.join('\n')
  lines.push(`  参数：${params.join('；')}`)
  return lines.join('\n')
}

/** 工具入参的摘要：名字、类型与必填项。 */
function toolParams(tool: AutomationTool): string[] {
  const properties = tool.parameters?.properties
  if (!properties || typeof properties !== 'object') return []
  const required = Array.isArray(tool.parameters?.required)
    ? (tool.parameters.required as unknown[]).map(item => String(item))
    : []
  return Object.entries(properties as Record<string, { type?: string; description?: string }>).map(
    ([name, schema]) => {
      const type = schema?.type ?? 'string'
      const desc = schema?.description ? `（${schema.description}）` : ''
      const flag = required.includes(name) ? '必填' : '可选'
      return `${name}: ${type} ${flag}${desc}`
    },
  )
}

/**
 * 任务契约：拼给 runtime 的正文。
 *
 * 工具清单写进契约，模型才知道有哪些能力可用；凭据不进契约，
 * 需要凭据的动作由工具内部复用现有配置去取。
 */
export function buildContract(automation: Automation, tools: AutomationTool[]): string {
  const lines: string[] = [
    `# 自动化任务 ${automation.name}`,
    '',
    automation.description ? `说明：${automation.description}` : '',
    '',
    '## 目标',
    automation.prompt,
    '',
    '## 执行环境',
    `- 项目：${automation.project}`,
    `- 仓库：${automation.repo}`,
    automation.branch ? `- 起始分支：${automation.branch}` : '',
    '',
    '## 可用工具',
    ...tools.map(describeTool),
    '',
    '## 怎么调用工具',
    '用命令行调用（在本任务的工作目录里执行）：',
    '```',
    `ra automation tool --id ${automation.id} --name <工具名> --args '<JSON 入参>'`,
    '```',
    '工具只能操作本任务所属项目的数据；凭据由工具内部取，不要自己找密钥。',
    '',
    '## 约束',
    '- 只在本任务的目标项目范围内操作；不改其它仓库。',
    '- 不访问未授权资源，不使用任何硬编码凭据。',
    '- 需要人工介入时不要自行扩大范围，把结论写进产出。',
    '',
    '## 什么时候结束',
    '这是一次无人值守的定时执行：做完上面的目标就立刻结束，不要继续探索、不要修无关的东西。',
    '结束时把「这次做了什么」写进工作目录下的 `.automation-result` 文件（一行字即可），然后就不要再做任何事：',
    '```',
    'echo "这次做了什么" > .automation-result',
    '```',
    '不写这个文件的话，本次执行只能等到超时才结束。',
  ]
  return lines.filter(line => line !== '').join('\n')
}

/**
 * 脚本自动化契约：告诉 runtime 去执行落盘的那份脚本。
 *
 * 脚本正文已经持久化在 scriptPath，人工改过就是以那份为准。
 */
export function buildScriptContract(automation: Automation, tools: AutomationTool[]): string {
  return [
    `# 自动化任务 ${automation.name}`,
    '',
    automation.description ? `说明：${automation.description}` : '',
    '',
    '## 要做什么',
    automation.prompt,
    '',
    '## 执行环境',
    `- 项目：${automation.project}`,
    `- 仓库：${automation.repo}`,
    automation.branch ? `- 起始分支：${automation.branch}` : '',
    '',
    '## 执行方式',
    '脚本已经写好并放在工作目录里，请执行它：`bash automation.sh`。',
    '执行完把结果摘要写进产出；脚本失败时如实报告原因，不要重试或绕过。',
    '脚本跑完就结束：不要顺手改脚本，除非脚本本身跑不起来（这时修好后重跑一次，仍失败就如实报告）。',
    '',
    '## 可用工具',
    ...tools.map(describeTool),
    '',
    '## 怎么调用工具',
    '用命令行调用（在本任务的工作目录里执行）：',
    '```',
    `ra automation tool --id ${automation.id} --name <工具名> --args '<JSON 入参>'`,
    '```',
    '工具只能操作本任务所属项目的数据；凭据由工具内部取，不要自己找密钥。',
    '',
    '## 约束',
    '- 只在本任务的目标项目范围内操作；不改其它仓库。',
    '- 不访问未授权资源，不使用任何硬编码凭据。',
    '',
    '## 什么时候结束',
    '这是一次无人值守的定时执行：脚本跑完（成功或失败）就立刻结束，不要继续探索、不要修无关的东西。',
    '结束时把「脚本跑了什么、发现了什么、有没有产出」写进工作目录下的 `.automation-result` 文件（一行字即可），然后就不要再做任何事：',
    '```',
    'echo "脚本跑了什么" > .automation-result',
    '```',
    '不写这个文件的话，本次执行只能等到超时才结束。',
  ].filter(line => line !== '').join('\n')
}

/** 装配默认执行器注册表。 */
export function createAutomationExecutors(deps: AutomationExecutorDeps): AutomationExecutorRegistry {
  const registry = new AutomationExecutorRegistry()
  registry.register(new AiAutomationExecutor(deps))
  registry.register(new ScriptAutomationExecutor(deps))
  return registry
}
