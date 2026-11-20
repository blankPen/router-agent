import { describe, expect, it } from 'vitest'
import { createDecisionAgent } from '../../src/router/engine-factory.js'
import type { ClassificationAudit } from '../../src/router/decision/agent.js'
import { defaultConfig, type AppConfig } from '../../src/config.js'
import { Store } from '../../src/store/db.js'

function recorder(): { logs: { level: string; message: string; extra?: Record<string, unknown> }[]; logger: Parameters<typeof createDecisionAgent>[0]['logger'] } {
  const logs: { level: string; message: string; extra?: Record<string, unknown> }[] = []
  return {
    logs,
    logger: {
      info: (message, extra) => logs.push({ level: 'info', message, ...(extra ? { extra } : {}) }),
      warn: (message, extra) => logs.push({ level: 'warn', message, ...(extra ? { extra } : {}) }),
      error: (message, extra) => logs.push({ level: 'error', message, ...(extra ? { extra } : {}) }),
    },
  }
}

function configWith(decision: Partial<AppConfig['decision']>): AppConfig {
  const config = defaultConfig()
  config.decision = { ...config.decision, ...decision }
  return config
}

describe('决策层装配', () => {
  it('未开启时不装配决策层', () => {
    const { logs, logger } = recorder()
    const agent = createDecisionAgent({
      config: configWith({ enabled: false }),
      store: new Store(':memory:'),
      model: { baseUrl: 'https://example.invalid/v1', model: 'm', apiKey: 'k' },
      logger,
    })
    expect(agent).toBeNull()
    expect(logs).toHaveLength(0)
  })

  it('Jev 连接信息齐全时装配 Jev，并记 decision:enabled', () => {
    const { logs, logger } = recorder()
    const agent = createDecisionAgent({
      config: configWith({ enabled: true, jev: { apiKey: 'sk-jev', model: 'jev-latest' } }),
      store: new Store(':memory:'),
      model: { baseUrl: 'https://example.invalid/v1', model: 'm', apiKey: 'k' },
      logger,
    })

    expect(agent).not.toBeNull()
    const entry = logs.find(log => log.message === 'decision:enabled')
    expect(entry?.level).toBe('info')
    expect(entry?.extra?.provider).toBe('jev')
    expect(entry?.extra?.model).toBe('jev-latest')
  })

  it('Jev 缺模型名时退回 LLM 模拟，并说明原因', () => {
    const { logs, logger } = recorder()
    const agent = createDecisionAgent({
      config: configWith({ enabled: true, jev: { apiKey: 'sk-jev', model: '' } }),
      store: new Store(':memory:'),
      model: { baseUrl: 'https://example.invalid/v1', model: 'm', apiKey: 'k' },
      intakeEngine: { run: async () => '' } as never,
      logger,
    })

    expect(agent).not.toBeNull()
    const entry = logs.find(log => log.message === 'decision:enabled')
    expect(entry?.extra?.provider).toBe('llm')
    expect(String(entry?.extra?.detail)).toContain('模型名')
  })

  it('没有任何可用 Provider 时记 decision:provider-missing 并放弃装配', () => {
    const { logs, logger } = recorder()
    const agent = createDecisionAgent({
      config: configWith({ enabled: true, jev: { apiKey: '', model: '' } }),
      store: new Store(':memory:'),
      model: { baseUrl: 'https://example.invalid/v1', model: 'm', apiKey: 'k' },
      logger,
    })

    expect(agent).toBeNull()
    const entry = logs.find(log => log.message === 'decision:provider-missing')
    expect(entry?.level).toBe('warn')
    expect(String(entry?.extra?.detail)).toContain('decision.enabled')
  })

  it('决策层分类结论会回调审计出口', async () => {
    const { logs, logger } = recorder()
    const audits: ClassificationAudit[] = []
    const agent = createDecisionAgent({
      config: configWith({ enabled: true, jev: { apiKey: 'sk-jev', model: 'jev-latest' } }),
      store: new Store(':memory:'),
      model: { baseUrl: 'https://example.invalid/v1', model: 'm', apiKey: 'k' },
      logger,
      onAudit: audit => audits.push(audit),
    })

    expect(agent).not.toBeNull()
    await agent!.decide({
      id: 'trg_1',
      source: 'feishu',
      externalId: 'ext_1',
      threadId: 'th_1',
      chatId: 'chat_1',
      chatName: '群一',
      actorId: 'ou_1',
      actorName: '张三',
      isBot: false,
      text: '你好',
      addressed: 'none',
      receivedAt: '2026-01-01T00:00:00.000Z',
      disposition: 'pending',
    })

    // 寒暄在准入阶段就被丢弃，但丢弃结论必须留下审计痕迹，否则查不到「为什么没反应」。
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ triggerId: 'trg_1', outcome: 'dropped', rule: 'noise' })
  })
})
