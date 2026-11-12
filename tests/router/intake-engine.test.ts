import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodeTools } from '../../src/router/intake-engine.js'

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'ra-intake-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'login.ts'), 'export const timeout = 10000\n')
  writeFileSync(join(root, 'README.md'), '# 项目说明\n登录超时在 src/login.ts\n')
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, 'node_modules', 'secret.js'), 'SECRET_MARKER\n')
  return root
}

type Tool = ReturnType<typeof createCodeTools>[number]

async function call(tools: Tool[], name: string, params: Record<string, unknown>): Promise<any> {
  const tool = tools.find(item => item.name === name)
  if (!tool) throw new Error(`missing tool ${name}`)
  const result = await tool.execute('call', params)
  return JSON.parse(result.content[0]!.text)
}

describe('需求识别只读代码工具', () => {
  it('只暴露 code_ls / code_read / code_grep，没有 shell 与写入能力', () => {
    const tools = createCodeTools(project())
    expect(tools.map(tool => tool.name)).toEqual(['code_ls', 'code_read', 'code_grep'])
  })

  it('code_read 读取项目内文件', async () => {
    const root = project()
    try {
      const tools = createCodeTools(root)
      const result = await call(tools, 'code_read', { path: 'src/login.ts' })
      expect(result.content).toContain('timeout = 10000')
      expect(result.truncated).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('拒绝 ../ 与绝对路径越界', async () => {
    const root = project()
    try {
      const tools = createCodeTools(root)
      expect(await call(tools, 'code_read', { path: '../etc/passwd' })).toEqual({ error: 'path:outside-project' })
      expect(await call(tools, 'code_read', { path: '/etc/passwd' })).toEqual({ error: 'path:outside-project' })
      expect(await call(tools, 'code_ls', { path: '..' })).toEqual({ error: 'path:outside-project' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('code_ls 跳过 node_modules / .git', async () => {
    const root = project()
    try {
      const tools = createCodeTools(root)
      const result = await call(tools, 'code_ls', { path: '.' })
      expect(result.entries).toContain('dir src')
      expect(result.entries).toContain('file README.md')
      expect(result.entries).not.toContain('dir node_modules')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('code_grep 只在项目内搜索并跳过依赖目录', async () => {
    const root = project()
    try {
      const tools = createCodeTools(root)
      const result = await call(tools, 'code_grep', { pattern: 'timeout' })
      expect(result.matches.join('\n')).toContain('src/login.ts')
      const secret = await call(tools, 'code_grep', { pattern: 'SECRET_MARKER' })
      expect(secret.matches).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('code_grep 的 path 指向文件时直接搜这个文件', async () => {
    const root = project()
    try {
      const tools = createCodeTools(root)
      const result = await call(tools, 'code_grep', { pattern: 'timeout', path: 'src/login.ts' })
      expect(result.matches.join('\n')).toContain('src/login.ts:1')
      expect(result.matches).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('code_grep 按纯文本匹配：模型给的正则元字符不当正则解释', async () => {
    const root = project()
    try {
      const tools = createCodeTools(root)
      // 若当成正则，'.*' 会命中所有行；纯文本匹配下只有真的写着 .* 的行才算。
      const result = await call(tools, 'code_grep', { pattern: '.*' })
      expect(result.matches).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('code_grep 遇到超大文件时跳过并标记 partial，不当成「没有匹配」', async () => {
    const root = project()
    try {
      writeFileSync(join(root, 'big.log'), `${'x'.repeat(500_000)}\nNEEDLE_HERE\n`)
      const tools = createCodeTools(root)
      const result = await call(tools, 'code_grep', { pattern: 'NEEDLE_HERE' })
      expect(result.partial).toBe(true)
      expect(result.skippedLargeFiles).toContain('big.log')
      expect(result.matches).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('软链指向项目外时拒绝读取', async () => {
    const root = project()
    const outside = mkdtempSync(join(tmpdir(), 'ra-outside-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'SECRET_MARKER\n')
      symlinkSync(join(outside, 'secret.txt'), join(root, 'escape.txt'))
      symlinkSync(outside, join(root, 'escape-dir'))
      const tools = createCodeTools(root)
      // 词法路径在项目内，但真实路径在项目外：一律拒绝。
      expect(await call(tools, 'code_read', { path: 'escape.txt' })).toEqual({ error: 'path:outside-project' })
      expect(await call(tools, 'code_ls', { path: 'escape-dir' })).toEqual({ error: 'path:outside-project' })
      expect(await call(tools, 'code_grep', { pattern: 'SECRET_MARKER', path: 'escape.txt' })).toEqual({ error: 'path:outside-project' })
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
