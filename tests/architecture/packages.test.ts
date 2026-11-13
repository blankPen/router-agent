import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 架构边界：适配器包不能反向依赖宿主应用。
 *
 * - `packages/*` 只能引用 `@router-agent/*` 公开包或包内相对路径；
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

// 架构约束只针对包源码；包内测试仍可用仓库别名。
const sourceFiles = walk(packagesDir).filter(file => /\.(ts|tsx|mjs)$/.test(file) && !file.includes('/tests/'))

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const specs: string[] = []
  const pattern = /(?:\bfrom\s+|\bimport\s*\(\s*|vi\.mock\s*\(\s*)(['"])([^'"]+)\1/g
  for (const match of text.matchAll(pattern)) specs.push(match[2]!)
  return specs
}

describe('monorepo 包边界', () => {
  it('每个包都有 package.json 与入口', () => {
    for (const name of [
      'core',
      'infra',
      'runtime',
      'runtime-orca',
      'runtime-claude-code',
      'runtime-codex',
      'runtime-herdr',
      'runtime-acp',
      'runtime-t3code',
      'channel',
      'channel-feishu',
    ]) {
      const pkg = JSON.parse(readFileSync(join(packagesDir, name, 'package.json'), 'utf8')) as {
        name: string
        private?: boolean
      }
      expect(pkg.name).toBe(`@router-agent/${name}`)
      // SDK 与内置插件都可以从 npm 独立安装；根包通过依赖引用它们。
      expect(pkg.private).not.toBe(true)
      expect(readFileSync(join(packagesDir, name, 'src', 'index.ts'), 'utf8')).toMatch(/export /)
    }
  })

  it('插件模板与内建插件遵循同一套元数据与发布要求', () => {
    for (const name of ['runtime-plugin', 'channel-plugin']) {
      const dir = join(root, 'templates', name)
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name: string
        main?: string
        types?: string
        exports?: Record<string, unknown>
      }
      // 模板是可复制到仓库外发布的最小骨架：入口必须指向 dist，才能被插件加载器按包名加载。
      expect(pkg.main).toBe('./dist/index.js')
      expect(pkg.types).toBe('./dist/index.d.ts')
      expect(pkg.exports?.['.']).toEqual({ types: './dist/index.d.ts', import: './dist/index.js' })
      // 模板源码必须能通过 SDK 的类型检查，否则用户复制后第一步就红。
      expect(readFileSync(join(dir, 'src', 'index.ts'), 'utf8')).toMatch(/export default plugin/)
    }
  })

  it('适配器包不反向依赖宿主应用', () => {
    const offenders: string[] = []
    for (const file of sourceFiles) {
      const own = relative(packagesDir, file).split('/')[0]
      for (const spec of importsOf(file)) {
        if (spec.startsWith('#core/') || spec.startsWith('#infra/') || spec.startsWith('#runtime/') || spec.startsWith('#channel/')) {
          offenders.push(`${relative(root, file)} -> ${spec}`)
          continue
        }
        if (spec.startsWith('@router-agent/')) {
          const target = spec.slice('@router-agent/'.length).split('/')[0]!
          if (target !== own && !['core', 'infra', 'runtime', 'channel'].includes(target)) {
            // 运行时插件可以复用彼此的实现（例如 ACP 探测 Codex/Herdr）；只禁止反向依赖宿主。
            if (!target.startsWith('runtime-')) offenders.push(`${relative(root, file)} -> ${spec}`)
          }
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
