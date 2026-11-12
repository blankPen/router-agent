import { describe, expect, it } from 'vitest'
import {
  BOT_ACTOR,
  SKIP_KEYWORD,
  isShippableChange,
  parseVersion,
  planRelease,
} from '../../scripts/release-plan.mjs'

/** 用一组已发布版本构造 isPublished。 */
function published(...versions: string[]): (version: string) => boolean {
  const set = new Set(versions)
  return version => set.has(version)
}

const base = {
  event: 'push' as const,
  version: '0.3.0',
  beforeVersion: '0.3.0',
  changedFiles: ['src/cli/index.ts'],
  headMessage: 'Merge pull request #47 from blankPen/ra/tk-43',
  actor: 'blankPen',
}

describe('发布计划', () => {
  it('解析标准版本号，拒绝预发布等其它形式', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
    expect(parseVersion(' 0.3.0 ')).toEqual({ major: 0, minor: 3, patch: 0 })
    expect(parseVersion('1.2')).toBeNull()
    expect(parseVersion('1.2.3-beta.1')).toBeNull()
  })

  it('只改文档 / 测试 / CI 的改动不算产物改动', () => {
    expect(isShippableChange(['docs/PUBLISHING.md', 'README.md', 'tests/a.test.ts', '.github/workflows/x.yml'])).toBe(false)
    expect(isShippableChange(['LICENSE', '.gitignore', '.npmrc'])).toBe(false)
    expect(isShippableChange([])).toBe(false)
    expect(isShippableChange(['docs/a.md', 'src/core/engine.ts'])).toBe(true)
    expect(isShippableChange(['package.json'])).toBe(true)
    expect(isShippableChange(['scripts/build-web.mjs'])).toBe(true)
    expect(isShippableChange(['bin/ra.js'])).toBe(true)
    // monorepo：适配器包源码会进 dist/packages，属于产物；包内测试 / 清单不算。
    expect(isShippableChange(['packages/runtime/src/port.ts'])).toBe(true)
    expect(isShippableChange(['packages/channel/src/feishu/index.ts'])).toBe(true)
    expect(isShippableChange(['pnpm-workspace.yaml'])).toBe(false)
    expect(isShippableChange(['packages/runtime/tests/port.test.ts'])).toBe(false)
    expect(isShippableChange(['packages/runtime/package.json'])).toBe(false)
  })

  it('main 推送有产物改动时自动升 patch', () => {
    const plan = planRelease(base, published('0.3.0'))
    expect(plan).toMatchObject({
      shouldPublish: true,
      releaseVersion: '0.3.1',
      autoBump: true,
    })
  })

  it('自动升版会跳过 npm 上已占用的 patch', () => {
    const plan = planRelease(base, published('0.3.0', '0.3.1', '0.3.2'))
    expect(plan.releaseVersion).toBe('0.3.3')
    expect(plan.autoBump).toBe(true)
  })

  it('当前版本还没发布时先补发当前版本，不留空洞', () => {
    const plan = planRelease(
      { ...base, version: '0.4.0', beforeVersion: '0.4.0' },
      published('0.3.0'),
    )
    expect(plan).toMatchObject({ shouldPublish: true, releaseVersion: '0.4.0', autoBump: false })
    expect(plan.reason).toContain('尚未发布')
  })

  it('推送里手动改了版本号时按该版本发布，不再自动升', () => {
    const plan = planRelease(
      { ...base, version: '0.4.0' },
      published('0.3.0'),
    )
    expect(plan).toMatchObject({ shouldPublish: true, releaseVersion: '0.4.0', autoBump: false })
  })

  it('手动改的版本已存在于 npm 时跳过', () => {
    const plan = planRelease({ ...base, version: '0.4.0' }, published('0.4.0'))
    expect(plan.shouldPublish).toBe(false)
    expect(plan.reason).toContain('已存在于 npm')
  })

  it('提交信息带 [skip release] 时跳过', () => {
    const plan = planRelease({ ...base, headMessage: `chore: 发布 v0.3.1 ${SKIP_KEYWORD}` }, published('0.3.0'))
    expect(plan.shouldPublish).toBe(false)
    expect(plan.reason).toContain(SKIP_KEYWORD)
  })

  it('Actions 机器人推送时跳过', () => {
    const plan = planRelease({ ...base, actor: BOT_ACTOR }, published('0.3.0'))
    expect(plan.shouldPublish).toBe(false)
  })

  it('只有文档类改动时跳过自动升版', () => {
    const plan = planRelease(
      { ...base, changedFiles: ['docs/PUBLISHING.md', 'README.md'] },
      published('0.3.0'),
    )
    expect(plan.shouldPublish).toBe(false)
    expect(plan.reason).toContain('未触及')
  })

  it('拿不到推送前版本时按当前版本发布，不自动升版', () => {
    const plan = planRelease({ ...base, beforeVersion: null }, published('0.2.0'))
    expect(plan).toMatchObject({ shouldPublish: true, releaseVersion: '0.3.0', autoBump: false })

    const already = planRelease({ ...base, beforeVersion: null }, published('0.3.0'))
    expect(already.shouldPublish).toBe(false)
  })

  it('tag 触发时按当前版本发布，已发布则跳过', () => {
    const tag = {
      event: 'tag' as const,
      version: '0.3.0',
      beforeVersion: null,
      changedFiles: [],
      headMessage: '',
      actor: 'blankPen',
    }
    expect(planRelease(tag, published('0.2.0'))).toMatchObject({
      shouldPublish: true,
      releaseVersion: '0.3.0',
      autoBump: false,
    })
    expect(planRelease(tag, published('0.3.0')).shouldPublish).toBe(false)
  })

  it('已发布的预发布版本无法自动升 patch 时明确报错', () => {
    const context = { ...base, version: '0.4.0-beta.1', beforeVersion: '0.4.0-beta.1' }
    expect(() => planRelease(context, published('0.4.0-beta.1'))).toThrow('无法自动升 patch')
  })
})
