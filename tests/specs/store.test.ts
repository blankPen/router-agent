import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getSpec,
  listSpecs,
  migrateLegacySoul,
  readSpecContent,
  resetSpec,
  saveSpec,
  SpecError,
  specPath,
} from '../../src/specs/index.js'
import { buildSystemPrompt } from '../../src/router/agent-loop.js'
import { buildWorkerPrompt } from '../../src/worker/spec/index.js'
import { defaultConfig, policyOf } from '../../src/config.js'
import type { Ticket } from '../../src/core/model.js'

const ticket: Ticket = {
  id: 'tk_1',
  title: '调整登录超时',
  threadId: 'feishu:oc_chat:om_root',
  source: 'feishu',
  chatId: 'oc_chat',
  mandateId: 'md_1',
  stage: 'todo',
  repo: 'dsh/router-agent',
  branch: 'main',
  prNumber: 0,
  prUrl: '',
  prState: 'none',
  createdAt: '2026-11-06T10:00:00.000Z',
  updatedAt: '2026-11-06T10:00:00.000Z',
}

describe('规范 markdown 内置存储', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ra-specs-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('列出 Router / Worker 全部规范，未覆盖时读取内置内容', () => {
    const specs = listSpecs(home)
    expect(specs.map(spec => spec.id)).toEqual([
      'router.soul',
      'router.orchestrator',
      'router.admission',
      'router.conversation',
      'router.intake-screener',
      'router.intake-analyst',
      'worker.prompt-mode',
      'worker.contract',
    ])
    expect(specs.every(spec => spec.isCustom === false)).toBe(true)
    expect(specs.find(spec => spec.id === 'router.soul')?.content.length).toBeGreaterThan(0)
  })

  it('保存后优先读取覆盖文件，恢复默认后回到内置内容', () => {
    const builtin = readSpecContent(home, 'router.soul')
    const saved = saveSpec(home, 'router.soul', '# 自定义人格\n\n说话简短。\n')

    expect(saved.isCustom).toBe(true)
    expect(saved.updatedAt).toBeTruthy()
    expect(readSpecContent(home, 'router.soul')).toBe('# 自定义人格\n\n说话简短。\n')
    expect(readFileSync(specPath(home, 'router.soul'), 'utf8')).toBe('# 自定义人格\n\n说话简短。\n')

    const reset = resetSpec(home, 'router.soul')
    expect(reset.isCustom).toBe(false)
    expect(reset.content).toBe(builtin)
    expect(existsSync(specPath(home, 'router.soul'))).toBe(false)
  })

  it('拒绝空内容与未知规范', () => {
    expect(() => saveSpec(home, 'router.soul', '   ')).toThrowError(SpecError)
    expect(() => saveSpec(home, 'router.soul', '   ')).toThrowError(/不能为空/)
    expect(getSpec(home, 'router.nope')).toBeNull()
    expect(() => saveSpec(home, 'router.nope', 'x')).toThrowError(/未知规范/)
  })

  it('Router / Worker 的 prompt 构建会读取覆盖文件', () => {
    saveSpec(home, 'router.orchestrator', '自定义执行规范')
    saveSpec(home, 'worker.prompt-mode', '自定义 Worker 手册：{{title}} / {{scope}}')

    const policy = policyOf(defaultConfig())
    expect(buildSystemPrompt(policy, home)).toContain('自定义执行规范')

    const prompt = buildWorkerPrompt({
      ticket,
      mandateScope: '只改登录超时',
      statePath: '/tmp/s.json',
      eventsPath: '/tmp/e.log',
      repo: 'dsh/router-agent',
      home,
    })
    expect(prompt).toContain('自定义 Worker 手册：调整登录超时 / 只改登录超时')
  })

  it('迁移旧的自定义 soulFile：导入内容、移除配置项、保留原文件', () => {
    const legacyPath = join(home, 'my-soul.md')
    writeFileSync(legacyPath, '# 老自定义人格\n', 'utf8')
    writeFileSync(join(home, 'config.yaml'), [
      'router:',
      '  persona:',
      '    name: 阿罗',
      '    soulFile: ' + legacyPath,
      '    style: friendly',
      '    language: zh-CN',
      '',
    ].join('\n'), 'utf8')

    const result = migrateLegacySoul(home)
    expect(result).toMatchObject({ imported: true, removedConfig: true, source: legacyPath })
    expect(readSpecContent(home, 'router.soul')).toBe('# 老自定义人格\n')
    expect(existsSync(legacyPath)).toBe(true)
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).not.toContain('soulFile')

    // 幂等：再次迁移不会覆盖 Web 里已经改过的内容。
    saveSpec(home, 'router.soul', '# 新内容\n')
    expect(migrateLegacySoul(home)).toMatchObject({ imported: false, removedConfig: false })
    expect(readSpecContent(home, 'router.soul')).toBe('# 新内容\n')
  })

  it('迁移时不覆盖已存在的覆盖文件', () => {
    const legacyPath = join(home, 'my-soul.md')
    writeFileSync(legacyPath, '# 老内容\n', 'utf8')
    saveSpec(home, 'router.soul', '# Web 里编辑过的内容\n')
    writeFileSync(join(home, 'config.yaml'), [
      'router:',
      '  persona:',
      '    soulFile: ' + legacyPath,
      '',
    ].join('\n'), 'utf8')

    const result = migrateLegacySoul(home)
    expect(result).toMatchObject({ imported: false, removedConfig: true })
    expect(readSpecContent(home, 'router.soul')).toBe('# Web 里编辑过的内容\n')
  })

  it('旧文件不存在时保留配置项，方便用户排查', () => {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'config.yaml'), [
      'router:',
      '  persona:',
      '    soulFile: /definitely/not/here.md',
      '',
    ].join('\n'), 'utf8')

    const result = migrateLegacySoul(home)
    expect(result.imported).toBe(false)
    expect(result.removedConfig).toBe(false)
    expect(result.error).toBeTruthy()
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('soulFile')
  })
})
