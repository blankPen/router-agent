import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDiagnosisTools, toolSpecs } from '../../src/router/diagnosis-tools.js'

function toolByName(tools: ReturnType<typeof createDiagnosisTools>, name: string) {
  const tool = tools.find(item => item.spec.name === name)
  if (!tool) throw new Error(`没有工具 ${name}`)
  return tool
}

describe('createDiagnosisTools', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ra-diagnosis-tools-'))
    mkdirSync(join(root, 'src', 'router'), { recursive: true })
    writeFileSync(join(root, 'src', 'router', 'log-tail.ts'), 'export const MAX = 100\nconst tail = 1\n', 'utf8')
    writeFileSync(join(root, 'package.json'), '{ "name": "router-agent" }\n', 'utf8')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('提供读配置、列目录、读文件、搜代码四个只读工具', () => {
    const specs = toolSpecs(createDiagnosisTools({ codeRoot: root, config: {}, configPath: '/tmp/config.yaml' }))
    expect(specs.map(spec => spec.name)).toEqual(['read_config', 'list_code', 'read_code', 'search_code'])
  })

  it('read_config 返回脱敏配置与配置路径', () => {
    const tools = createDiagnosisTools({
      codeRoot: root,
      config: { llm: { apiKeySet: true } },
      configPath: '/tmp/config.yaml',
      version: '0.3.17',
    })
    const out = toolByName(tools, 'read_config').run({})
    expect(out).toContain('/tmp/config.yaml')
    expect(out).toContain('0.3.17')
    expect(out).toContain('apiKeySet')
  })

  it('list_code 列出根目录条目', () => {
    const tools = createDiagnosisTools({ codeRoot: root, config: {}, configPath: '/tmp/config.yaml' })
    const out = toolByName(tools, 'list_code').run({})
    expect(out).toMatch(/dir\s+src/)
    expect(out).toContain('file package.json')
  })

  it('read_code 按行号区间读取并带行号', () => {
    const tools = createDiagnosisTools({ codeRoot: root, config: {}, configPath: '/tmp/config.yaml' })
    const out = toolByName(tools, 'read_code').run({ path: 'src/router/log-tail.ts', startLine: 2, endLine: 2 })
    expect(out).toContain('2\tconst tail = 1')
    expect(out).not.toContain('export const MAX')
  })

  it('read_code 拒绝越出安装目录的路径', () => {
    const tools = createDiagnosisTools({ codeRoot: root, config: {}, configPath: '/tmp/config.yaml' })
    const out = toolByName(tools, 'read_code').run({ path: '../../etc/passwd' })
    expect(out).toContain('路径越界')
  })

  it('list_code 与 search_code 同样拒绝越界路径', () => {
    const tools = createDiagnosisTools({ codeRoot: root, config: {}, configPath: '/tmp/config.yaml' })
    expect(toolByName(tools, 'list_code').run({ path: '../..' })).toContain('路径越界')
    expect(toolByName(tools, 'search_code').run({ query: 'x', path: '../..' })).toContain('路径越界')
  })

  it('search_code 返回 文件:行号:内容', () => {
    const tools = createDiagnosisTools({ codeRoot: root, config: {}, configPath: '/tmp/config.yaml' })
    const out = toolByName(tools, 'search_code').run({ query: 'const tail' })
    expect(out).toContain('src/router/log-tail.ts:2')
  })

  it('缺少必填参数时给出可读提示而不是抛错', () => {
    const tools = createDiagnosisTools({ codeRoot: root, config: {}, configPath: '/tmp/config.yaml' })
    expect(toolByName(tools, 'read_code').run({})).toContain('缺少 path')
    expect(toolByName(tools, 'search_code').run({})).toContain('缺少 query')
  })
})
