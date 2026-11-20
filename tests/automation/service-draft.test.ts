import { describe, expect, it, vi } from 'vitest'
import { AutomationService } from '../../src/automation/service.js'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { defaultConfig, policyOf, type AppConfig } from '../../src/config.js'
import type { ChatClient } from '#infra/chat.js'
import type { RuntimeRegistry } from '#runtime/registry.js'
import type { Automation } from '#core/automation.js'

function configOf(): AppConfig {
  const config = defaultConfig()
  config.projects = [{ name: 'demo', repo: '/tmp/demo', defaultBranch: 'main' }]
  return config
}

function makeService(chat: ChatClient | null, config = configOf()): { service: AutomationService; store: Store } {
  const store = new Store(':memory:')
  const engine = new Engine({
    store,
    policy: policyOf(config),
    clock: { now: () => '2026-11-18T09:00:00.000Z' },
  })
  const service = new AutomationService({
    config: () => config,
    store,
    engine,
    runtimes: {} as RuntimeRegistry,
    chat,
  })
  return { service, store }
}

function reply(content: unknown): ChatClient {
  return { complete: async () => ({ content: JSON.stringify(content), toolCalls: [] }) }
}

describe('对话式自动化草稿', () => {
  it('信息足够时落成待确认草稿，但不写正式任务', async () => {
    const config = configOf()
    const { service } = makeService(reply({
      intent: true,
      name: '依赖巡检',
      type: 'ai',
      prompt: '检查依赖更新',
      schedule: { kind: 'daily', at: '09:00' },
      project: 'demo',
    }), config)

    const result = await service.captureDraft('每天检查 demo 的依赖更新', 'feishu:oc_1', 'ou_a')

    expect(result?.draft?.draft.project).toBe('demo')
    expect(result?.draft?.draft.repo).toBe('/tmp/demo')
    expect(result?.reply).toContain('待确认草稿')
    expect(service.listDrafts()).toHaveLength(1)
    expect(config.automation.tasks).toHaveLength(0)
  })

  it('没点名项目且存在多个项目时回问，不落草稿', async () => {
    const config = configOf()
    config.projects.push({ name: 'other', repo: '/tmp/other', defaultBranch: 'main' })
    const { service } = makeService(reply({
      intent: true,
      name: '巡检',
      prompt: '检查依赖更新',
      schedule: { kind: 'daily', at: '09:00' },
      project: '',
    }), config)

    const result = await service.captureDraft('每天帮我检查依赖', 'feishu:oc_1', 'ou_a')

    expect(result?.reply).toContain('哪个项目')
    expect(result?.draft).toBeUndefined()
    expect(service.listDrafts()).toHaveLength(0)
  })

  it('模型判断不是自动化意图时返回 null', async () => {
    const { service } = makeService(reply({ intent: false }))
    expect(await service.captureDraft('帮我看看这个自动化是什么意思', 'feishu:oc_1', 'ou_a')).toBeNull()
  })

  it('没配模型时提示去面板手动新建', async () => {
    const { service } = makeService(null)
    const result = await service.captureDraft('每天检查依赖', 'feishu:oc_1', 'ou_a')
    expect(result?.reply).toContain('面板')
    expect(service.listDrafts()).toHaveLength(0)
  })

  it('忽略草稿后不再出现在待确认列表', async () => {
    const { service } = makeService(reply({
      intent: true,
      name: '巡检',
      prompt: '检查依赖更新',
      schedule: { kind: 'daily', at: '09:00' },
      project: 'demo',
    }))
    const result = await service.captureDraft('每天检查依赖', 'feishu:oc_1', 'ou_a')
    expect(service.dismissDraft(result!.draft!.id)).toBe(true)
    expect(service.listDrafts()).toHaveLength(0)
  })
})

