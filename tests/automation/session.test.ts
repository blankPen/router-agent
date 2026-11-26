/**
 * 自动化会话：自然语言建任务、恢复会话、迭代修改。
 *
 * 覆盖 §12.1（V1~V2）与 §12.2（V8~V10）：
 * 缺项一次只问一项、参数齐了才出预览、确认前不落库、
 * 恢复会话回到同一条会话、改的是同一个任务、放弃不改任务。
 */
import { describe, expect, it } from 'vitest'
import { AutomationSessionService } from '../../src/automation/session.js'
import { Store } from '../../src/store/db.js'
import { githubCatalog } from '../../src/events/catalogs/github.js'
import type { ChatClient } from '#infra/chat.js'
import type { Automation } from '#core/automation.js'

const PROJECTS = [
  { name: 'router-agent', repo: '/Users/me/router-agent', defaultBranch: 'main' },
  { name: 'customer-service', repo: '/Users/me/customer-service', defaultBranch: 'main' },
]

/** 造一个按脚本依次回话的模型客户端。 */
function scriptedClient(replies: unknown[]): ChatClient {
  let index = 0
  return {
    complete: async () => {
      const content = replies[Math.min(index, replies.length - 1)]
      index += 1
      return { content: JSON.stringify(content), toolCalls: [] }
    },
  }
}

function serviceOf(client: ChatClient | null): {
  service: AutomationSessionService
  store: Store
  saved: Automation[]
} {
  const store = new Store(':memory:')
  const saved: Automation[] = []
  const service = new AutomationSessionService({
    store,
    config: () => ({ projects: PROJECTS, tasks: saved }),
    client: () => client,
    catalogs: () => [githubCatalog],
    clock: () => '2026-11-26T10:00:00.000Z',
    saveTask: task => {
      const index = saved.findIndex(item => item.id === task.id)
      if (index >= 0) saved[index] = task
      else saved.push(task)
    },
  })
  return { service, store, saved }
}

/** 带日志与会话探针的服务：用于断言日志事件名。 */
function probedServiceOf(client: ChatClient | null, opts: {
  probe?: (source: string, params: Record<string, string>) => Promise<string | null>
} = {}): {
  service: AutomationSessionService
  saved: Automation[]
  events: Array<{ event: string; fields: Record<string, unknown> }>
} {
  const store = new Store(':memory:')
  const saved: Automation[] = []
  const events: Array<{ event: string; fields: Record<string, unknown> }> = []
  const service = new AutomationSessionService({
    store,
    config: () => ({ projects: PROJECTS, tasks: saved }),
    client: () => client,
    catalogs: () => [githubCatalog],
    clock: () => '2026-11-26T10:00:00.000Z',
    logger: {
      info: (event: string, fields: Record<string, unknown> = {}) => { events.push({ event, fields }) },
      warn: (event: string, fields: Record<string, unknown> = {}) => { events.push({ event, fields }) },
      error: (event: string, fields: Record<string, unknown> = {}) => { events.push({ event, fields }) },
    },
    ...(opts.probe ? { probeParams: opts.probe } : {}),
    saveTask: task => {
      const index = saved.findIndex(item => item.id === task.id)
      if (index >= 0) saved[index] = task
      else saved.push(task)
    },
  })
  return { service, saved, events }
}

const FULL_TASK = {
  intent: true,
  name: 'CI 修复',
  source: 'github',
  types: ['github.workflow_run.failure'],
  params: { repo: 'blankPen/router-agent' },
  mode: 'auto',
  project: 'router-agent',
  skill: 'ci-fix',
  prompt: '分析失败步骤，修复并提交 PR。',
}

