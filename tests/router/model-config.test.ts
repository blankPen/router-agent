import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveImageModelConfig, resolvePiModelConfig } from '../../src/router/model-config.js'

function setup(llm: Record<string, unknown>): { configPath: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ra-model-'))
  const configPath = join(dir, 'config.yaml')
  writeFileSync(configPath, [
    'llm:',
    ...Object.entries(llm).map(([key, value]) => `  ${key}: ${value}`),
  ].join('\n'))
  return { configPath, home: dir }
}

describe('resolvePiModelConfig', () => {
  it('三项齐全时直接返回 config.yaml 的 llm 段', () => {
    const opts = setup({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-main', model: 'text-model' })
    expect(resolvePiModelConfig({ ...opts, env: {} })).toEqual({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-main',
      model: 'text-model',
      api: 'openai-completions',
    })
  })

  it('缺 apiKey 时直接报错，不再隐式兜底', () => {
    const opts = setup({ baseUrl: 'https://api.example.com/v1', model: 'text-model' })
    expect(() => resolvePiModelConfig({ ...opts, env: {} })).toThrow(/pi:model-config-missing/)
  })

  it('支持 anthropic-messages 与 authHeader（从 Claude Code / CCSwitch 导入）', () => {
    const opts = setup({
      baseUrl: 'https://gateway.example.com',
      apiKey: 'sk-anthropic',
      model: 'claude-sonnet-demo',
      api: 'anthropic-messages',
      authHeader: true,
    })
    expect(resolvePiModelConfig({ ...opts, env: {} })).toEqual({
      baseUrl: 'https://gateway.example.com',
      apiKey: 'sk-anthropic',
      model: 'claude-sonnet-demo',
      api: 'anthropic-messages',
      authHeader: true,
    })
  })

  it('不再读取 ~/.trove/config.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ra-model-'))
    const troveDir = join(dir, '.trove')
    mkdirSync(troveDir, { recursive: true })
    writeFileSync(join(troveDir, 'config.json'), JSON.stringify({
      llm: { baseUrl: 'https://trove.example.com/v1', apiKey: 'sk-trove', model: 'trove-model' },
    }))
    expect(() => resolvePiModelConfig({ home: dir, env: {} })).toThrow(/pi:model-config-missing/)
  })
})

describe('resolveImageModelConfig', () => {
  it('默认复用研判模型', () => {
    const opts = setup({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-main', model: 'text-model' })
    expect(resolveImageModelConfig({ ...opts, env: {} })).toEqual({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-main',
      model: 'text-model',
      api: 'openai-completions',
    })
  })

  it('llm.imageModel 等字段单独覆盖图片链路', () => {
    const opts = setup({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-main',
      model: 'text-model',
      imageModel: 'vision-model',
      imageBaseUrl: 'https://vision.example.com/v1',
      imageApiKey: 'sk-vision',
    })
    expect(resolveImageModelConfig({ ...opts, env: {} })).toMatchObject({
      baseUrl: 'https://vision.example.com/v1',
      apiKey: 'sk-vision',
      model: 'vision-model',
    })
  })

  it('环境变量优先于配置文件', () => {
    const opts = setup({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-main',
      model: 'text-model',
      imageModel: 'vision-model',
    })
    expect(resolveImageModelConfig({
      ...opts,
      env: { RA_LLM_IMAGE_MODEL: 'env-vision', RA_LLM_IMAGE_API_KEY: 'sk-env' },
    })).toMatchObject({ model: 'env-vision', apiKey: 'sk-env', baseUrl: 'https://api.example.com/v1' })
  })
})
