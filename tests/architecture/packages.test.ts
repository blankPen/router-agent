import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 架构边界：适配器包不能反向依赖宿主应用。
 *
 * - `packages/*` 只能引用 `#core` / `#infra` / `#runtime` / `#channel` 或包内相对路径；
 * - 不能出现 `src/`、跨包相对路径等宿主耦合；
 * - 运行时与通道包互不依赖（都只向下依赖 core / infra）。
 */
const root = join(import.meta.dirname, '..', '..')
const packagesDir = join(root, 'packages')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    if (entry === 'node_modules' || entry === 'dist') return []
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

const sourceFiles = walk(packagesDir).filter(file => /\.(ts|tsx|mjs)$/.test(file))

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const specs: string[] = []
  const pattern = /(?:\bfrom\s+|\bimport\s*\(\s*|vi\.mock\s*\(\s*)(['"])([^'"]+)\1/g
  for (const match of text.matchAll(pattern)) specs.push(match[2]!)
  return specs
}

describe('monorepo 包边界', () => {
  it('每个包都有 package.json 与入口', () => {
    for (const name of ['core', 'infra', 'runtime', 'channel']) {
      const pkg = JSON.parse(readFileSync(join(packagesDir, name, 'package.json'), 'utf8')) as {
        name: string
        private?: boolean
      }
      expect(pkg.name).toBe(`@router-agent/${name}`)
      expect(pkg.private).toBe(true)
      expect(readFileSync(join(packagesDir, name, 'src', 'index.ts'), 'utf8')).toMatch(/export /)
    }
  })

  it('适配器包不反向依赖宿主应用', () => {
    const offenders: string[] = []
    for (const file of sourceFiles) {
      const own = relative(packagesDir, file).split('/')[0]
      for (const spec of importsOf(file)) {
        if (spec.startsWith('#core/') || spec.startsWith('#infra/')) continue
        if (spec.startsWith('#runtime/') || spec.startsWith('#channel/')) {
          const used = spec.slice(1, spec.indexOf('/'))
          if (used !== own) offenders.push(`${relative(root, file)} -> ${spec}`)
          continue
        }
        if (!spec.startsWith('.')) continue
        const target = relative(root, join(file, '..', spec))
        if (target.startsWith('..')) offenders.push(`${relative(root, file)} -> ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('宿主源码统一走包别名，不再出现 worker/channels 旧路径', () => {
    const appFiles = walk(join(root, 'src')).filter(file => /\.(ts|tsx)$/.test(file))
    const legacy = appFiles.flatMap(file =>
      importsOf(file)
        .filter(spec => /^(\.\.\/)+(worker|channels)\//.test(spec))
        .map(spec => `${relative(root, file)} -> ${spec}`))
    expect(legacy).toEqual([])
  })
})