describe('自动化会话', () => {
  it('缺项时只追问一项，不列一堆必填', async () => {
    const { service } = serviceOf(scriptedClient([{ ...FULL_TASK, project: '' }]))
    const conversation = service.create({ source: 'web-panel', requester: 'panel' })
    const turn = await service.turn(conversation.id, '帮我订阅 GitHub 的 Action 失败')
    expect(turn.step).toBe('clarify')
    expect(turn.missing).toEqual(['project'])
    expect(turn.text).toContain('项目')
  })

  it('参数齐了才出预览卡', async () => {
    const { service } = serviceOf(scriptedClient([FULL_TASK]))
    const conversation = service.create({ source: 'web-panel', requester: 'panel' })
    const turn = await service.turn(conversation.id, '订阅 GitHub 的 Action 失败，在 router-agent 里修')
    expect(turn.step).toBe('preview')
    expect(turn.preview).toMatchObject({
      name: 'CI 修复',
      source: 'github',
      types: ['github.workflow_run.failure'],
      mode: 'auto',
      project: 'router-agent',
      skill: 'ci-fix',
    })
  })

  it('预览卡没点确认就不落库', async () => {
    const { service, saved } = serviceOf(scriptedClient([FULL_TASK]))
    const conversation = service.create({ source: 'web-panel', requester: 'panel' })
    await service.turn(conversation.id, '订阅 GitHub 的 Action 失败')
    expect(saved).toHaveLength(0)
  })

  it('确认后任务落库，并带上会话 id', async () => {
    const { service, saved } = serviceOf(scriptedClient([FULL_TASK]))
    const conversation = service.create({ source: 'web-panel', requester: 'panel' })
    await service.turn(conversation.id, '订阅 GitHub 的 Action 失败')
    const turn = service.confirm(conversation.id)
    expect(turn.taskId).toBeTruthy()
    expect(saved).toHaveLength(1)
    expect(saved[0]!.conversationId).toBe(conversation.id)
    expect(saved[0]!.trigger).toMatchObject({ kind: 'event', source: 'github', mode: 'auto' })
  })

  it('确认落库时记 task-created，带上来源与事件类型（V4）', async () => {
    const { service, events } = probedServiceOf(scriptedClient([FULL_TASK]))
    const conversation = service.create({ source: 'web-panel', requester: 'panel' })
    await service.turn(conversation.id, '订阅 GitHub 的 Action 失败')
    service.confirm(conversation.id)
    const created = events.find(item => item.event === 'automation:task-created')
    expect(created?.fields).toMatchObject({
      source: 'github',
      types: ['github.workflow_run.failure'],
      mode: 'auto',
    })
    expect(created?.fields.taskId).toBeTruthy()
  })

  it('订阅不存在的仓库时被拦下，不建任务（V6）', async () => {
    const { service, saved } = probedServiceOf(scriptedClient([FULL_TASK]), {
      probe: async () => '仓库「nobody/nothing」不存在或你看不到它。',
    })
    const conversation = service.create({ source: 'web-panel', requester: 'panel' })
    const turn = await service.turn(conversation.id, '订阅 nobody/nothing 的 Action 失败')
    expect(turn.step).toBe('clarify')
    expect(turn.text).toContain('nobody/nothing')
    expect(saved).toHaveLength(0)
  })

  it('同一会话里改关键词，预览卡内容跟着变，任务 id 不变（V7）', async () => {
    const { service, saved } = serviceOf(scriptedClient([
      FULL_TASK,
      { ...FULL_TASK, filter: { keywords: ['退款'] } },
    ]))
    const conversation = service.create({ source: 'web-panel', requester: 'panel' })
    await service.turn(conversation.id, '订阅 GitHub 的 Action 失败')
    service.confirm(conversation.id)
    const taskId = saved[0]!.id

    const turn = await service.turn(conversation.id, '关键词加上退款')
    expect(turn.preview?.keywords).toEqual(['退款'])
    service.confirm(conversation.id)
    expect(saved).toHaveLength(1)
    expect(saved[0]!.id).toBe(taskId)
    expect(saved[0]!.trigger.kind).toBe('event')
    if (saved[0]!.trigger.kind === 'event') {
      expect(saved[0]!.trigger.filter?.keywords).toEqual(['退款'])
    }
  })

  it('目录里没有的事件类型被拒，并说明目录里实际有什么（V5）', async () => {
    const { service } = serviceOf(scriptedClient([{ ...FULL_TASK, types: ['github.star.created'] }]))
    const conversation = service.create({ source: 'web-panel', requester: 'panel' })
    const turn = await service.turn(conversation.id, '订阅 GitHub 的 Star 事件')
    expect(turn.step).toBe('clarify')
    expect(turn.text).toContain('github.issues.opened')
  })

  it('恢复会话：回到原会话，历史消息完整', async () => {
    const { service } = serviceOf(scriptedClient([FULL_TASK]))
    const conversation = service.create({ source: 'web-panel', requester: 'panel' })
    await service.turn(conversation.id, '订阅 GitHub 的 Action 失败')
    expect(service.get(conversation.id)?.id).toBe(conversation.id)
    const messages = service.messages(conversation.id)
    expect(messages.map(item => item.role)).toEqual(['user', 'assistant'])
    expect(messages[0]!.text).toContain('订阅 GitHub')
  })

  it('恢复会话后改的是原任务，不新建', async () => {
    const { service, saved } = serviceOf(scriptedClient([FULL_TASK]))
    const conversation = service.create({ source: 'web-panel', requester: 'panel' })
    await service.turn(conversation.id, '订阅 GitHub 的 Action 失败')
    service.confirm(conversation.id)
    const taskId = saved[0]!.id
    // 同一会话再改一轮：仍落到同一个 taskId。
    await service.turn(conversation.id, '改成只提醒我')
    service.confirm(conversation.id)
    expect(saved).toHaveLength(1)
    expect(saved[0]!.id).toBe(taskId)
  })

  it('恢复会话后改任务时记 task-updated，不是 task-created（V9）', async () => {
    const { service, events } = probedServiceOf(scriptedClient([
      FULL_TASK,
      { ...FULL_TASK, mode: 'notify' },
    ]))
    const conversation = service.create({ source: 'web-panel', requester: 'panel' })
    await service.turn(conversation.id, '订阅 GitHub 的 Action 失败')
    service.confirm(conversation.id)
    await service.turn(conversation.id, '改成只提醒我')
    service.confirm(conversation.id)
    const updated = events.find(item => item.event === 'automation:task-updated')
    expect(updated?.fields.taskId).toBeTruthy()
    expect(updated?.fields.changed).toContain('trigger')
    expect(events.filter(item => item.event === 'automation:task-created')).toHaveLength(1)
  })

  it('改到一半放弃：任务保持修改前的状态，也没有 task-updated（V10）', async () => {
    const { service, saved, events } = probedServiceOf(scriptedClient([
      FULL_TASK,
      { ...FULL_TASK, mode: 'notify' },
    ]))
    const conversation = service.create({ source: 'web-panel', requester: 'panel' })
    await service.turn(conversation.id, '订阅 GitHub 的 Action 失败')
    service.confirm(conversation.id)
    const before = { ...saved[0]! }

    // 只跑到出预览卡，不点确认：任务不该被改。
    await service.turn(conversation.id, '改成只提醒我')
    expect(saved[0]!.updatedAt).toBe(before.updatedAt)
    expect(saved[0]!.trigger.kind === 'event' ? saved[0]!.trigger.mode : '').toBe('auto')
    expect(events.filter(item => item.event === 'automation:task-updated')).toHaveLength(0)
  })

  it('消息带单调 seq，断线重连能按 seq 补齐', async () => {
    const { service } = serviceOf(scriptedClient([FULL_TASK]))
    const conversation = service.create({ source: 'web-panel', requester: 'panel' })
    await service.turn(conversation.id, '订阅 GitHub 的 Action 失败')
    const all = service.messages(conversation.id)
    expect(all.map(item => item.seq)).toEqual([1, 2])
    expect(service.messages(conversation.id, 1).map(item => item.seq)).toEqual([2])
  })

  it('会话消息落库：换个服务实例（等于重启）后还能读回历史', async () => {
    const store = new Store(':memory:')
    const saved: Automation[] = []
    const deps = {
      store,
      config: () => ({ projects: PROJECTS, tasks: saved }),
      client: () => scriptedClient([FULL_TASK]),
      catalogs: () => [githubCatalog],
      clock: () => '2026-11-26T10:00:00.000Z',
      saveTask: (task: Automation) => { saved.push(task) },
    }
    const first = new AutomationSessionService(deps)
    const conversation = first.create({ source: 'web-panel', requester: 'panel' })
    await first.turn(conversation.id, '订阅 GitHub 的 Action 失败')

    // 面板点任务卡「恢复会话」时服务可能已经重启过：历史必须还在。
    const second = new AutomationSessionService(deps)
    const messages = second.messages(conversation.id)
    expect(messages.map(item => item.role)).toEqual(['user', 'assistant'])
    expect(messages[0]!.text).toContain('订阅 GitHub')
  })
})

