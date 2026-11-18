import { describe, expect, it } from 'vitest'
import {
  BOT_ACTOR,
  CHANNEL_DIST_TAGS,
  SKIP_KEYWORD,
  createPublishedChecker,
  isShippableChange,
  parseReleaseTag,
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
  branch: 'main' as const,
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
      applyVersion: true,
      writeback: true,
      distTag: 'latest',
    })
  })

  it('自动升版会跳过 npm 上已占用的 patch', () => {
    const plan = planRelease(base, published('0.3.0', '0.3.1', '0.3.2'))
    expect(plan.releaseVersion).toBe('0.3.3')
    expect(plan.applyVersion).toBe(true)
  })

  it('当前版本还没发布时先补发当前版本，不留空洞', () => {
    const plan = planRelease(
      { ...base, version: '0.4.0', beforeVersion: '0.4.0' },
      published('0.3.0'),
    )
    expect(plan).toMatchObject({ shouldPublish: true, releaseVersion: '0.4.0', applyVersion: false })
    expect(plan.reason).toContain('尚未发布')
  })

  it('推送里手动改了版本号时按该版本发布，不再自动升', () => {
    const plan = planRelease(
      { ...base, version: '0.4.0' },
      published('0.3.0'),
    )
    expect(plan).toMatchObject({ shouldPublish: true, releaseVersion: '0.4.0', applyVersion: false })
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
    expect(plan).toMatchObject({ shouldPublish: true, releaseVersion: '0.3.0', applyVersion: false })

    const already = planRelease({ ...base, beforeVersion: null }, published('0.3.0'))
    expect(already.shouldPublish).toBe(false)
  })

  it('main 上的版本不是 x.y.z 时拒绝发布，避免预发布占用 latest', () => {
    expect(() => planRelease(
      { ...base, version: '0.4.0-beta.1', beforeVersion: '0.4.0-beta.1' },
      published('0.4.0-beta.1'),
    )).toThrow('x.y.z')
  })

  it('main 上未发布的预发布版本不会被补发到 latest', () => {
    expect(() => planRelease(
      { ...base, version: '0.4.0-beta.1', beforeVersion: '0.4.0-beta.1' },
      published('0.3.0'),
    )).toThrow('x.y.z')
  })
})

describe('分支与 dist-tag 映射', () => {
  it('main 走稳定版 latest，beta / alpha 走各自的预发布标签', () => {
    expect(CHANNEL_DIST_TAGS.main).toBe('latest')
    expect(CHANNEL_DIST_TAGS.beta).toBe('beta')
    expect(CHANNEL_DIST_TAGS.alpha).toBe('alpha')
  })

  it('beta 分支的发布计划挂在 beta 上，不占用 latest', () => {
    const plan = planRelease(
      { ...base, branch: 'beta' as const, version: '0.3.40', latestStable: '0.3.40' },
      published('0.3.40'),
    )
    expect(plan.distTag).toBe('beta')
    expect(plan.distTag).not.toBe('latest')
  })

  it('alpha 分支的发布计划挂在 alpha 上，不占用 latest', () => {
    const plan = planRelease(
      { ...base, branch: 'alpha' as const, version: '0.3.40', latestStable: '0.3.40' },
      published('0.3.40'),
    )
    expect(plan.distTag).toBe('alpha')
    expect(plan.distTag).not.toBe('latest')
  })
})

