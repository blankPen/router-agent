/**
 * 自动化页的纯逻辑：表单草稿的校验、计划文案与执行状态展示。
 *
 * 单独放在 .ts 里：这些规则不必拉起整棵 React 树就能测。
 */

/** 自动化类型。 */
export type AutomationType = 'ai' | 'script'

/** 触发计划。 */
export interface AutomationSchedule {
  kind: 'hourly' | 'daily' | 'weekly' | 'cron'
  at?: string
  weekday?: number
  time?: string
  cron?: string
}

/** 事件处理方式。 */
export type EventHandlingMode = 'auto' | 'review' | 'notify'

/** 事件订阅的过滤条件。 */
export interface EventFilter {
  keywords?: string[]
  semantic?: string
}

/** 任务触发器：事件订阅或定时计划。 */
export type AutomationTrigger =
  | {
    kind: 'event'
    source: string
    types: string[]
    params?: Record<string, string>
    filter?: EventFilter
    mode: EventHandlingMode
  }
  | { kind: 'schedule'; schedule: AutomationSchedule }

/** 面板上的自动化任务。 */
export interface AutomationTask {
  id: string
  name: string
  description: string
  type: AutomationType
  prompt: string
  script?: string
  /** 触发方式：事件订阅或定时计划。 */
  trigger: AutomationTrigger
  /** 处理方式（skill 闭集内的 id）。 */
  skill?: string
  /** 通知人；事件开工时先私聊通知这个人。 */
  notifyTo?: string
  /** 绑定的会话 id；「恢复会话」用它找回原会话。 */
  conversationId?: string
  runtimeId: string
  project: string
  repo: string
  branch: string
  enabled: boolean
  createdBy?: string
  createdAt: string
  updatedAt: string
  nextRunAt?: string
  lastRunAt?: string
  lastStatus?: string
}

/** 执行记录。 */
export interface AutomationRun {
  id: string
  automationId: string
  automationName: string
  scheduledAt: string
  startedAt: string
  finishedAt?: string
  durationMs?: number
  status: string
  summary: string
  error?: string
  /** 执行中的当前阶段；结束后为空。 */
  phase?: string
  outputs: { ticketIds: string[]; eventIds: string[] }
  manual: boolean
}

/** 对话式创建的待确认草稿。 */
export interface AutomationDraftRecord {
  id: string
  source: string
  requester: string
  text: string
  draft: AutomationTask
  status: 'pending' | 'dismissed'
  createdAt: string
}

/** 新建 / 编辑弹窗的草稿。 */
export interface AutomationDraft {
  id: string
  name: string
  description: string
  type: AutomationType
  prompt: string
  script: string
  /** 触发方式：事件订阅或定时计划。 */
  trigger: AutomationTrigger
  runtimeId: string
  project: string
  repo: string
  branch: string
  enabled: boolean
}

/** 空白草稿。 */
export function blankDraft(): AutomationDraft {
  return {
    id: '',
    name: '',
    description: '',
    type: 'ai',
    prompt: '',
    script: '',
    trigger: { kind: 'schedule', schedule: { kind: 'daily', at: '09:00' } },
    runtimeId: '',
    project: '',
    repo: '',
    branch: '',
    enabled: true,
  }
}

/** 由任务生成草稿（编辑时用）。 */
export function draftOf(task: AutomationTask): AutomationDraft {
  return {
    id: task.id,
    name: task.name,
    description: task.description,
    type: task.type,
    prompt: task.prompt,
    script: task.script ?? '',
    trigger: task.trigger,
    runtimeId: task.runtimeId,
    project: task.project,
    repo: task.repo,
    branch: task.branch,
    enabled: task.enabled,
  }
}

/** 由待确认草稿生成编辑表单；确认保存前不会写进正式任务。 */
export function editorDraftOf(record: AutomationDraftRecord): AutomationDraft {
  return draftOf(record.draft)
}

/** 星期中文名。 */
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 计划的中文说明：面板上一行说清「什么时候跑」。 */
export function scheduleText(schedule: AutomationSchedule): string {
  switch (schedule.kind) {
    case 'hourly':
      return '每小时'
    case 'daily':
      return `每天 ${schedule.at ?? '09:00'}`
    case 'weekly':
      return `每${WEEKDAYS[schedule.weekday ?? 1]} ${schedule.time ?? '09:00'}`
    case 'cron':
      return `Cron ${schedule.cron ?? ''}`.trim()
  }
}

