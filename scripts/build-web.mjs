import { copyFileSync, cpSync, mkdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const distWeb = join(root, 'dist', 'web')

mkdirSync(distWeb, { recursive: true })

await build({
  entryPoints: [join(root, 'src', 'web', 'client', 'app.tsx')],
  bundle: true,
  format: 'esm',
  minify: true,
  sourcemap: true,
  target: ['es2022'],
  outfile: join(distWeb, 'app.js'),
  tsconfig: join(root, 'tsconfig.json'),
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})

copyFileSync(join(root, 'src', 'web', 'index.html'), join(distWeb, 'index.html'))
copyFileSync(join(root, 'src', 'web', 'app.css'), join(distWeb, 'app.css'))
// 品牌图标等静态资源随面板一起发布。
cpSync(join(root, 'src', 'web', 'assets'), join(distWeb, 'assets'), { recursive: true })

// tsc 只编译 TS，Markdown 资产需要单独复制到 dist。
// Worker 模板在运行时包里（`<home>/specs/worker` 覆盖、其余读随包内置），
// Router 提示词仍在宿主 `src/router/prompts`，两者落点都相对各自的源码目录。
// 运行时包的模板要落在编译产物旁边（`dist/packages/runtime/src/spec/`），
// 因为 reader 用 `import.meta.url` 相对定位内置模板。
const packageAssets = [
  'packages/runtime/src/spec/prompt-mode.md',
  'packages/runtime/src/spec/contract.md',
]
for (const asset of packageAssets) {
  const to = join(root, 'dist', asset.replace(/^packages\//, 'packages/'))
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(join(root, asset), to)
}

const assets = [
  'src/router/prompts/orchestrator.md',
  'src/router/prompts/admission.md',
  'src/router/prompts/conversation.md',
  'src/router/prompts/intake-screener.md',
  'src/router/prompts/intake-analyst.md',
  'src/router/prompts/soul.md',
]
for (const asset of assets) {
  const from = join(root, asset)
  // 宿主源码在 src/ 下，去掉这层 src/ 后与 dist 结构对齐。
  const rel = asset.replace(/^src\//, '')
  const to = join(root, 'dist', rel)
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
}

console.log(`web 面板与 Markdown 资产已构建到 ${relative(root, distWeb)}`)
