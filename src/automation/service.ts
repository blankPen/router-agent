/**
 * 自动化服务：把配置、工具、执行器与调度器装配成一个可用的能力。
 *
 * 服务层只做装配与编排：
 * - 任务定义在配置里（与 events 同级），面板与对话入口共用同一套增删改查；
 * - 工具注入统一走工具注册表，两种类型共用一份定义；
 * - 执行记录落状态库，面板的「执行记录」页直接读。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Automation, AutomationRun, AutomationRunOutputs, AutomationRunPhase, AutomationSchedule, AutomationTool } from '#core/automation.js'
import { scheduleOf } from '#core/automation.js'
import { nextRunAt, validateSchedule } from '#core/automation-schedule.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import type { ChatClient } from '#infra/chat.js'
import type { Store } from '../store/db.js'
import type { Engine } from '../core/engine.js'
import type { AppConfig, AutomationTaskConfig } from '../config.js'
import { BuiltinAutomationTools, scopedTools } from './tools.js'
import { AutomationRateLimiter } from './tools.js'
import { createAutomationExecutors, type AutomationExecutorRegistry } from './executor.js'
import { runThroughRuntime } from './runner.js'
import { executeRun, initAutomationStates, startRun, tickAutomations, type AutomationSchedulerDeps } from './scheduler.js'
import { extractJsonObject } from '../router/model-config.js'
import type { RuntimeRegistry } from '#runtime/registry.js'

/** 去掉模型常见的 markdown 代码围栏：脚本正文不该带 ```bash 这种壳。 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed)
  return (fenced ? fenced[1] ?? '' : trimmed).trim()
}

/** 自动化服务需要的宿主能力。 */
export interface AutomationServiceDeps {
  /** 当前配置（面板改完立即生效）。 */
  config: () => AppConfig
  store: Store
  engine: Engine
  runtimes: RuntimeRegistry
  logger?: Logger
  /** 脚本生成用的模型客户端；没配模型时脚本自动化只能人工填脚本。 */
  chat?: ChatClient | null
  /** 事件写入能力：工具要把新事件写进收件箱。 */
  ingestEvent?: (input: { title: string; body: string; eventType: string; project: string; repo: string; automationId: string }) => string | null
  /** 生成的脚本回写任务定义；不注入时脚本只在执行目录里，面板看不到。 */
  saveTaskScript?: (taskId: string, script: string) => void
  /** 时钟；测试可注入固定时间。 */
  now?: () => number
}

/** 调度轮询间隔（毫秒）。 */
const AUTOMATION_TICK_MS = 30_000

/** 脚本生成的输出额度：脚本比一句话长得多，默认 2000 不够写。 */
const SCRIPT_GENERATION_MAX_TOKENS = 8_000

/** 脚本生成的思考预算：推理模型的思考也占输出额度，必须给正文留出空间。 */
const SCRIPT_GENERATION_THINKING_BUDGET = 1_024

/** 脚本生成的硬超时：推理模型写脚本常常要一分多钟。 */
const SCRIPT_GENERATION_TIMEOUT_MS = 180_000

/** 面板用的自动化视图。 */
export interface AutomationView {
  id: string
  name: string
  description: string
  type: Automation['type']
  prompt: string
  script?: string
  /** 触发方式：事件订阅或定时计划。 */
  trigger: Automation['trigger']
  skill: string
  notifyTo: string
  /** 绑定的会话 id；面板任务卡的「恢复会话」用它找回原会话。 */
  conversationId?: string
  runtimeId: string
  project: string
  repo: string
  branch: string
  enabled: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
  nextRunAt?: string
  lastRunAt?: string
  lastStatus?: AutomationRun['status']
}

/** 执行记录的视图。 */
export interface AutomationRunView {
  id: string
  automationId: string
  automationName: string
  scheduledAt: string
  startedAt: string
  finishedAt?: string
  durationMs?: number
  status: AutomationRun['status']
  summary: string
  error?: string
  /** 执行中的当前阶段；结束后为空。 */
  phase?: AutomationRun['phase']
  outputs: AutomationRunOutputs
  manual: boolean
}

/** 模型整理草稿的结果。 */
type ParsedDraft =
  | { kind: 'draft'; draft: Automation }
  | { kind: 'uncertain'; question: string }
  | { kind: 'none' }
  | { kind: 'unavailable' }

