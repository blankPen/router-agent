import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildWorkerBrief } from '#runtime/spec/index.js'
import { bundledWorkerSkillRoot, ensureWorkerSkillDir, readWorkerSkill, workerSkillSnapshot, workerSpecPath } from '#runtime/spec/reader.js'

const base = {
  ticketId: 'tk-14',
  title: '实现交付协议 v2',
  scope: '只改 packages/runtime 与 src 的交付链路，不动飞书入站过滤',
  request: '把 Worker 首轮改成短引导，原话要带上。',
  requestActorName: '发起人',
  requestAt: '2026-11-13T09:00:00.000Z',
  repo: 'blankPen/router-agent',
  branch: 'main',
  workBranch: 'ra/tk-14-worker-v2',
  workdir: '/tmp/wt',
  workerDir: '/tmp/workers/tk-14',
  skillDir: '/tmp/home/specs/worker',
}

describe('Worker 首轮短引导', () => {
  it('保留工单事实、研判结论、用户原话与技能入口，总行数不超过 25', () => {
    const brief = buildWorkerBrief(base)
    const lines = brief.split('\n')

    expect(lines.length).toBeLessThanOrEqual(25)
    expect(brief).toContain('/tmp/home/specs/worker')
    expect(brief).toContain(base.scope)
    expect(brief).toContain(base.request)
    expect(brief).toContain('用户原始请求（发起人，2026-11-13T09:00:00.000Z）')
    expect(brief).toContain('超出授权范围时用 blocked 上报')
    expect(brief).not.toContain('## 工作方式')
  })

  it('没有原话时不凭空生成用户请求段', () => {
    const { request: _request, requestActorName: _actor, requestAt: _at, ...withoutRequest } = base
    const brief = buildWorkerBrief(withoutRequest)

    expect(brief).not.toContain('## 用户原始请求')
    expect(brief).not.toContain('与上方结论冲突')
  })

  it('原话超过 2000 字时截断并给出全文路径', () => {
    const brief = buildWorkerBrief({ ...base, request: '需'.repeat(2500), requestPath: '/tmp/workers/tk-14/request.md' })

    expect(brief).toContain('需'.repeat(2000))
    expect(brief).not.toContain('需'.repeat(2001))
    expect(brief).toContain('全文见 /tmp/workers/tk-14/request.md')
  })

  it('原话行数过多时按整份引导的 25 行预算截断', () => {
    const brief = buildWorkerBrief({ ...base, request: 'x\n'.repeat(30), requestPath: '/tmp/workers/tk-14/request.md' })

    expect(brief.split('\n').length).toBeLessThanOrEqual(25)
    expect(brief).toContain('全文见 /tmp/workers/tk-14/request.md')
  })
})

describe('Worker 技能指纹', () => {
  it('随包 SKILL.md 带版本并给出稳定的 sha256', () => {
    const snapshot = workerSkillSnapshot(undefined)

    expect(snapshot).toMatchObject({ name: 'router-agent-worker', version: '2' })
    expect(snapshot.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('用户覆盖 SKILL.md 后指纹随之变化', () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-skill-'))
    mkdirSync(join(home, 'specs', 'worker'), { recursive: true })
    writeFileSync(workerSpecPath(home, 'SKILL.md'), '---\nname: custom\nversion: 9\n---\n自定义\n', 'utf8')

    const snapshot = workerSkillSnapshot(home)
    expect(snapshot).toMatchObject({ name: 'custom', version: '9' })
    expect(snapshot.path).toBe(workerSpecPath(home, 'SKILL.md'))
    expect(snapshot.sha256).not.toBe(workerSkillSnapshot(undefined).sha256)
  })

  it('home 没有覆盖文件时指纹记录随包路径', () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-skill-empty-'))
    const snapshot = workerSkillSnapshot(home)

    expect(snapshot.path).toBe(join(bundledWorkerSkillRoot(), 'SKILL.md'))
  })

  it('派工前补全缺失技能文件且不覆盖用户已有覆盖', () => {
    const home = mkdtempSync(join(tmpdir(), 'ra-skill-ensure-'))
    mkdirSync(join(home, 'specs', 'worker'), { recursive: true })
    writeFileSync(workerSpecPath(home, 'SKILL.md'), '---\nname: custom\nversion: 9\n---\n自定义\n', 'utf8')

    ensureWorkerSkillDir(home)

    expect(readWorkerSkill(home, 'SKILL.md')).toContain('自定义')
    expect(readWorkerSkill(home, 'references/reply-protocol.md')).toContain('## 退出码')
  })
})
