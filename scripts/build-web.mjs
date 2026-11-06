import { copyFileSync, mkdirSync } from 'node:fs'
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
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})

copyFileSync(join(root, 'src', 'web', 'index.html'), join(distWeb, 'index.html'))
copyFileSync(join(root, 'src', 'web', 'app.css'), join(distWeb, 'app.css'))

// tsc 只编译 TS，Markdown 资产需要单独复制到 dist。
const assets = [
  'src/worker/spec/prompt-mode.md',
  'src/worker/spec/agent-mode.md',
  'src/router/prompts/orchestrator.md',
  'src/router/prompts/admission.md',
  'src/router/prompts/conversation.md',
]
for (const asset of assets) {
  const from = join(root, asset)
  const to = join(root, 'dist', relative('src', asset))
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
}

console.log(`web 面板与 Markdown 资产已构建到 ${relative(root, distWeb)}`)
