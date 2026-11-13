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
