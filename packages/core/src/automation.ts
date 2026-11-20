/**
 * 自动化领域模型：任务定义、触发计划、执行记录与内置工具协议。
 *
 * 全部类型放在内核，宿主（调度器、执行器、面板）只依赖这里的形状；
 * 新增自动化类型 / 执行器 / 工具都走注册表，不需要改核心流程。
 */

/** 自动化类型：纯 AI（自然语言提示词）与脚本（提示词 + 落盘脚本）。 */
export type AutomationType = 'ai' | 'script'

/** 触发计划种类。 */
export type AutomationScheduleKind = 'hourly' | 'daily' | 'weekly' | 'cron'

/** 触发计划参数。hourly/daily/weekly 用固定字段，cron 用标准五段表达式。 */
export interface AutomationSchedule {
  kind: AutomationScheduleKind
  /** daily：执行时刻（HH:mm）。 */
  at?: string
  /** weekly：执行星期（0=周日 … 6=周六）。 */
  weekday?: number
  /** weekly：执行时刻（HH:mm）。 */
  time?: string
  /** cron：标准五段表达式（分 时 日 月 周）。 */
  cron?: string
}

/** 自动化任务。 */
export interface Automation {
  id: string
  name: string
  description: string
  type: AutomationType
  /** AI 自动化：自然语言提示词。脚本自动化：脚本要达成的目标描述。 */
  prompt: string
  /** 脚本自动化：AI 生成的脚本正文；持久化保存，可在面板查看与人工编辑。 */
  script?: string
  schedule: AutomationSchedule
  /** 执行 runtime；留空表示跟随默认 runtime。 */
  runtimeId: string
  /** 目标项目名（对应 config.projects[].name）。 */
  project: string
  /** 目标项目仓库路径；与 project 一起解析，避免面板写死路径。 */
  repo: string
  /** 起始分支；留空表示跟随项目默认分支。 */
  branch: string
  enabled: boolean
  /** 创建者标识；当前全局共用，保留字段以便将来区分来源。 */
  createdBy: string
  createdAt: string
  updatedAt: string
}

/**
 * 自动化的调度状态。
 *
 * 任务定义放配置文件（和 events 同级），运行状态放状态库：
 * 定义是用户写的，运行状态是机器写的，两者分开才不会每次执行都改配置文件。
 */
export interface AutomationState {
  taskId: string
  /** 下次触发时间（ISO）；调度器据此挑到期任务。 */
  nextRunAt?: string
  /** 最后一次执行时间（ISO）。 */
  lastRunAt?: string
  /** 最后一次执行状态。 */
  lastStatus?: AutomationRunStatus
}

/** 一次执行的状态。 */
export type AutomationRunStatus = 'running' | 'success' | 'failed' | 'missed' | 'timeout'

/**
 * 一次执行当前处在哪一步。
 *
 * 只有 running 时才有意义：让人在面板上能看出「卡在生成脚本 / 跑 runtime / 收产出」，
 * 而不是只看到一个转圈的 running。
 */
export type AutomationRunPhase =
  | 'preparing'
  | 'generating-script'
  | 'starting-runtime'
  | 'running'
  | 'collecting'

/** 一次执行的产出：新建的工单 / 事件链接。 */
export interface AutomationRunOutputs {
  ticketIds: string[]
  eventIds: string[]
}

/** 一次自动化执行的完整记录。 */
export interface AutomationRun {
  id: string
  automationId: string
  /** 计划触发时间（ISO）。 */
  scheduledAt: string
  /** 实际开始时间（ISO）。 */
  startedAt: string
  /** 结束时间（ISO）；未结束时为空。 */
  finishedAt?: string
  /** 耗时（毫秒）。 */
  durationMs?: number
  status: AutomationRunStatus
  /** 结果摘要（成功时是产出说明，失败时是错误信息）。 */
  summary: string
  error?: string
  /** 执行中的当前阶段；结束后清空。 */
  phase?: AutomationRunPhase
  outputs: AutomationRunOutputs
  /** 手动触发时为 true；调度触发为 false。 */
  manual: boolean
}

