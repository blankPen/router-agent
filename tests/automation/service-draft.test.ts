import { describe, expect, it } from 'vitest'
import { AutomationService } from '../../src/automation/service.js'
import { Store } from '../../src/store/db.js'
import { Engine } from '../../src/core/engine.js'
import { defaultConfig, policyOf, type AppConfig } from '../../src/config.js'
import type { ChatClient } from '#infra/chat.js'
import type { RuntimeRegistry } from '#runtime/registry.js'

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