/** 定时计划；事件触发的任务没有。 */
export function scheduleOf(trigger: AutomationTrigger | undefined): AutomationSchedule | undefined {
  return trigger?.kind === 'schedule' ? trigger.schedule : undefined
}

/**
 * 触发方式的短摘要；任务栏那种一行宽的地方用这句。
 *
 * 只留「来源 · 事件类型」或「定时 · 每天 09:00」——
 * 完整说明在任务栏一行里放不下。
 */
export function triggerSummary(trigger: AutomationTrigger | undefined): string {
  if (!trigger) return '未知触发方式'
  if (trigger.kind === 'schedule') return `定时 · ${scheduleText(trigger.schedule)}`
  if (trigger.types.length === 0) return trigger.source
  if (trigger.types.length > 1) return `${trigger.source} · ${trigger.types.length} 类事件`
  // 类型 id 自带来源前缀（github.issues.opened），摘要里省掉重复的那一段。
  const type = trigger.types[0] ?? ''
  const short = type.startsWith(`${trigger.source}.`) ? type.slice(trigger.source.length + 1) : type
  return `${trigger.source} · ${short}`
}

/** 处理模式的中文名。 */
export const MODE_LABEL: Record<EventHandlingMode, string> = {
  auto: '自动执行',
  review: '待人审',
  notify: '仅提醒',
}

/** 处理模式的语义 class；面板用既有语义色，不新增色板。 */
export function modeClass(mode: EventHandlingMode): string {
  return `tag mode-${mode}`
}

/** 计划参数的校验；返回错误信息表示不合法。 */
export function validateDraft(draft: AutomationDraft): string | null {
  if (!draft.name.trim()) return '名称不能为空'
  if (!draft.prompt.trim()) return draft.type === 'script' ? '脚本描述不能为空' : '提示词不能为空'
  if (!draft.project.trim()) return '请选择目标项目'
  if (!draft.repo.trim()) return '目标项目缺少仓库路径'
  const schedule = scheduleOf(draft.trigger)
  if (!schedule) return '触发方式不合法'
  if (schedule.kind === 'daily' && !isClockTime(schedule.at ?? '')) return '每天的执行时刻应为 HH:mm'
  if (schedule.kind === 'weekly') {
    // 面板展示的是默认值（周一 09:00），校验也必须按同一套默认值，避免「看着合法却报错」。
    if (!isClockTime(schedule.time ?? '09:00')) return '每周的执行时刻应为 HH:mm'
    if (schedule.weekday !== undefined && (schedule.weekday < 0 || schedule.weekday > 6)) return '请选择星期几'
  }
  if (schedule.kind === 'cron' && !schedule.cron?.trim()) return 'Cron 表达式不能为空'
  return null
}

/** HH:mm 校验。 */
export function isClockTime(value: string): boolean {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return false
  return Number(match[1]) <= 23 && Number(match[2]) <= 59
}

/** 执行状态的中文名。 */
export const RUN_STATUS_LABEL: Record<string, string> = {
  running: '执行中',
  success: '成功',
  failed: '失败',
  missed: '已错过',
  timeout: '超时',
}

/** 执行阶段的中文名：让人看得出这次执行卡在哪一步。 */
export const RUN_PHASE_LABEL: Record<string, string> = {
  preparing: '准备中',
  'generating-script': '正在生成脚本',
  'starting-runtime': '正在启动运行时',
  running: '正在执行',
  collecting: '正在收集产出',
}

/** 阶段文案；未知阶段回退成阶段名本身，不显示空白。 */
export function phaseText(phase?: string): string {
  if (!phase) return ''
  return RUN_PHASE_LABEL[phase] ?? phase
}

/** 执行状态对应的色调（复用面板既有的语义色 class）。 */
export function runStatusClass(status: string): string {
  switch (status) {
    case 'success':
      return 'is-success'
    case 'failed':
    case 'timeout':
      return 'is-failed'
    case 'missed':
      return 'is-warn'
    default:
      return ''
  }
}

/** 耗时文案；毫秒转成人类可读的短句。 */
export function durationText(durationMs?: number): string {
  if (durationMs === undefined) return '—'
  if (durationMs < 1000) return `${durationMs}ms`
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.round((durationMs % 60_000) / 1000)
  return `${minutes}m${seconds}s`
}

/** 产出摘要：执行记录里一行说清产出了什么。 */
export function outputsText(outputs: AutomationRun['outputs']): string {
  const parts: string[] = []
  if (outputs.ticketIds.length) parts.push(`工单 ${outputs.ticketIds.join('、')}`)
  if (outputs.eventIds.length) parts.push(`事件 ${outputs.eventIds.join('、')}`)
  return parts.length ? parts.join('；') : '无产出'
}