/** 自动化服务。 */
export class AutomationService {
  private configFn: () => AppConfig
  private store: Store
  private engine: Engine
  private runtimes: RuntimeRegistry
  private logger: Logger
  private chat: ChatClient | null
  private ingestEvent?: AutomationServiceDeps['ingestEvent']
  private saveTaskScript?: AutomationServiceDeps['saveTaskScript']
  private now: () => number
  private executors: AutomationExecutorRegistry
  private tools: BuiltinAutomationTools
  /** 工具调用限流器：按自动化任务维度计数。 */
  private limiter: AutomationRateLimiter
  /** 调度定时器；不传时由 start() 装。 */
  private timer: ReturnType<typeof setInterval> | null = null
  /** 在途的一轮调度：防止长任务还没结束时下一轮重复触发同一条。 */
  private tickInFlight: Promise<AutomationRun[]> | null = null

  constructor(deps: AutomationServiceDeps) {
    this.configFn = deps.config
    this.store = deps.store
    this.engine = deps.engine
    this.runtimes = deps.runtimes
    this.logger = deps.logger ?? noopLogger
    this.chat = deps.chat ?? null
    this.ingestEvent = deps.ingestEvent
    this.saveTaskScript = deps.saveTaskScript
    this.now = deps.now ?? (() => Date.now())
    this.limiter = new AutomationRateLimiter()
    this.tools = new BuiltinAutomationTools({
      store: this.store,
      engine: this.engine,
      ...(this.ingestEvent ? { ingestEvent: this.ingestEvent } : {}),
    })
    this.executors = createAutomationExecutors({
      runtimes: this.runtimes,
      runViaRuntime: async input => runThroughRuntime(input, {
        home: this.config().home,
        collectOutputs: (automation, since) => this.collectOutputs(automation, since),
        // agent 顺手修好的脚本写回任务定义，下一轮跑的是修好的那份。
        onScriptChanged: (automation, script) => this.saveTaskScript?.(automation.id, script),
        logger: this.logger,
        now: this.now,
      }),
    })
  }

  /** 当前配置。 */
  private config(): AppConfig {
    return this.configFn()
  }

  // ---------- 任务 ----------

  /** 任务列表（含调度状态）。 */
  list(): AutomationView[] {
    return this.tasks().map(task => this.view(task))
  }

  /** 任务视图。 */
  view(task: Automation): AutomationView {
    const state = this.store.getAutomationState(task.id)
    return {
      id: task.id,
      name: task.name,
      description: task.description,
      type: task.type,
      prompt: task.prompt,
      ...(task.script ? { script: task.script } : {}),
      trigger: task.trigger,
      skill: task.skill ?? '',
      notifyTo: task.notifyTo ?? '',
      ...(task.conversationId ? { conversationId: task.conversationId } : {}),
      runtimeId: task.runtimeId,
      project: task.project,
      repo: task.repo,
      branch: task.branch,
      enabled: task.enabled,
      createdBy: task.createdBy,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      ...(state?.nextRunAt ? { nextRunAt: state.nextRunAt } : {}),
      ...(state?.lastRunAt ? { lastRunAt: state.lastRunAt } : {}),
      ...(state?.lastStatus ? { lastStatus: state.lastStatus } : {}),
    }
  }

  /** 找一条任务。 */
  find(id: string): Automation | undefined {
    return this.tasks().find(task => task.id === id)
  }

  /** 当前配置里的任务列表。 */
  private tasks(): Automation[] {
    return this.config().automation.tasks as Automation[]
  }

  /** 执行记录列表。 */
  runs(filter: { automationId?: string; limit?: number } = {}): AutomationRunView[] {
    const names = new Map(this.tasks().map(task => [task.id, task.name]))
    return this.store.listAutomationRuns(filter).map(run => ({
      id: run.id,
      automationId: run.automationId,
      automationName: names.get(run.automationId) ?? run.automationId,
      scheduledAt: run.scheduledAt,
      startedAt: run.startedAt,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
      status: run.status,
      summary: run.summary,
      ...(run.error ? { error: run.error } : {}),
      ...(run.phase ? { phase: run.phase } : {}),
      outputs: run.outputs,
      manual: run.manual,
    }))
  }