/**
 * 对话式创建的待确认草稿。
 *
 * 草稿独立于正式任务：飞书里的自然语言先落成草稿，用户在面板里确认
 * （编辑并保存）后才写进 `automation.tasks`，识别不确定时只回问、不落库。
 */
export interface AutomationDraft {
  id: string
  /** 来源标识，例如 `feishu:oc_xxx`。 */
  source: string
  /** 发起人标识；当前任务全局共用，这里只留痕。 */
  requester: string
  /** 用户原话（已截断）。 */
  text: string
  /** 整理后的任务草稿。 */
  draft: Automation
  status: 'pending' | 'dismissed'
  createdAt: string
}

/**
 * 内置工具定义。
 *
 * AI 自动化与脚本自动化共用同一份定义：名字、入参 schema、描述与 handler 一体，
 * 两条执行管线只负责注入，不各写一套。
 */
export interface AutomationTool {
  name: string
  description: string
  /** 入参 schema（JSON Schema 子集）。 */
  parameters: Record<string, unknown>
  /** 是否为写操作；写操作才需要写权限。 */
  mutates: boolean
  /**
   * 执行入口。
   *
   * `scope` 是本自动化任务所属项目的范围声明，handler 必须据此限定可访问的数据。
   */
  handler(args: Record<string, unknown>, scope: AutomationToolScope): Promise<unknown> | unknown
}

/**
 * 工具调用的范围声明。
 *
 * 工具只能操作本自动化任务所属项目范围的数据；凭据不落进任务定义或脚本正文，
 * 需要凭据的动作由 handler 内部复用现有配置去取。
 */
export interface AutomationToolScope {
  /** 自动化任务 id。 */
  automationId: string
  /** 目标项目名。 */
  project: string
  /** 目标项目仓库路径。 */
  repo: string
  /** 目标项目起始分支；留空表示跟随项目默认分支。 */
  branch?: string
}

/** 工具注册表：名字 → 定义。 */
export interface AutomationToolRegistry {
  get(name: string): AutomationTool | undefined
  list(): AutomationTool[]
}

/** 执行器注册表：自动化类型 → 执行器。 */
export interface AutomationExecutor {
  type: AutomationType
  execute(input: AutomationExecutionInput): Promise<AutomationExecutionResult>
}

/** 一次执行的统一入参：两种类型共用。 */
export interface AutomationExecutionInput {
  automation: Automation
  /** 注入给任务的工具集（同一份定义，handler 已绑定范围）。 */
  tools: AutomationTool[]
  /** 硬超时（毫秒）。 */
  timeoutMs: number
  /** 失败重试次数。 */
  maxRetries: number
  /**
   * 脚本与产物的落盘目录（Router 状态目录内）。
   *
   * 执行本身的工作目录由 runtime 决定：它在被选项目上开 worktree，
   * 自动化因此不会写到项目外的任何地方。
   */
  workdir: string
  logger: AutomationLogger
  /** 上报当前阶段；面板据此显示「跑到哪一步了」。 */
  onPhase?: (phase: AutomationRunPhase) => void
}

/** 一次执行的结果。 */
export interface AutomationExecutionResult {
  status: 'success' | 'failed' | 'timeout'
  summary: string
  outputs: AutomationRunOutputs
  error?: string
}

/** 执行器只需要能记日志；与 infra Logger 形状一致，缺省用 noop。 */
export interface AutomationLogger {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

/** 调度计划注册表项：新增计划种类只需注册一份。 */
export interface AutomationScheduleSpec {
  kind: AutomationScheduleKind
  label: string
  /** 校验计划参数；返回错误信息表示非法。 */
  validate(schedule: AutomationSchedule): string | null
  /** 按「上一次触发时间」算出下一次触发时间（ISO）。 */
  next(schedule: AutomationSchedule, from: Date): Date | null
}
