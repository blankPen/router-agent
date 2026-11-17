import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

const root = fileURLToPath(new URL('../../', import.meta.url))

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** 锁文件里记的内部包版本必须与包清单一致，否则 CI 的 frozen-lockfile 安装会失败。 */
describe('锁文件与包清单的版本一致', () => {
  it('pnpm-lock.yaml 里的内部包 specifier 与 package.json 一致', () => {
    const lock = parseYaml(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'))
    for (const [importer, entry] of Object.entries<Record<string, any>>(lock.importers)) {
      const manifestPath = importer === '.' ? join(root, 'package.json') : join(root, importer, 'package.json')
      const manifest = readJson(manifestPath)
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const [name, specifier] of Object.entries<string>(manifest[field] ?? {})) {
          if (!name.startsWith('@router-agent/')) continue
          expect(entry[field]?.[name]?.specifier, `${importer} 的 ${name}`).toBe(specifier)
        }
      }
    }
  })
})

/** 版本回写必须把锁文件一起提交，否则 main 上的锁文件会与包清单脱节。 */
describe('版本回写提交', () => {
  it('回写版本号的提交里带上 pnpm-lock.yaml', () => {
    const workflow = parseYaml(readFileSync(join(root, '.github/workflows/publish-npm.yml'), 'utf8'))
    const steps = workflow.jobs.publish.steps as { name?: string; run?: string }[]
    const writeback = steps.find(step => step.name === '回写版本号到 main')
    const gitAdd = String(writeback?.run ?? '').split('\n').find(line => line.trim().startsWith('git add'))
    expect(gitAdd).toContain('pnpm-lock.yaml')
  })
})

/** 三条长期分支各走各的 npm 渠道，预发布绝不能占用 latest。 */
describe('多分支发布渠道', () => {
  const workflow = parseYaml(readFileSync(join(root, '.github/workflows/publish-npm.yml'), 'utf8'))

  it('监听 main / beta / alpha 三条分支', () => {
    const branches = workflow.on.push.branches as string[]
    expect(branches).toContain('main')
    expect(branches).toContain('beta')
    expect(branches).toContain('alpha')
  })

  it('发布时带上 dist-tag，预发布不落到 latest', () => {
    const steps = workflow.jobs.publish.steps as { name?: string; run?: string }[]
    const publish = steps.find(step => step.name === '发布 SDK / 插件 / 根包到 npm')
    const run = String(publish?.run ?? '')
    // 插件与根包都要带 --tag，否则 npm 默认打 latest。
    expect(run).toContain('scripts/publish-packages.mjs --tag "$DIST_TAG"')
    expect(run).toContain('npm publish --provenance --json --tag "$DIST_TAG"')
  })

  it('版本号回写只对稳定版渠道生效', () => {
    const steps = workflow.jobs.publish.steps as { name?: string; if?: string }[]
    const writeback = steps.find(step => step.name === '回写版本号到 main')
    expect(writeback?.if).toContain("needs.check.outputs.writeback == 'true'")
  })

  it('发布前校验 dist-tag 与所在分支匹配', () => {
    const steps = workflow.jobs.publish.steps as { name?: string; run?: string }[]
    const validate = steps.find(step => step.name === '校验发布前置条件')
    const run = String(validate?.run ?? '')
    expect(run).toContain('refs/heads/beta')
    expect(run).toContain('refs/heads/alpha')
    expect(run).toContain('dist-tag 必须是 beta')
    expect(run).toContain('dist-tag 必须是 alpha')
  })
})
