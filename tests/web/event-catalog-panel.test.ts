/**
 * 面板交互：事件源目录卡与自动化任务卡。
 *
 * 覆盖 §12.6（V25~V28）：
 * 目录卡只读、没有事件类型多选框、能查出谁订阅了它；
 * 任务卡停用 / 删除后，订阅随之消失。
 */
import { describe, expect, it } from 'vitest'
import {
  availabilityTag,
  catalogRows,
  catalogStats,
  subscribersByType,
  type CatalogView,
} from '../../src/web/client/event-catalog-model.js'
import {
  removedTasks,
  resumeTargetOf,
  toggledTasks,
  type AutomationTask,
} from '../../src/web/client/automation-model.js'
import { deriveSubscriptions } from '../../src/events/subscriptions.js'
import type { Automation } from '#core/automation.js'

const CATALOG: CatalogView = {
  id: 'github',
  kind: 'github',
  name: 'GitHub',
  builtin: true,
  params: [{ key: 'repo', label: '仓库', kind: 'text' }],
  types: [
    { id: 'github.issues.opened', label: '新建 Issue', group: 'Issue' },
    {
      id: 'github.workflow_run.failure',
      label: 'Action 失败',
      group: 'Action',
      availability: { ready: false, requiresConsoleSubscription: true, note: '需后台订阅' },
    },
  ],
}

function task(over: Partial<AutomationTask> = {}): AutomationTask {
  return {
    id: 'auto_1',
    name: 'CI 修复',
    description: '修 CI',
    type: 'ai',
    prompt: '修 CI',
    trigger: {
      kind: 'event',
      source: 'github',
      types: ['github.issues.opened'],
      filter: { keywords: ['崩溃'] },
      mode: 'auto',
    },
    runtimeId: '',
    project: 'router-agent',
    repo: '/Users/me/router-agent',
    branch: 'main',
    enabled: true,
    createdAt: '2026-11-26T10:00:00.000Z',
    updatedAt: '2026-11-26T10:00:00.000Z',
    ...over,
  }
}

describe('事件源目录卡', () => {
  it('目录只声明可订阅类型与连接参数，没有勾选控件（V25）', () => {
    // 目录视图里只有类型与参数，没有「已选类型」这种可写字段：
    // 订阅关系在自动化任务里，目录是只读的。
    expect(Object.keys(CATALOG).sort()).toEqual(['builtin', 'id', 'kind', 'name', 'params', 'types'])
    expect(CATALOG.types.every(item => typeof item.id === 'string')).toBe(true)
    expect(CATALOG.params.map(param => param.key)).toEqual(['repo'])
  })

  it('每个事件类型标出可用性，开箱可用的与需后台订阅的分开（V25）', () => {
    const rows = catalogRows(CATALOG, new Map()).flatMap(group => group.rows)
    expect(availabilityTag(rows[0]!.type)).toEqual({ text: '开箱可用', tone: 'ok' })
    expect(availabilityTag(rows[1]!.type)).toEqual({ text: '需后台订阅', tone: 'warn' })
  })

  it('目录卡统计出类型总数与开箱可用数（V25）', () => {
    expect(catalogStats(CATALOG)).toEqual({ total: 2, ready: 1, needsConsole: 1 })
  })

  it('点「查看订阅它的任务」能列出订阅该类型的任务（V26）', () => {
    const tasks = [
      task({ name: 'Issue 处理' }),
      task({ id: 'auto_2', name: 'CI 处理', trigger: { kind: 'event', source: 'github', types: ['github.workflow_run.failure'], mode: 'auto' } }),
      task({ id: 'auto_3', name: '定时任务', trigger: { kind: 'schedule', schedule: { kind: 'daily', at: '09:00' } } }),
    ]
    const subscribers = subscribersByType(tasks)
    expect(subscribers.get('github.issues.opened')).toEqual(['Issue 处理'])
    expect(subscribers.get('github.workflow_run.failure')).toEqual(['CI 处理'])
    // 定时任务不订阅任何事件类型。
    expect(subscribers.size).toBe(2)
  })

  it('没被订阅的类型在目录里显示「尚未订阅」（V26）', () => {
    const rows = catalogRows(CATALOG, subscribersByType([task()])).flatMap(group => group.rows)
    const issue = rows.find(row => row.type.id === 'github.issues.opened')!
    const workflow = rows.find(row => row.type.id === 'github.workflow_run.failure')!
    expect(issue.subscribers).toBe(1)
    expect(issue.subscriberNames).toEqual(['CI 修复'])
    expect(workflow.subscribers).toBe(0)
    expect(workflow.subscriberNames).toEqual([])
  })
})

describe('自动化任务卡', () => {
  it('停用任务后订阅随之消失（V27）', () => {
    const tasks = [task()]
    const before = deriveSubscriptions([toAutomation(tasks[0]!)])
    expect(before).toHaveLength(1)

    const next = toggledTasks(tasks, 'auto_1')
    expect(next[0]!.enabled).toBe(false)
    expect(deriveSubscriptions([toAutomation(next[0]!)])).toHaveLength(0)
  })

  it('停用任务不动事件来源本身（V27）', () => {
    const tasks = [task()]
    const next = toggledTasks(tasks, 'auto_1')
    // 任务卡只改任务的 enabled；来源配置不在任务里。
    expect(Object.keys(next[0]!)).toContain('trigger')
    expect(next[0]!.trigger.kind).toBe('event')
  })

  it('删掉任务后订阅随之消失（V28）', () => {
    const tasks = [task(), task({ id: 'auto_2', name: '别的任务' })]
    const next = removedTasks(tasks, 'auto_1')
    expect(next.map(item => item.id)).toEqual(['auto_2'])
    expect(deriveSubscriptions(next.map(toAutomation))).toHaveLength(1)
  })

  it('「恢复会话」回到任务绑定的原会话（V8 / V28）', () => {
    expect(resumeTargetOf(task({ conversationId: 'acv_1' }))).toBe('acv_1')
    expect(resumeTargetOf(task())).toBe('')
  })
})

/** 面板任务 → 领域任务：只带派生订阅需要的字段。 */
function toAutomation(task: AutomationTask): Automation {
  return {
    id: task.id,
    name: task.name,
    description: task.description,
    type: task.type,
    prompt: task.prompt,
    trigger: task.trigger,
    runtimeId: task.runtimeId,
    project: task.project,
    repo: task.repo,
    branch: task.branch,
    enabled: task.enabled,
    createdBy: 'test',
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}