describe('脚本生成', () => {
  function scriptTask(): Automation {
    return {
      id: 'auto_script',
      name: '巡检',
      description: '',
      type: 'script',
      prompt: '检查依赖更新',
      schedule: { kind: 'daily', at: '09:00' },
      runtimeId: '',
      project: 'demo',
      repo: '/tmp/demo',
      branch: 'main',
      enabled: true,
      createdBy: '',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    }
  }

  it('模型返回脚本正文时写回任务定义', async () => {
    const config = configOf()
    const saved: Array<{ taskId: string; script: string }> = []
    const store = new Store(':memory:')
    const engine = new Engine({ store, policy: policyOf(config) })
    const service = new AutomationService({
      config: () => config,
      store,
      engine,
      runtimes: {} as RuntimeRegistry,
      chat: { complete: async () => ({ content: '#!/bin/sh\necho hi', toolCalls: [] }) },
      saveTaskScript: (taskId, script) => saved.push({ taskId, script }),
    })

    const script = await service.generateScript(scriptTask())

    expect(script).toBe('#!/bin/sh\necho hi')
    expect(saved).toEqual([{ taskId: 'auto_script', script: '#!/bin/sh\necho hi' }])
  })

  it('模型只给了思考没有正文时报告失败原因，不当成空脚本', async () => {
    const store = new Store(':memory:')
    const config = configOf()
    const engine = new Engine({ store, policy: policyOf(config) })
    const service = new AutomationService({
      config: () => config,
      store,
      engine,
      runtimes: {} as RuntimeRegistry,
      chat: {
        complete: async () => {
          throw new Error('chat:empty-response:max_tokens')
        },
      },
    })

    expect(await service.generateScript(scriptTask())).toBeNull()
  })

  it('模型返回被围栏包住的脚本时去掉围栏', async () => {
    const store = new Store(':memory:')
    const config = configOf()
    const engine = new Engine({ store, policy: policyOf(config) })
    const service = new AutomationService({
      config: () => config,
      store,
      engine,
      runtimes: {} as RuntimeRegistry,
      chat: {
        complete: async () => ({
          content: '```bash\n#!/bin/sh\necho hi\n```',
          toolCalls: [],
        }),
      },
    })

    expect(await service.generateScript(scriptTask())).toBe('#!/bin/sh\necho hi')
  })

  it('生成失败时把真实原因带回去，面板能说清卡在哪', async () => {
    const config = configOf()
    config.automation.tasks = [scriptTask()]
    const store = new Store(':memory:')
    const engine = new Engine({ store, policy: policyOf(config) })
    const service = new AutomationService({
      config: () => config,
      store,
      engine,
      runtimes: {} as RuntimeRegistry,
      chat: {
        complete: async () => {
          throw new Error('chat:empty-response:max_tokens')
        },
      },
    })

    const outcome = await service.generateScriptWithReason('auto_script')

    expect(outcome).toEqual({ error: 'script:generate-failed', reason: 'chat:empty-response:max_tokens' })
  })

  it('模型只给思考没给正文时报出真实原因而不是空话', async () => {
    const config = configOf()
    config.automation.tasks = [scriptTask()]
    const store = new Store(':memory:')
    const engine = new Engine({ store, policy: policyOf(config) })
    const service = new AutomationService({
      config: () => config,
      store,
      engine,
      runtimes: {} as RuntimeRegistry,
      chat: { complete: async () => ({ content: '', toolCalls: [] }) },
    })

    const outcome = await service.generateScriptWithReason('auto_script')

    expect('error' in outcome).toBe(true)
    expect('reason' in outcome && outcome.reason).toContain('脚本正文')
  })
})

describe('手动触发', () => {
  function serviceWith(config: AppConfig): { service: AutomationService; store: Store } {
    const store = new Store(':memory:')
    const engine = new Engine({ store, policy: policyOf(config) })
    const service = new AutomationService({
      config: () => config,
      store,
      engine,
      runtimes: {} as RuntimeRegistry,
      chat: null,
    })
    return { service, store }
  }

  it('触发立即返回 running 记录，不等执行结束', async () => {
    const config = configOf()
    config.automation.tasks = [{
      id: 'auto_1',
      name: '巡检',
      description: '',
      type: 'ai',
      prompt: '检查依赖',
      schedule: { kind: 'daily', at: '09:00' },
      runtimeId: '',
      project: 'demo',
      repo: '/tmp/demo',
      branch: 'main',
      enabled: true,
      createdBy: '',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    }]
    const { service, store } = serviceWith(config)

    const run = await service.trigger('auto_1')

    expect(run?.status).toBe('running')
    expect(run?.manual).toBe(true)
    expect(store.listAutomationRuns({ automationId: 'auto_1' })).toHaveLength(1)
  })

  it('脚本自动化的任务没有脚本时不执行，直接失败并说明原因', async () => {
    const config = configOf()
    config.automation.tasks = [{
      id: 'auto_script',
      name: '巡检',
      description: '',
      type: 'script',
      prompt: '检查依赖',
      schedule: { kind: 'daily', at: '09:00' },
      runtimeId: '',
      project: 'demo',
      repo: '/tmp/demo',
      branch: 'main',
      enabled: true,
      createdBy: '',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    }]
    const { service, store } = serviceWith(config)

    await service.trigger('auto_script')
    // 后台执行是异步的：等它把记录收尾。
    await vi.waitFor(() => {
      expect(store.listAutomationRuns({ automationId: 'auto_script' })[0]?.status).not.toBe('running')
    })

    const saved = store.listAutomationRuns({ automationId: 'auto_script' })[0]!
    expect(saved.status).toBe('failed')
    expect(saved.error).toBe('script:missing')
  })
})
