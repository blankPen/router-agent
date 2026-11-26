import { describe, expect, it } from 'vitest'
import {
  blankDraft,
  draftOf,
  filterText,
  MODE_LABEL,
  modeClass,
  outputsText,
  RUN_PHASE_LABEL,
  phaseText,
  scheduleText,
  scheduleOf,
  triggerText,
  validateDraft,
  type AutomationTask,
} from '../../src/web/client/automation-model.js'

function task(over: Partial<AutomationTask> = {}): AutomationTask {
  return {
    id: 'auto_1',
    name: '依赖巡检',
    description: '',
    type: 'ai',
    prompt: '检查依赖更新',
    trigger: { kind: 'schedule', schedule: { kind: 'daily', at: '09:00' } },
    runtimeId: '',
    project: 'demo',
    repo: '/tmp/demo',
    branch: 'main',
    enabled: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  }
}

describe('自动化面板模型', () => {
  it('新建草稿默认每天 09:00 且启用', () => {
    const draft = blankDraft()
    expect(draft.trigger).toEqual({ kind: 'schedule', schedule: { kind: 'daily', at: '09:00' } })
    expect(draft.enabled).toBe(true)
  })

  it('编辑已有任务会带回项目与计划', () => {
    const draft = draftOf(task())
    expect(draft.name).toBe('依赖巡检')
    expect(draft.project).toBe('demo')
    expect(draft.trigger).toEqual({ kind: 'schedule', schedule: { kind: 'daily', at: '09:00' } })
  })

  it('缺名称 / 项目 / 非法时刻会被拦下', () => {
    const draft = { ...blankDraft(), name: '', project: '' }
    expect(validateDraft(draft)).toBe('名称不能为空')
    expect(validateDraft({ ...draft, name: 'x', prompt: 'y', project: '' })).toBe('请选择目标项目')
    expect(validateDraft({
      ...draft,
      name: 'x',
      prompt: 'y',
      project: 'demo',
      repo: '/tmp/demo',
      trigger: { kind: 'schedule', schedule: { kind: 'daily', at: '25:00' } },
    })).toContain('HH:mm')
  })

  it('Cron 表达式为空会被拦下', () => {
    expect(validateDraft({
      ...blankDraft(),
      name: 'x',
      prompt: 'y',
      project: 'demo',
      repo: '/tmp/demo',
      trigger: { kind: 'schedule', schedule: { kind: 'cron', cron: '' } },
    })).toBe('Cron 表达式不能为空')
  })

  it('切到每周后按面板默认值（周一 09:00）保存，不误报', () => {
    expect(validateDraft({
      ...blankDraft(),
      name: 'x',
      prompt: 'y',
      project: 'demo',
      repo: '/tmp/demo',
      trigger: { kind: 'schedule', schedule: { kind: 'weekly' } },
    })).toBeNull()
  })

  it('事件触发的任务没有定时计划', () => {
    const eventTask = task({
      trigger: { kind: 'event', source: 'github', types: ['github.issues.opened'], mode: 'auto' },
    })
    expect(scheduleOf(eventTask.trigger)).toBeUndefined()
    expect(triggerText(eventTask.trigger)).toBe('事件触发 · github · github.issues.opened')
    expect(scheduleOf(task().trigger)).toEqual({ kind: 'daily', at: '09:00' })
  })

  it('三种处理模式各有中文名与语义 class', () => {
    expect(MODE_LABEL.auto).toBe('自动执行')
    expect(modeClass('review')).toBe('tag mode-review')
    expect(modeClass('notify')).toBe('tag mode-notify')
  })

  it('过滤条件有说法，没配就说不过滤', () => {
    expect(filterText({ keywords: ['退款', '承诺'] })).toBe('关键词 退款、承诺')
    expect(filterText({ semantic: '只看 CI 失败' })).toBe('只看 CI 失败')
    expect(filterText(undefined)).toBe('不过滤，全部命中')
  })

  it('计划与产出的文案能直接展示', () => {
    expect(scheduleText({ kind: 'weekly', weekday: 1, time: '09:00' })).toBe('每周一 09:00')
    expect(outputsText({ ticketIds: ['tk-1'], eventIds: ['evt-1'] })).toBe('工单 tk-1；事件 evt-1')
    expect(outputsText({ ticketIds: [], eventIds: [] })).toBe('无产出')
  })

  it('执行阶段有中文文案，未知阶段回退成阶段名', () => {
    expect(phaseText('generating-script')).toBe('正在生成脚本')
    expect(phaseText('running')).toBe('正在执行')
    expect(phaseText('unknown-phase')).toBe('unknown-phase')
  })

  it('每个已知阶段都有中文名', () => {
    for (const phase of Object.keys(RUN_PHASE_LABEL)) {
      expect(RUN_PHASE_LABEL[phase]).toBeTruthy()
    }
  })
})
