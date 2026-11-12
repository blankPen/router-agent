/**
 * 把 `dist/src/*` 拍平到 `dist/*`。
 *
 * monorepo 下 tsc 的 rootDir 是仓库根，产物会落到 `dist/src/...`；
 * 但 npm 包的对外结构（`dist/cli/main.js`、`dist/web`、`dist/update` …）
 * 与所有相对路径（package.json、web 资源、日志代码根）都按拍平后的布局写。
 * 这里在构建末尾把应用层目录搬回原位，保持发布形态与历史版本一致。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dist = join(root, 'dist')
const srcDist = join(dist, 'src')

if (!existsSync(srcDist)) {
  console.log('dist/src 不存在，跳过拍平')
  process.exit(0)
}

for (const entry of readdirSync(srcDist)) {
  const from = join(srcDist, entry)
  const to = join(dist, entry)
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true, force: true })
}
rmSync(srcDist, { recursive: true, force: true })
console.log('已把 dist/src/* 拍平到 dist/*')