describe('预发布版本号自动计算', () => {
  it('预发布版本是最新稳定版下一版的预发布', () => {
    const plan = planRelease(
      { ...base, branch: 'beta' as const, version: '0.3.40', latestStable: '0.3.40' },
      published('0.3.40'),
    )
    expect(plan.shouldPublish).toBe(true)
    expect(plan.releaseVersion).toBe('0.3.41-beta.1')
    expect(plan.applyVersion).toBe(true)
  })

  it('预发布序号递增，跳过已被占用的版本', () => {
    const plan = planRelease(
      { ...base, branch: 'beta' as const, version: '0.3.40', latestStable: '0.3.40' },
      published('0.3.40', '0.3.41-beta.1'),
    )
    expect(plan.releaseVersion).toBe('0.3.41-beta.2')
  })

  it('组件包已可见而根包未可见时，仍跳过已被占用的预发布版本', () => {
    const versions = new Map([
      ['@router-agent/core', ['0.3.42-beta.1', '0.3.42-beta.2', '0.3.42-beta.3', '0.3.42-beta.4']],
      ['router-agent', ['0.3.42-beta.1', '0.3.42-beta.2', '0.3.42-beta.3']],
    ])
    const isPublished = createPublishedChecker(
      ['@router-agent/core', 'router-agent'],
      name => versions.get(name) ?? [],
    )
    const plan = planRelease(
      { ...base, branch: 'beta' as const, version: '0.3.41', beforeVersion: '0.3.41', latestStable: '0.3.41' },
      isPublished,
    )
    expect(plan.releaseVersion).toBe('0.3.42-beta.5')
  })

  it('beta 与 alpha 不会产出相同的版本', () => {
    const beta = planRelease(
      { ...base, branch: 'beta' as const, version: '0.3.40', latestStable: '0.3.40' },
      published('0.3.40'),
    )
    const alpha = planRelease(
      { ...base, branch: 'alpha' as const, version: '0.3.40', latestStable: '0.3.40' },
      published('0.3.40'),
    )
    expect(beta.releaseVersion).toBe('0.3.41-beta.1')
    expect(alpha.releaseVersion).toBe('0.3.41-alpha.1')
    expect(beta.releaseVersion).not.toBe(alpha.releaseVersion)
  })

  it('基线取 npm 上的最新稳定版，不受分支上旧版本号影响', () => {
    const plan = planRelease(
      { ...base, branch: 'beta' as const, version: '0.3.20', latestStable: '0.3.40' },
      published('0.3.40'),
    )
    expect(plan.releaseVersion).toBe('0.3.41-beta.1')
  })

  it('当前预发布版本还没发布时先补发，不留空洞', () => {
    const plan = planRelease(
      { ...base, branch: 'beta' as const, version: '0.3.41-beta.1', beforeVersion: '0.3.41-beta.1', latestStable: '0.3.40' },
      published('0.3.40'),
    )
    expect(plan).toMatchObject({ shouldPublish: true, releaseVersion: '0.3.41-beta.1', applyVersion: false })
    expect(plan.reason).toContain('尚未发布')
  })

  it('预发布分支同步了 main 的版本号时按最新稳定版重算预发布版本', () => {
    const plan = planRelease(
      { ...base, branch: 'beta' as const, version: '0.3.40', beforeVersion: '0.3.39', latestStable: '0.3.40' },
      published('0.3.40'),
    )
    expect(plan).toMatchObject({ shouldPublish: true, releaseVersion: '0.3.41-beta.1', applyVersion: true })
  })

  it('预发布分支只有文档改动时跳过发版', () => {
    const plan = planRelease(
      { ...base, branch: 'beta' as const, changedFiles: ['docs/PUBLISHING.md'], latestStable: '0.3.40' },
      published('0.3.40'),
    )
    expect(plan.shouldPublish).toBe(false)
    expect(plan.reason).toContain('未触及')
  })

  it('预发布分支不回写版本号到 main', () => {
    const plan = planRelease(
      { ...base, branch: 'beta' as const, version: '0.3.40', latestStable: '0.3.40' },
      published('0.3.40'),
    )
    expect(plan.writeback).toBe(false)
  })

  it('手动改的版本必须是本渠道的预发布形式', () => {
    expect(() => planRelease(
      { ...base, branch: 'beta' as const, version: '0.3.41-alpha.1', beforeVersion: '0.3.40' },
      published('0.3.40'),
    )).toThrow('beta')
  })

  it('拿不到基线提交时跳过预发布发布', () => {
    const plan = planRelease(
      { ...base, branch: 'beta' as const, version: '0.3.40', beforeVersion: null, latestStable: '0.3.40' },
      published('0.3.40'),
    )
    expect(plan.shouldPublish).toBe(false)
    expect(plan.reason).toContain('基线')
  })
})

