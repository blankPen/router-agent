import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveImageModelConfig } from '../../src/router/model-config.js'

function setup(llm: Record<string, unknown>): { configPath: string; trovePath: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ra-model-'))
  const configPath = join(dir, 'config.yaml')
  writeFileSync(configPath, [
    'llm:',
    ...Object.entries(llm).map(([key, value]) => `  ${key}: ${value}`),
  ].join('\n'))
  return { configPath, trovePath: join(dir, 'missing.json'), home: dir }
}

describe('resolveImageModelConfig', () => {
  it('默认复用研判模型', () => {
    const opts = setup({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-main', model: 'text-model' })
    expect(resolveImageModelConfig({ ...opts, env: {} })).toEqual({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-main',
      model: 'text-model',
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
