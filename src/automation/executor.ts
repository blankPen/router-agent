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
  AutomationTool,
  AutomationType,
} from '#core/automation.js'
import { errorMessage } from '#infra/logger.js'
import type { WorkerRuntime } from '#runtime/port.js'

/** 执行器需要的宿主能力。 */
export interface AutomationExecutorDeps {
  /** runtime 注册表；按任务选的 runtime id 取适配器，不硬编码任何一个。 */
  runtimes: { get(id: string): WorkerRuntime; has(id: string): boolean; default(): WorkerRuntime }
  /** 生成脚本正文；模型不可用时返回 null，执行器会退化成只用提示词。 */
  generateScript?: (automation: Automation) => Promise<string | null>
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
    const runtime = runtimeOf(this.deps, automation)
    // 脚本正文优先用已持久化的那份：面板人工编辑过的内容要真的被执行。
    let script = automation.script?.trim() ?? ''
    if (!script && this.deps.generateScript) {
      logger.info('automation:script-generating', { automationId: automation.id })
      try {
        script = (await this.deps.generateScript(automation))?.trim() ?? ''
      } catch (error) {
        logger.error('automation:script-generate-failed', {
          automationId: automation.id,
          message: errorMessage(error),
        })
        return { status: 'failed', summary: '脚本生成失败', outputs: emptyOutputs(), error: errorMessage(error) }
      }
      if (!script) {
        logger.warn('automation:script-empty', { automationId: automation.id })
        return { status: 'failed', summary: '脚本生成结果为空', outputs: emptyOutputs() }
      }
    }
    if (!script) {
      logger.warn('automation:script-missing', { automationId: automation.id })
      return { status: 'failed', summary: '任务没有脚本正文，也没有生成脚本的能力', outputs: emptyOutputs() }
    }

    mkdirSync(workdir, { recursive: true })
    const scriptPath = join(workdir, 'automation.sh')
    try {
      writeFileSync(scriptPath, script, 'utf8')
    } catch (error) {
      logger.error('automation:script-write-failed', {
        automationId: automation.id,
        scriptPath,
        message: errorMessage(error),
      })
      return { status: 'failed', summary: '脚本落盘失败', outputs: emptyOutputs(), error: errorMessage(error) }
    }
    logger.info('automation:execute-start', {
      automationId: automation.id,
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
    ...tools.map(tool => `- \`${tool.name}\`：${tool.description}`),
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
    '',
    '## 可用工具',
    ...tools.map(tool => `- \`${tool.name}\`：${tool.description}`),
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
  ].filter(line => line !== '').join('\n')
}

/** 装配默认执行器注册表。 */
export function createAutomationExecutors(deps: AutomationExecutorDeps): AutomationExecutorRegistry {
  const registry = new AutomationExecutorRegistry()
  registry.register(new AiAutomationExecutor(deps))
  registry.register(new ScriptAutomationExecutor(deps))
  return registry
}