describe('tag 触发', () => {
  it('解析 tag 里的渠道与版本', () => {
    expect(parseReleaseTag('v0.3.41')).toEqual({ channel: 'stable', version: '0.3.41' })
    expect(parseReleaseTag('v0.3.41-beta.2')).toEqual({ channel: 'beta', version: '0.3.41-beta.2' })
    expect(parseReleaseTag('v0.3.41-alpha.7')).toEqual({ channel: 'alpha', version: '0.3.41-alpha.7' })
    expect(parseReleaseTag('v0.3.41-rc.1')).toBeNull()
    expect(parseReleaseTag('v0.3.41-beta')).toBeNull()
    expect(parseReleaseTag('main')).toBeNull()
  })

  it('稳定 tag 按 latest 发布，版本需与 package.json 一致', () => {
    const plan = planRelease(
      { ...base, event: 'tag' as const, version: '0.3.0', tagName: 'v0.3.0', tagBranches: ['main'] },
      published('0.2.0'),
    )
    expect(plan).toMatchObject({
      shouldPublish: true,
      releaseVersion: '0.3.0',
      distTag: 'latest',
    })
  })

  it('稳定 tag 与 package.json 版本不一致时拒绝发布', () => {
    expect(() => planRelease(
      { ...base, event: 'tag' as const, version: '0.3.0', tagName: 'v0.3.1', tagBranches: ['main'] },
      published(),
    )).toThrow('与 package.json 版本')
  })

  it('稳定 tag 不在 main 上时拒绝发布，避免占用 latest', () => {
    expect(() => planRelease(
      { ...base, event: 'tag' as const, version: '0.3.0', tagName: 'v0.3.0', tagBranches: ['beta'] },
      published(),
    )).toThrow('main')
  })

  it('beta tag 按 beta 渠道发布，不占用 latest', () => {
    const plan = planRelease(
      {
        ...base,
        event: 'tag' as const,
        branch: 'beta' as const,
        version: '0.3.41-beta.2',
        tagName: 'v0.3.41-beta.2',
        tagBranches: ['beta'],
      },
      published('0.3.0'),
    )
    expect(plan).toMatchObject({
      shouldPublish: true,
      releaseVersion: '0.3.41-beta.2',
      distTag: 'beta',
    })
    expect(plan.distTag).not.toBe('latest')
  })

  it('alpha tag 按 alpha 渠道发布，不占用 latest', () => {
    const plan = planRelease(
      {
        ...base,
        event: 'tag' as const,
        branch: 'alpha' as const,
        version: '0.3.41-alpha.7',
        tagName: 'v0.3.41-alpha.7',
        tagBranches: ['alpha'],
      },
      published('0.3.0'),
    )
    expect(plan).toMatchObject({
      shouldPublish: true,
      releaseVersion: '0.3.41-alpha.7',
      distTag: 'alpha',
    })
    expect(plan.distTag).not.toBe('latest')
  })

  it('tag 触发时版本已发布则跳过', () => {
    const plan = planRelease(
      { ...base, event: 'tag' as const, version: '0.3.0', tagName: 'v0.3.0', tagBranches: ['main'] },
      published('0.3.0'),
    )
    expect(plan.shouldPublish).toBe(false)
    expect(plan.reason).toContain('已存在于 npm')
  })

  it('不支持的 tag 格式被拒绝', () => {
    expect(() => planRelease(
      { ...base, event: 'tag' as const, version: '0.3.41-rc.1', tagName: 'v0.3.41-rc.1', tagBranches: ['main'] },
      published(),
    )).toThrow('tag')
  })

  it('beta tag 必须从 beta 分支推送', () => {
    expect(() => planRelease(
      {
        ...base,
        event: 'tag' as const,
        version: '0.3.41-beta.2',
        tagName: 'v0.3.41-beta.2',
        tagBranches: ['main', 'alpha'],
      },
      published(),
    )).toThrow('beta')
  })

  it('alpha tag 不能从 main 推送', () => {
    expect(() => planRelease(
      {
        ...base,
        event: 'tag' as const,
        version: '0.3.41-alpha.7',
        tagName: 'v0.3.41-alpha.7',
        tagBranches: ['main'],
      },
      published(),
    )).toThrow('alpha')
  })

  it('beta tag 与 package.json 版本不一致时拒绝发布', () => {
    expect(() => planRelease(
      {
        ...base,
        event: 'tag' as const,
        version: '0.3.41-beta.1',
        tagName: 'v0.3.41-beta.2',
        tagBranches: ['beta'],
      },
      published(),
    )).toThrow('与 package.json 版本')
  })
})
