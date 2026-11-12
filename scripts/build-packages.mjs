/**
 * 为每个 `@router-agent/*` 包生成可独立发布的 `packages/<name>/dist`。
 *
 * 根 `pnpm build` 的 tsc 产物在 `dist/packages/<pkg>/src`，不能直接作为独立包发布：
 * - 包的 `exports` 指向自己的 `dist/`；
 * - 插件包需要解析 `@router-agent/core` / `@router-agent/infra`，而不是根包私有别名
 *   `#core/*` / `#infra/*`（这些别名只在 router-agent 根包内有效）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const packagesDir = join(root, 'packages')
const builtRoot = join(root, 'dist', 'packages')

if (!existsSync(builtRoot)) {
  console.error('dist/packages 不存在，请先运行 pnpm build')
  process.exit(1)
}

const packages = readdirSync(packagesDir)
  .filter(name => existsSync(join(packagesDir, name, 'package.json')))
  .sort()

for (const name of packages) {
  const from = join(builtRoot, name, 'src')
  const to = join(packagesDir, name, 'dist')
  if (!existsSync(from)) continue
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true })
  for (const file of walk(to).filter(path => path.endsWith('.js'))) rewriteImports(file)
  const pkgPath = join(packagesDir, name, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const rootExport = typeof pkg.exports?.['.'] === 'string' ? pkg.exports['.'] : pkg.exports?.['.']?.import
  if (pkg.main !== './dist/index.js' || rootExport !== './dist/index.js') {
    console.warn(`packages/${name}/package.json 仍指向 src 或缺少 types，发布前检查 main / exports`)
  }
  console.log(`已构建 ${relative(root, to)}`)
}

for (const asset of [
  ['packages/runtime/src/spec/prompt-mode.md', 'packages/runtime/dist/spec/prompt-mode.md'],
  ['packages/runtime/src/spec/contract.md', 'packages/runtime/dist/spec/contract.md'],
]) {
  const [from, to] = asset
  if (!existsSync(join(root, from))) continue
  mkdirSync(dirname(join(root, to)), { recursive: true })
  cpSync(join(root, from), join(root, to))
}

function walk(dir) {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

function rewriteImports(file) {
  const text = readFileSync(file, 'utf8')
    .replaceAll("'#core/", "'@router-agent/core/")
    .replaceAll('"#core/', '"@router-agent/core/')
    .replaceAll("'#infra/", "'@router-agent/infra/")
    .replaceAll('"#infra/', '"@router-agent/infra/')
    .replaceAll("'#runtime/", "'@router-agent/runtime/")
    .replaceAll('"#runtime/', '"@router-agent/runtime/')
    .replaceAll("'#channel/", "'@router-agent/channel/")
    .replaceAll('"#channel/', '"@router-agent/channel/')
  writeFileSync(file, text, 'utf8')
}
