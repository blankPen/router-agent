import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CommandRunner } from '../../src/infra/process.js'
import type { PrInfo } from '../../src/sources/github.js'
import {
  analyzeEvidenceBody,
  changedFilesSince,
  countVisualLinks,
  evaluateUiEvidence,
  evidenceRejectedMessage,
  isUiPath,
  type EvidenceContext,
  type EvidenceReport,
} from '../../src/worker/evidence-gate.js'

function gitRunner(files: string[] | null): CommandRunner {
  return {
    async run(argv) {
      if (argv[0] === 'merge-base') return { code: 0, stdout: 'abc123\n', stderr: '' }
      if (argv[0] === 'diff') {
        return files === null
          ? { code: 1, stdout: '', stderr: 'no base' }
          : { code: 0, stdout: files.join('\n'), stderr: '' }
      }
      return { code: 1, stdout: '', stderr: 'unsupported' }
    },
  }
}

function pr(body: string | undefined): (repo: string, number: number) => Promise<PrInfo | null> {
  return async (_repo, number) => ({
    number,
    url: `https://github.com/o/r/pull/${number}`,
    state: 'open',
    title: 't',
    branch: 'b',
    ...(body !== undefined ? { body } : {}),
  })
}

function context(over: Partial<EvidenceContext> = {}): EvidenceContext {
  return {
    ticketId: 'tk_1',
    repo: 'o/r',
    branch: 'main',
    workdir: mkdtempSync(join(tmpdir(), 'ra-evidence-')),
    mode: 'enforce',
    ...over,
  }
}

function report(over: Partial<EvidenceReport> = {}): EvidenceReport {
  return { state: 'ready', summary: '完成', prNumber: 7, prUrl: 'https://github.com/o/r/pull/7', ...over }
}

const GOOD_BODY = [
  '### Before',
  '![before](https://example.com/before.png)',
  '',
  '### After',
  '![after](https://example.com/after.png)',
].join('\n')

describe('UI 路径识别', () => {
  it('识别前端扩展名与常见目录，忽略测试与文档', () => {
    expect(isUiPath('src/web/app.tsx')).toBe(true)
    expect(isUiPath('apps/web/src/page.ts')).toBe(true)
    expect(isUiPath('src/components/Button.vue')).toBe(true)
    expect(isUiPath('styles/main.css')).toBe(true)
    expect(isUiPath('src/core/engine.ts')).toBe(false)
    expect(isUiPath('docs/README.md')).toBe(false)
    expect(isUiPath('src/web/app.test.tsx')).toBe(false)
    expect(isUiPath('src/__snapshots__/page.snap')).toBe(false)
  })
})

describe('PR 描述证据解析', () => {
  it('同时识别英文与中文的 Before / After 标识', () => {
    expect(analyzeEvidenceBody(GOOD_BODY).missing).toEqual([])
    const zh = '改动前\n![](/uploads/b.png)\n\n改动后\n![](/uploads/a.png)'
    expect(analyzeEvidenceBody(zh).missing).toEqual([])
  })

  it('只有 After 或链接不足时给出明确缺口', () => {
    const afterOnly = '### After\n![after](https://example.com/after.png)'
    expect(analyzeEvidenceBody(afterOnly).missing).toContain('Before 标识')
    const labelsOnly = '### Before\n### After\n无图'
    expect(analyzeEvidenceBody(labelsOnly).missing).toContain('至少 2 个截图或录屏链接（当前 0 个）')
  })

  it('统计链接时去重，并支持 Markdown / HTML / 视频', () => {
    const body = [
      '![](https://example.com/a.png)',
      '![](https://example.com/a.png)',
      '<img src="https://example.com/b.png">',
      '<video src="https://example.com/c.mp4"></video>',
    ].join('\n')
    expect(countVisualLinks(body)).toBe(3)
  })
})