  /** 单条执行记录；面板轮询它来看执行进度。 */
  run(id: string): AutomationRunView | null {
    const found = this.store.getAutomationRun(id)
    if (!found) return null
    const names = new Map(this.tasks().map(task => [task.id, task.name]))
    return {
      id: found.id,
      automationId: found.automationId,
      automationName: names.get(found.automationId) ?? found.automationId,
      scheduledAt: found.scheduledAt,
      startedAt: found.startedAt,
      ...(found.finishedAt ? { finishedAt: found.finishedAt } : {}),
      ...(found.durationMs !== undefined ? { durationMs: found.durationMs } : {}),
      status: found.status,
      summary: found.summary,
      ...(found.error ? { error: found.error } : {}),
      ...(found.phase ? { phase: found.phase } : {}),
      outputs: found.outputs,
      manual: found.manual,
    }
  }

  // ---------- 调度 ----------

  /**
   * 启动调度器：随服务起停。
   *
   * 定时器在服务进程内，任务定义与执行记录分别在配置与状态库里。
   */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, AUTOMATION_TICK_MS)
    this.timer.unref?.()
    this.logger.info('automation:scheduler-started', { tasks: this.tasks().length })
  }

  /** 停掉调度器。 */
  async stop(): Promise<void> {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    // 停服前等在途一轮收尾：它可能正在写执行记录，早关库会丢状态。
    if (this.tickInFlight) await this.tickInFlight.catch(() => {})
    this.logger.info('automation:scheduler-stopped', {})
  }

  /** 服务启动时初始化调度状态。 */
  initStates(): void {
    initAutomationStates(this.tasks(), {
      stateOf: id => this.store.getAutomationState(id) ?? { taskId: id },
      saveState: state => this.store.upsertAutomationState(state),
    }, this.now())
  }

  /**
   * 收尾上一轮没跑完的执行记录。
   *
   * 服务重启时，上一轮正在跑的自动化已经没人接手了；
   * 记录一直挂在「执行中」会让人以为它还在跑。
   */
  closeStaleRuns(): void {
    const count = this.store.closeStaleAutomationRuns(
      'interrupted',
      '服务重启，上一轮执行被中断',
    )
    if (count > 0) this.logger.warn('automation:runs-interrupted', { count })
  }

  /**
   * 跑一轮调度。
   *
   * 每轮先补齐新任务的下次触发时间：面板刚建的任务不用等重启就能排上期。
   */
  tick(): Promise<AutomationRun[]> {
    // 上一轮还在跑（runtime 任务可能耗时几分钟）：直接复用它的 promise，不重复触发。
    if (this.tickInFlight) return this.tickInFlight
    this.tickInFlight = this.runTick().finally(() => {
      this.tickInFlight = null
    })
    return this.tickInFlight
  }

  /** 实际跑一轮调度。 */
  private async runTick(): Promise<AutomationRun[]> {
    this.initStates()
    const result = await tickAutomations(this.schedulerDeps())
    return result.runs
  }

  /** 手动触发一次。 */
  async trigger(id: string): Promise<AutomationRun | null> {
    const task = this.find(id)
    if (!task) return null
    this.logger.info('automation:manual-trigger', { automationId: id, name: task.name })
    // 手动触发不等执行结束：先落一条 running 记录就返回，面板靠轮询看进度。
    // 一次执行可能跑满 10 分钟，同步等会把 HTTP 请求挂在那里。
    const started = startRun(task, new Date(this.now()).toISOString(), this.schedulerDeps(), true)
    void this.runToEnd(task, started)
    return started
  }

  /**
 * 把一次执行跑完并收尾记录。
   *
 * 手动触发在后台走这条路径：执行出错只记日志，不让未处理的 rejection 掀翻服务。
   */
  private async runToEnd(task: Automation, run: AutomationRun): Promise<AutomationRun> {
    try {
      return await executeRun(task, run, this.schedulerDeps())
    } catch (error) {
      this.logger.error('automation:run-crashed', {
        automationId: task.id,
        runId: run.id,
        message: errorMessage(error),
      })
      return run
    }
  }

  /** 调度器依赖。 */
  private schedulerDeps(): AutomationSchedulerDeps {
    return {
      config: () => this.config().automation as never,
      executors: this.executors,
      recordRun: run => this.store.insertAutomationRun(run),
      updateRun: run => this.store.updateAutomationRun(run),
      stateOf: id => this.store.getAutomationState(id) ?? { taskId: id },
      saveState: state => this.store.upsertAutomationState(state),
      nextRunId: () => `run_${crypto.randomUUID()}`,
      toolsFor: task => this.toolsFor(task),
      workdirFor: task => this.workdirFor(task),
      reportPhase: (run, phase) => this.reportPhase(run, phase),
      logger: this.logger,
      now: this.now,
    }
  }

  /**
   * 把执行中的阶段写回执行记录。
   *
 * 面板据此显示「跑到哪一步了」：只在阶段真的变了才写库，
   * 免得轮询阶段把数据库写爆。
   */
  private reportPhase(run: AutomationRun, phase: AutomationRunPhase): void {
    if (run.phase === phase) return
    const next: AutomationRun = { ...run, phase }
    run.phase = phase
    // 只写 phase 列：摘要可能已经被 agent 的完成信号写过了。
    this.store.updateAutomationRunPhase(next.id, phase)
    this.logger.info('automation:run-phase', { automationId: run.automationId, runId: run.id, phase })
  }

  /** 绑定到任务的项目范围的工具集。 */
  toolsFor(task: Automation): AutomationTool[] {
    return scopedTools(this.tools, {
      automationId: task.id,
      project: task.project,
      repo: task.repo,
      ...(task.branch ? { branch: task.branch } : {}),
    }, { limiter: this.limiter, now: this.now })
  }

  /**
   * 调用内置工具。
   *
   * runtime 里的 agent 通过 API 调它：范围（项目）与限流在这里强制，
   * 工具定义与凭据都不出这个边界。
   */
  async invokeTool(
    automationId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; error: string; hint?: string; result?: unknown }> {
    const task = this.find(automationId)
    if (!task) return { ok: false, status: 404, error: 'automation:not-found' }
    const tool = this.tools.get(name)
    if (!tool) return { ok: false, status: 404, error: `tool:not-found:${name}` }
    // 从已绑定范围的工具集里取同一个工具：范围与限流都在绑定那一步套上。
    const bound = this.toolsFor(task).find(item => item.name === name)
    if (!bound) return { ok: false, status: 404, error: `tool:not-found:${name}` }
    let outcome: unknown
    try {
      outcome = await bound.handler(args, {
        automationId: task.id,
        project: task.project,
        repo: task.repo,
        ...(task.branch ? { branch: task.branch } : {}),
      })
    } catch (error) {
      this.logger.error('automation:tool-failed', {
        automationId: task.id,
        tool: name,
        message: errorMessage(error),
      })
      return { ok: false, status: 500, error: 'tool:failed', hint: errorMessage(error) }
    }
    // 工具用统一的 { error, hint } 形状报告失败，不抛异常：模型读得懂。
    const failure = outcome as { error?: unknown; hint?: unknown } | null
    if (failure && typeof failure === 'object' && typeof failure.error === 'string') {
      this.logger.warn('automation:tool-rejected', {
        automationId: task.id,
        tool: name,
        error: failure.error,
      })
      return {
        ok: false,
        status: 400,
        error: failure.error,
        ...(typeof failure.hint === 'string' ? { hint: failure.hint } : {}),
      }
    }
    this.logger.info('automation:tool-invoked', { automationId: task.id, tool: name })
    return { ok: true, status: 200, error: '', result: outcome }
  }

  /**
   * 脚本与产物的落盘目录。
   *
   * 放在 Router 状态目录（`<home>/automations/<任务 id>`）里，不写进用户的仓库：
   * 执行的工作目录由 runtime 决定（它在被选项目上开 worktree），
   * 脚本正文是给 runtime 执行的一次性输入，不该污染项目的 git 工作区。
   */
  workdirFor(task: Automation): string {
    const dir = join(this.config().home, 'automations', task.id)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** 执行期间新建的工单 / 事件。 */
  private collectOutputs(task: Automation, since: string): AutomationRunOutputs {
    const ticketIds: string[] = []
    const eventIds: string[] = []
    for (const ticket of this.store.listTickets({ limit: 500 })) {
      if (ticket.repo !== task.repo) continue
      if (ticket.createdAt < since) continue
      if (ticket.source !== `automation:${task.id}`) continue
      ticketIds.push(ticket.id)
    }
    for (const event of this.store.listEvents({ limit: 500 })) {
      if (event.receivedAt < since) continue
      if (event.sourceId !== `automation:${task.id}`) continue
      eventIds.push(event.id)
    }
    return { ticketIds, eventIds }
  }

  // ---------- 脚本生成 ----------

  /**
   * 为某个任务生成脚本正文（面板「生成脚本」按钮）。
   *
   * 生成后直接写回任务定义：脚本从此固定下来，人工可以在面板继续改。
   * 定时执行跑的就是这份脚本，不会每次重新生成。
   */
  async generateScriptFor(id: string): Promise<string | null> {
    const task = this.find(id)
    if (!task) return null
    if (task.type !== 'script') {
      this.logger.warn('automation:script-generate-rejected', { automationId: id, reason: 'not-script-type' })
      return null
    }
    return this.generateScript(task)
  }

  /**
   * 为某个任务生成脚本，并把失败原因一起带出来。
   *
   * 只返回 null 的话，调用方只能给出「生成失败，请重试」这种空话：
   * 用户分不清是模型没配、是超时，还是额度被思考吃光。
   * 这里把真实原因带回去，面板才能说清到底卡在哪。
   */
  async generateScriptWithReason(id: string): Promise<{ script: string } | { error: string; reason: string }> {
    const task = this.find(id)
    if (!task) return { error: 'automation-not-found', reason: '找不到这个自动化任务' }
    if (task.type !== 'script') {
      this.logger.warn('automation:script-generate-rejected', { automationId: id, reason: 'not-script-type' })
      return { error: 'script:not-script-type', reason: '只有脚本自动化才能生成脚本' }
    }
    if (!this.chat) {
      this.logger.warn('automation:script-generate-unavailable', { automationId: id, reason: 'llm-unconfigured' })
      return { error: 'script:llm-unconfigured', reason: '没有配置模型，先在「配置」里填好模型再生成' }
    }
    try {
      return { script: await this.requestScript(task) }
    } catch (error) {
      this.logger.error('automation:script-generate-failed', {
        automationId: id,
        message: errorMessage(error),
      })
      return { error: 'script:generate-failed', reason: errorMessage(error) }
    }
  }

  /**
   * 由模型生成脚本。
   *
   * 只生成脚本本身，不掺凭据：需要凭据的动作留给工具去取。
   */
  async generateScript(task: Automation): Promise<string | null> {
    if (!this.chat) {
      this.logger.warn('automation:script-generate-unavailable', { automationId: task.id, reason: 'llm-unconfigured' })
      return null
    }
    try {
      return await this.requestScript(task)
    } catch (error) {
      this.logger.error('automation:script-generate-failed', {
        automationId: task.id,
        message: errorMessage(error),
      })
      return null
    }
  }

  /**
   * 真正向模型要一次脚本。
   *
   * 失败往上抛：调用方要拿得到原因，才能告诉用户到底卡在哪。
   * 记录日志与降级由 generateScript 负责。
   */
  private async requestScript(task: Automation): Promise<string> {
    const turn = await this.chat!.complete([
        {
          role: 'system',
          content: [
            '你把用户的自动化需求写成一个可执行的 shell 脚本。',
            '脚本在指定项目的工作目录里运行，只能读写该项目范围内的文件。',
            '不要写任何 API Key、token 或密码；需要凭据的动作请留给可调用的工具。',
            '只输出脚本正文，不要解释，不要 markdown 代码块围栏。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `任务名：${task.name}\n目标：${task.prompt}\n项目：${task.project}\n仓库：${task.repo}`,
        },
      ], {
        // 推理模型会先把输出额度花在思考上：不设思考预算就可能一个字的正文都吐不出来。
        maxTokens: SCRIPT_GENERATION_MAX_TOKENS,
        thinkingBudgetTokens: SCRIPT_GENERATION_THINKING_BUDGET,
        // 写脚本比写一句话慢得多：默认 60s 不够，推理模型常常要一分多钟。
        timeoutMs: SCRIPT_GENERATION_TIMEOUT_MS,
      })
      const text = stripCodeFence(turn.content)
      if (!text) throw new Error('模型只返回了思考，没有脚本正文')
      this.logger.info('automation:script-generated', { automationId: task.id, chars: text.length })
      // 关键增量：脚本写回任务定义，下次执行直接复用，面板也能查看 / 人工编辑。
      this.saveTaskScript?.(task.id, text)
      return text
  }

  /** 从自然语言生成任务草稿：面板里的预览入口用。 */
  async draftFromText(text: string): Promise<AutomationTaskConfig | null> {
    const parsed = await this.parseDraft(text)
    return parsed.kind === 'draft' ? parsed.draft as AutomationTaskConfig : null
  }

  /** 调模型把原话整理成草稿。 */
  private async parseDraft(text: string): Promise<ParsedDraft> {
    if (!this.chat) return { kind: 'unavailable' }
    try {
      const turn = await this.chat.complete([
        {
          role: 'system',
          content: [
            '你判断用户是不是要创建一条「定时 / 定期 / 监听」的自动化任务，并整理成草稿。',
            '只输出一个 JSON 对象，不要解释。',
            '不是自动化需求：{"intent":false}',
            '信息不够、无法确定（例如没说是哪个项目）：{"intent":true,"uncertain":true,"question":"要回问用户的一句话"}',
            '信息足够：{"intent":true,"name":"任务名","type":"ai|script","prompt":"要做什么",',
            '"schedule":{"kind":"hourly|daily|weekly|cron","at":"HH:mm","weekday":0,"time":"HH:mm","cron":"分 时 日 月 周"},',
            '"project":"项目名（用户提到的，没有就留空）"}',
            '用户没说明执行时间时默认每天 09:00；不要瞎猜项目，也不要编造凭据或命令。',
          ].join('\n'),
        },
        { role: 'user', content: text },
      ])
      const parsed = extractJsonObject(turn.content)
      if (!parsed || parsed.intent === false) return { kind: 'none' }
      if (parsed.uncertain === true) {
        return {
          kind: 'uncertain',
          question: typeof parsed.question === 'string' && parsed.question.trim()
            ? parsed.question.trim()
            : '请再说清楚要做什么、多久跑一次、在哪个项目里跑。',
        }
      }
      const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
      const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : ''
      if (!name || !prompt) {
        return { kind: 'uncertain', question: '请补一句任务名和执行目标。' }
      }
      const schedule = typeof parsed.schedule === 'object' && parsed.schedule
        ? parsed.schedule as AutomationSchedule
        : { kind: 'daily' as const, at: '09:00' }
      const scheduleError = validateSchedule(schedule)
      if (scheduleError) {
        return { kind: 'uncertain', question: `执行时间不合法（${scheduleError}），请再说一次希望什么时候跑。` }
      }
      const projectName = typeof parsed.project === 'string' ? parsed.project.trim() : ''
      const project = this.resolveProject(projectName)
      if (!project) {
        return {
          kind: 'uncertain',
          question: projectName
            ? `没找到项目「${projectName}」，请确认目标项目。`
            : '请告诉我在哪个项目里跑。',
        }
      }
      const type = parsed.type === 'script' ? 'script' : 'ai'
      return {
        kind: 'draft',
        draft: {
          id: `auto_${crypto.randomUUID().slice(0, 8)}`,
          name,
          description: text.trim().slice(0, 200),
          type,
          prompt,
          trigger: { kind: 'schedule', schedule },
          skill: '',
          notifyTo: '',
          runtimeId: '',
          project: project.name,
          repo: project.repo,
          branch: project.defaultBranch ?? '',
          enabled: true,
          createdBy: '',
          createdAt: '',
          updatedAt: '',
        },
      }
    } catch (error) {
      this.logger.warn('automation:draft-failed', { message: errorMessage(error) })
      return { kind: 'uncertain', question: '这次没整理成功，请稍后在面板里手动新建，或再说一次。' }
    }
  }

  /**
   * 把模型给的项目名解析成配置里的项目。
   *
   * 用户没点名时，只有恰好一个项目才自动采用；多个项目就回问，避免乱猜。
   */
  private resolveProject(name: string): { name: string; repo: string; defaultBranch?: string } | undefined {
    const projects = this.config().projects
    if (name) {
      const exact = projects.find(project => project.name === name || project.repo === name)
      if (!exact) return undefined
      return { name: exact.name, repo: exact.repo, ...(exact.defaultBranch ? { defaultBranch: exact.defaultBranch } : {}) }
    }
    if (projects.length !== 1) return undefined
    const only = projects[0]!
    return { name: only.name, repo: only.repo, ...(only.defaultBranch ? { defaultBranch: only.defaultBranch } : {}) }
  }
}

/** 触发方式的中文说明：回给用户的话里用。 */
function describeSchedule(trigger: Automation['trigger']): string {
  if (trigger.kind !== 'schedule') return '事件触发'
  const schedule = trigger.schedule
  switch (schedule.kind) {
    case 'hourly':
      return '每小时'
    case 'daily':
      return `每天 ${schedule.at ?? '09:00'}`
    case 'weekly':
      return `每周${['日', '一', '二', '三', '四', '五', '六'][schedule.weekday ?? 1]} ${schedule.time ?? '09:00'}`
    case 'cron':
      return `Cron ${schedule.cron ?? ''}`
  }
}