/** 计划类型的中文名。 */
export const SCHEDULE_KIND_LABEL: Record<AutomationSchedule['kind'], string> = {
  hourly: '每小时',
  daily: '每天',
  weekly: '每周',
  cron: '自定义 Cron',
}

/** 星期下拉框的选项。 */
export function weekdayOptions(): Array<{ value: number; label: string }> {
  return WEEKDAYS.map((label, value) => ({ value, label }))
}

/**
 * 停用 / 启用一条任务后的任务列表。
 *
 * 面板的「停用」按钮走这里：停用后任务还在列表里（用户还能再启用），
 * 但事件订阅随之消失 —— 订阅由任务推导，任务停了就没有订阅（§12.6 V27）。
 */
export function toggledTasks(tasks: AutomationTask[], taskId: string): AutomationTask[] {
  return tasks.map(task => (task.id === taskId ? { ...task, enabled: !task.enabled } : task))
}

/**
 * 删除一条任务后的任务列表。
 *
 * 任务删了，订阅随之消失，不再有事件进来（§12.6 V28）。
 */
export function removedTasks(tasks: AutomationTask[], taskId: string): AutomationTask[] {
  return tasks.filter(task => task.id !== taskId)
}

/** 任务卡上「恢复会话」按钮的目标会话 id；没有绑定会话就返回空串。 */
export function resumeTargetOf(task: AutomationTask): string {
  return task.conversationId ?? ''
}

/** 会话记录（与服务端 `AutomationConversation` 同形的子集）。 */
export interface ConversationRecord {
  id: string
  taskId?: string
  source: string
  requester: string
  text: string
  step: string
  status: 'active' | 'confirmed' | 'abandoned'
  createdAt: string
  updatedAt: string
}

/**
 * 任务该恢复到哪条会话。
 *
 * 任务自己存着 `conversationId` 就用它；没有的话（早于会话化的任务）
 * 反查会话列表里 `taskId` 指向它的那条 —— 一个任务只对应一条会话。
 */
export function conversationIdOf(
  task: AutomationTask,
  conversations: ConversationRecord[],
): string | undefined {
  if (task.conversationId) return task.conversationId
  return conversations.find(item => item.taskId === task.id)?.id
}

/** 会话消息（与服务端同形的子集）。 */
export interface ConversationMessage {
  seq: number
  role: 'user' | 'assistant'
  text: string
  step?: string
  /** 预览卡数据；与服务端的 `AutomationPreview` 同形。 */
  preview?: AutomationPreviewData
  done?: boolean
}

/** 预览卡数据（与服务端 `AutomationPreview` 同形）。 */
export interface AutomationPreviewData {
  name: string
  source: string
  types: string[]
  params: Record<string, string>
  keywords: string[]
  semantic: string
  mode: string
  project: string
  skill: string
  runtimeId: string
  prompt: string
  trigger: string
}

/**
 * 合并断线期间补齐的消息。
 *
 * 按 seq 去重：已经显示过的消息不重复追加，
 * 遗漏的按 seq 顺序接在后面 —— 最终文本完整（§12.7 V30）。
 */
export function mergeMissedMessages(
  current: ConversationMessage[],
  missed: ConversationMessage[],
): ConversationMessage[] {
  if (missed.length === 0) return current
  const known = new Set(current.map(item => item.seq))
  const fresh = missed
    .filter(item => !known.has(item.seq))
    .sort((left, right) => left.seq - right.seq)
  return fresh.length === 0 ? current : [...current, ...fresh]
}

/**
 * 合并助手逐字吐出的片段。
 *
 * 增量片段先进消息流，`turn` 事件到了再补上结论与预览卡；
 * 已经逐字说过的话不再整段重复（§12.7 V29）。
 */
export function mergeTurnMessage(
  current: ConversationMessage[],
  turn: { message?: string; step?: string; preview?: AutomationPreviewData; done?: boolean },
  spoken: string,
): ConversationMessage[] {
  return [
    ...current,
    {
      seq: current.length + 1,
      role: 'assistant',
      text: spoken ? '' : (turn.message ?? ''),
      ...(turn.step ? { step: turn.step } : {}),
      ...(turn.preview ? { preview: turn.preview } : {}),
      ...(turn.done ? { done: true } : {}),
    },
  ]
}
