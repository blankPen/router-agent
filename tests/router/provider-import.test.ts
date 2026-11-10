import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { discoverLocalProviders, toLocalProviderView } from '../../src/router/provider-import.js'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'ra-import-'))
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

function writeClaudeSettings(dir: string, env: Record<string, string>): void {
  writeJson(join(dir, '.claude', 'settings.json'), { env })
}

describe('discoverLocalProviders', () => {
  it('从 Claude Code settings.json 读取 Anthropic 兼容配置', async () => {
    const dir = home()
    writeClaudeSettings(dir, {
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      ANTHROPIC_AUTH_TOKEN: 'sk-claude',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-demo',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-demo',
    })

    const scan = await discoverLocalProviders({ home: dir, env: {} })
    expect(scan.sources.find(source => source.id === 'claude-code')?.found).toBe(true)
    const candidate = scan.candidates.find(item => item.source === 'claude-code')
    expect(candidate).toMatchObject({
      source: 'claude-code',
      baseUrl: 'https://gateway.example.com',
      model: 'claude-sonnet-demo',
      api: 'anthropic-messages',
      authHeader: true,
      apiKey: 'sk-claude',
    })

    // 下发给面板的视图不能带明文密钥。
    const view = toLocalProviderView(candidate!)
    expect(view).not.toHaveProperty('apiKey')
    expect(view.apiKeySet).toBe(true)
    expect(JSON.stringify(view)).not.toContain('sk-claude')
  })

  it('ANTHROPIC_API_KEY 不设置 Bearer，ANTHROPIC_AUTH_TOKEN 才设置', async () => {
    const dir = home()
    writeClaudeSettings(dir, {
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      ANTHROPIC_API_KEY: 'sk-api-key',
      ANTHROPIC_MODEL: 'model-a',
    })
    const scan = await discoverLocalProviders({ home: dir, env: {} })
    const candidate = scan.candidates.find(item => item.source === 'claude-code')
    expect(candidate?.authHeader).toBeUndefined()
    expect(candidate?.apiKey).toBe('sk-api-key')
  })

  it('去掉 Claude Code 的 [1m] 上下文标记，避免把标记当模型名发给网关', async () => {
    const dir = home()
    writeClaudeSettings(dir, {
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      ANTHROPIC_AUTH_TOKEN: 'sk-claude',
      ANTHROPIC_MODEL: 'deepseek-v4.1-flash[1m]',
    })
    const scan = await discoverLocalProviders({ home: dir, env: {} })
    expect(scan.candidates.find(item => item.source === 'claude-code')?.model).toBe('deepseek-v4.1-flash')
  })

  it('读取 CCSwitch SQLite 里的 claude 与 opencode Provider', async () => {
    const dir = home()
    const dbPath = join(dir, '.cc-switch', 'cc-switch.db')
    mkdirSync(join(dir, '.cc-switch'), { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec(`CREATE TABLE providers (
      id TEXT NOT NULL,
      app_type TEXT NOT NULL,
      name TEXT NOT NULL,
      settings_config TEXT NOT NULL,
      is_current BOOLEAN NOT NULL DEFAULT 0,
      sort_index INTEGER,
      PRIMARY KEY (id, app_type)
    )`)
    const insert = db.prepare('INSERT INTO providers (id, app_type, name, settings_config, is_current, sort_index) VALUES (?, ?, ?, ?, ?, ?)')
    insert.run('c1', 'claude', 'Zhipu', JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'sk-zhipu',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.6',
      },
    }), 1, 0)
    insert.run('o1', 'opencode', 'Ark', JSON.stringify({
      options: { baseURL: 'https://ark.example.com/v3', apiKey: 'sk-ark' },
      models: { 'deepseek-v3.2': { name: 'DeepSeek V3.2' } },
    }), 0, 0)
    db.close()

    const scan = await discoverLocalProviders({ home: dir, env: {} })
    expect(scan.sources.find(source => source.id === 'cc-switch')?.found).toBe(true)
    expect(scan.candidates.find(item => item.name.includes('Zhipu'))).toMatchObject({
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      model: 'glm-4.6',
      api: 'anthropic-messages',
      authHeader: true,
    })
    expect(scan.candidates.find(item => item.name.includes('Ark'))).toMatchObject({
      baseUrl: 'https://ark.example.com/v3',
      model: 'deepseek-v3.2',
      api: 'openai-completions',
    })
  })

  it('兼容旧版 CCSwitch config.json 的嵌套结构', async () => {
    const dir = home()
    writeJson(join(dir, '.cc-switch', 'config.json'), {
      claude: {
        providers: {
          p1: {
            id: 'p1',
            name: '旧版 DeepSeek',
            settingsConfig: {
              env: {
                ANTHROPIC_BASE_URL: 'https://legacy.example.com',
                ANTHROPIC_AUTH_TOKEN: 'sk-legacy',
                ANTHROPIC_MODEL: 'legacy-model',
              },
            },
          },
        },
      },
    })

    const scan = await discoverLocalProviders({ home: dir, env: {} })
    expect(scan.candidates.find(item => item.source === 'cc-switch')).toMatchObject({
      name: 'CCSwitch · 旧版 DeepSeek',
      baseUrl: 'https://legacy.example.com',
      model: 'legacy-model',
      apiKey: 'sk-legacy',
    })
  })

  it('读取 Pi models.json 并解析 $ENV 密钥', async () => {
    const dir = home()
    writeJson(join(dir, '.pi', 'agent', 'models.json'), {
      providers: {
        acme: {
          baseUrl: 'https://acme.example.com/v1',
          api: 'openai-completions',
          apiKey: '$ACME_KEY',
          models: [
            { id: 'acme-chat', name: 'Acme Chat', contextWindow: 200000 },
          ],
        },
      },
    })

    const scan = await discoverLocalProviders({ home: dir, env: { ACME_KEY: 'sk-acme' } })
    expect(scan.candidates.find(item => item.source === 'pi')).toMatchObject({
      baseUrl: 'https://acme.example.com/v1',
      model: 'acme-chat',
      apiKey: 'sk-acme',
      contextWindow: 200000,
    })
  })

  it('配置损坏时只标记来源失败，不抛异常', async () => {
    const dir = home()
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'settings.json'), '{ not-json')
    const scan = await discoverLocalProviders({ home: dir, env: {} })
    expect(scan.candidates).toEqual([])
    const source = scan.sources.find(item => item.id === 'claude-code')
    expect(source?.found).toBe(true)
    expect(source?.error).toBeTruthy()
  })

  it('缺少任一项的配置不会进入候选', async () => {
    const dir = home()
    writeClaudeSettings(dir, {
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      ANTHROPIC_MODEL: 'model-a',
    })
    const scan = await discoverLocalProviders({ home: dir, env: {} })
    expect(scan.candidates).toEqual([])
  })
})