describe('改动文件计算', () => {
  it('优先用 origin/<base> 的 merge-base 与 HEAD 比较', async () => {
    const calls: string[][] = []
    const git: CommandRunner = {
      async run(argv) {
        calls.push(argv)
        if (argv[0] === 'merge-base') return { code: 0, stdout: 'abc\n', stderr: '' }
        return { code: 0, stdout: 'src/web/a.tsx\nsrc/core/b.ts\n', stderr: '' }
      },
    }
    expect(await changedFilesSince(git, '/tmp', 'main')).toEqual(['src/web/a.tsx', 'src/core/b.ts'])
    expect(calls[0]).toEqual(['merge-base', 'HEAD', 'origin/main'])
    expect(calls[1]).toEqual(['diff', '--name-only', 'abc'])
    expect(calls[2]).toEqual(['ls-files', '--others', '--exclude-standard'])
  })

  it('全部查询失败时返回 null，交给调用方降级', async () => {
    const git: CommandRunner = { run: async () => ({ code: 1, stdout: '', stderr: 'fatal' }) }
    expect(await changedFilesSince(git, '/tmp', 'main')).toBeNull()
  })
})

describe('证据门禁判定', () => {
  it('off / 非 ready / 显式声明没改 UI 时直接放行', async () => {
    const deps = { git: gitRunner(['src/web/a.tsx']), prView: pr(GOOD_BODY) }
    expect((await evaluateUiEvidence(report(), context({ mode: 'off' }), deps)).checked).toBe(false)
    expect((await evaluateUiEvidence(report({ state: 'blocked' }), context(), deps)).checked).toBe(false)
    expect((await evaluateUiEvidence(report({ uiChange: false }), context(), deps)).checked).toBe(false)
  })

  it('按改动文件推断为 UI 工单，证据完整时放行', async () => {
    const decision = await evaluateUiEvidence(report(), context(), { git: gitRunner(['src/web/a.tsx']), prView: pr(GOOD_BODY) })
    expect(decision).toMatchObject({ checked: true, ui: true, action: 'allow', source: 'paths', missing: [] })
  })

  it('非 UI 改动不拦截', async () => {
    const decision = await evaluateUiEvidence(report(), context(), { git: gitRunner(['src/core/engine.ts']), prView: pr('') })
    expect(decision).toMatchObject({ checked: false, ui: false, action: 'allow' })
  })

  it('enforce 缺证据时 reject，warn 时只放行并带 reason', async () => {
    const deps = { git: gitRunner(['src/web/a.tsx']), prView: pr('### After\n![](https://example.com/a.png)') }
    const enforced = await evaluateUiEvidence(report(), context({ mode: 'enforce' }), deps)
    expect(enforced.action).toBe('reject')
    expect(enforced.reason).toBe('missing-labels')
    const warned = await evaluateUiEvidence(report(), context({ mode: 'warn' }), deps)
    expect(warned.action).toBe('allow')
    expect(warned.reason).toBe('missing-labels')
  })

  it('UI 工单没有 PR 编号时拦截，并提示补 PR 或改报 blocked', async () => {
    const decision = await evaluateUiEvidence(
      report({ prNumber: 0, prUrl: '', uiChange: true }),
      context(),
      { git: gitRunner(['src/web/a.tsx']), prView: pr(GOOD_BODY) },
    )
    expect(decision).toMatchObject({ checked: true, action: 'reject', reason: 'no-pr' })
    expect(evidenceRejectedMessage(decision)).toContain('--state blocked')
  })

  it('无法判断时降级放行：workdir 丢失 / git 失败 / PR 查询失败 / PR 无正文', async () => {
    const declared = report({ uiChange: true })
    const prFail = async () => null
    expect(await evaluateUiEvidence(declared, context(), { git: gitRunner(null), prView: prFail })).toMatchObject({ action: 'allow', unverified: 'pr-unavailable' })
    expect(await evaluateUiEvidence(declared, context(), { git: gitRunner(null), prView: pr(GOOD_BODY) })).toMatchObject({ action: 'allow', checked: true })
    expect(await evaluateUiEvidence(declared, context(), { git: gitRunner(null), prView: pr(undefined) })).toMatchObject({ action: 'allow', unverified: 'pr-body-unavailable' })
    expect(await evaluateUiEvidence(report(), context({ workdir: undefined }), { git: gitRunner(null), prView: pr(GOOD_BODY) })).toMatchObject({ action: 'allow', unverified: 'workdir-missing' })
    expect(await evaluateUiEvidence(report(), context(), { git: gitRunner(null), prView: pr(GOOD_BODY) })).toMatchObject({ action: 'allow', unverified: 'changed-files-unknown' })
  })
})
