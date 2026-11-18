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

/** 面板上的自动化任务。 */
export interface AutomationTask {
  id: string
  name: string
  description: string
  type: AutomationType
  prompt: string
  script?: string
  schedule: AutomationSchedule
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
  schedule: AutomationSchedule
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
    schedule: { kind: 'daily', at: '09:00' },
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
    schedule: { ...task.schedule },
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

/** 计划参数的校验；返回错误信息表示不合法。 */
export function validateDraft(draft: AutomationDraft): string | null {
  if (!draft.name.trim()) return '名称不能为空'
  if (!draft.prompt.trim()) return draft.type === 'script' ? '脚本描述不能为空' : '提示词不能为空'
  if (!draft.project.trim()) return '请选择目标项目'
  if (!draft.repo.trim()) return '目标项目缺少仓库路径'
  if (draft.schedule.kind === 'daily' && !isClockTime(draft.schedule.at ?? '')) return '每天的执行时刻应为 HH:mm'
  if (draft.schedule.kind === 'weekly') {
    // 面板展示的是默认值（周一 09:00），校验也必须按同一套默认值，避免「看着合法却报错」。
    if (!isClockTime(draft.schedule.time ?? '09:00')) return '每周的执行时刻应为 HH:mm'
    if (draft.schedule.weekday !== undefined && (draft.schedule.weekday < 0 || draft.schedule.weekday > 6)) return '请选择星期几'
  }
  if (draft.schedule.kind === 'cron' && !draft.schedule.cron?.trim()) return 'Cron 表达式不能为空'
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
