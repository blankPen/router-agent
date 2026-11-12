#!/usr/bin/env node
/**
 * 多包发布：按依赖顺序发布 SDK、内置插件，最后发布根包 router-agent。
 *
 * 版本统一由根 package.json 决定：发布前把所有 @router-agent/* 包与根包依赖
 * 同步到同一版本，避免插件依赖 0.0.0 导致安装后找不到文件。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const rootPkgPath = join(root, 'package.json')
const rootPkg = readJson(rootPkgPath)
const version = rootPkg.version

/** 发布顺序：先 SDK，再插件，最后根包。 */
export const PUBLISH_ORDER = [
  'core',
  'infra',
  'runtime',
  'channel',
  'runtime-codex',
  'runtime-herdr',
  'runtime-claude-code',
  'runtime-orca',
  'runtime-acp',
  'channel-feishu',
]

const INTERNAL_PREFIX = '@router-agent/'

export function packageDir(name) {
  return join(root, 'packages', name)
}

export function packagePath(name) {
  return join(packageDir(name), 'package.json')
}

/** 把包清单里的内部依赖与自身版本统一到目标版本。 */
export function syncManifest(pkg, targetVersion) {
  const next = structuredClone(pkg)
  next.version = targetVersion
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!next[field] || typeof next[field] !== 'object') continue
    for (const [name, value] of Object.entries(next[field])) {
      if (name.startsWith(INTERNAL_PREFIX) && typeof value === 'string') next[field][name] = targetVersion
    }
  }
  return next
}

/** 根包依赖里的自带插件也同步版本；用户扩展包不会被改。 */
export function syncRootDependencies(pkg, targetVersion) {
  const next = structuredClone(pkg)
  const bundled = new Set([
    ...PUBLISH_ORDER.map(name => `@router-agent/${name}`),
    '@router-agent/runtime-acp',
  ])
  for (const field of ['dependencies', 'optionalDependencies']) {
    if (!next[field] || typeof next[field] !== 'object') continue
    for (const name of Object.keys(next[field])) {
      if (bundled.has(name)) next[field][name] = targetVersion
    }
  }
  return next
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function writeVersionedManifests(targetVersion) {
  for (const name of PUBLISH_ORDER) {
    const path = packagePath(name)
    if (!existsSync(path)) throw new Error(`缺少包清单：${relative(root, path)}`)
    writeFileSync(path, `${JSON.stringify(syncManifest(readJson(path), targetVersion), null, 2)}\n`, 'utf8')
  }
  writeFileSync(rootPkgPath, `${JSON.stringify(syncRootDependencies(rootPkg, targetVersion), null, 2)}\n`, 'utf8')
}

/** 发布前确认包入口指向 dist，防止把 src 发布出去。 */
export function assertPackable(name, pkg) {
  const dir = pkg.exports?.['.']
  const main = typeof dir === 'string' ? dir : dir?.import
  if (main !== './dist/index.js') {
    throw new Error(`@router-agent/${name} 的入口不是 ./dist/index.js（当前 ${String(main)}）`)
  }
  if (typeof dir === 'object' && dir?.types !== './dist/index.d.ts') {
    throw new Error(`@router-agent/${name} 缺少 exports["."].types，安装后无法获得类型声明`)
  }
  if (!existsSync(join(packageDir(name), 'dist', 'index.js'))) {
    throw new Error(`@router-agent/${name} 缺少 dist/index.js，请先运行 pnpm build`)
  }
  if (!existsSync(join(packageDir(name), 'dist', 'index.d.ts'))) {
    throw new Error(`@router-agent/${name} 缺少 dist/index.d.ts，请先运行 pnpm build`)
  }
  if (!pkg.repository) {
    throw new Error(`@router-agent/${name} 缺少 repository，npm provenance 无法关联源码仓库`)
  }
  const externals = undeclaredDependencies(packageDir(name))
  if (externals.length > 0) {
    throw new Error(
      `@router-agent/${name} 未声明第三方依赖：${externals.join(', ')}；`
      + '独立安装后会解析不到，请在包清单的 dependencies 里补上',
    )
  }
}

const NODE_BUILTINS = new Set(['assert', 'buffer', 'child_process', 'crypto', 'fs', 'http', 'https', 'module', 'net', 'os', 'path', 'process', 'readline', 'sqlite', 'stream', 'timers', 'tty', 'url', 'util', 'worker_threads', 'zlib'])

/** 包源码里 import 了、但没写进 dependencies 的第三方包；独立发布后会缺依赖。 */
export function undeclaredDependencies(dir) {
  const pkg = readJson(join(dir, 'package.json'))
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ])
  const found = new Map()
  const walkSource = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === 'tests' || entry.name === 'dist' || entry.name === 'node_modules') continue
      const full = join(path, entry.name)
      if (entry.isDirectory()) {
        walkSource(full)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue
      const text = readFileSync(full, 'utf8')
      for (const match of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)(['"])([^'"]+)\1/g)) {
        const spec = match[2]
        if (spec.startsWith('.') || spec.startsWith('#') || spec.startsWith('@router-agent/')) continue
        const bare = spec.startsWith('node:') ? spec.slice(5) : spec
        const name = bare.startsWith('@') ? bare.split('/').slice(0, 2).join('/') : bare.split('/')[0]
        if (NODE_BUILTINS.has(name) || declared.has(name)) continue
        found.set(name, (found.get(name) ?? 0) + 1)
      }
    }
  }
  const src = join(dir, 'src')
  if (existsSync(src)) walkSource(src)
  return [...found.keys()].sort()
}

function publishOne(name, targetVersion) {
  const pkg = readJson(packagePath(name))
  assertPackable(name, pkg)
  const out = `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`
  console.log(`[publish-packages] 发布 ${pkg.name}@${targetVersion}`)
  try {
    const stdout = execFileSync('npm', ['publish', '--provenance', '--json', '--access', 'public'], {
      cwd: packageDir(name),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    })
    writeFileSync(join(process.env.RUNNER_TEMP ?? '/tmp', out), stdout)
  } catch (error) {
    const stdout = String(error.stdout ?? '')
    const stderr = String(error.stderr ?? '')
    const diagnostic = scopeDiagnostic(pkg.name, stdout, stderr)
    // 保留 npm 原始输出，别让「E404」这类关键行被截掉。
    const raw = `${stdout}\n${stderr}`.trim()
      .split('\n')
      .filter(line => line.trim())
      .slice(-10)
      .join('\n')
    throw new Error(`${pkg.name}@${targetVersion} 发布失败：${diagnostic}${raw ? `\n--- npm 输出（末 10 行）---\n${raw}` : ''}`)
  }
}

/** 把 npm 的 E404/E403 翻译成可操作提示，避免只看到 registry Not Found。 */
export function scopeDiagnostic(name, stdout, stderr) {
  const text = `${stdout}\n${stderr}`
  if (/E404|Not Found/i.test(text) && (name.startsWith('@') || name === 'router-agent')) {
    return [
      'npm 返回 E404。通常不是包名不存在，而是 NPM_TOKEN 没有该包/作用域的发布权限。',
      '请确认 token 是 Granular Access Token，权限为 Read and write (publish and stage)，',
      `Packages 覆盖 ${name.startsWith('@') ? `${name.split('/')[0]}/*` : name}；首次发布未存在的包时选 All packages。`,
      '同时确认 2FA bypass 已勾选，且 registry 是 https://registry.npmjs.org/。',
    ].join(' ')
  }
  return text.trim().split('\n').slice(-8).join('\n') || 'npm publish 失败'
}

/** 根包已存在时，发布者必须是维护者；否则 npm 会伪装成 404 拒绝写入。 */
export function assertPublisher(packageName, whoami, owners) {
  const user = String(whoami ?? '').trim()
  if (!user) {
    throw new Error('npm whoami 没有返回用户名：NPM_TOKEN 无效或未绑定 NODE_AUTH_TOKEN')
  }
  const maintainers = String(owners ?? '')
    .split('\n')
    .map(line => line.match(/^(\S+)\s+<([^>]+)>/)?.[1] ?? '')
    .filter(Boolean)
  if (maintainers.length > 0 && !maintainers.includes(user)) {
    throw new Error([
      `NPM_TOKEN 属于 ${user}，但不是 ${packageName} 的维护者（${maintainers.join(', ')}）。`,
      'npm 对无权限的发布返回 E404，而不是 E403；请用维护者账号重新生成 Granular Access Token，',
      `Packages 覆盖 ${packageName} 与 @router-agent/*。`,
    ].join(''))
  }
  return user
}

/**
 * 发布前预检：确保在发布任何插件之前就能发现权限问题。
 *
 * 两类包必须都能发：
 * - 已存在的根包 `router-agent`：token 用户必须是 maintainer，否则 npm 会伪装成 404；
 * - 尚未发布的 `@router-agent/*` 作用域：Granular token 的 Packages 必须覆盖该作用域，
 *   否则首次发布同样返回 404。`npm whoami` 只能证明 token 有效，证明不了作用域权限，
 *   所以这里额外提示用户核对 token 的 Packages 设置。
 */
export function verifyPublisher(packageName = 'router-agent', scope = '@router-agent') {
  const run = args => execFileSync('npm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const user = run(['whoami']).trim()
  // 用 registry 的 maintainers 字段而不是 `npm owner ls`：后者在未登录时会输出
  // 包名占位，无法区分「谁有权发布」。
  const raw = run(['view', packageName, 'maintainers', '--json']).trim()
  const parsed = JSON.parse(raw)
  const owners = Array.isArray(parsed)
    ? parsed.map(item => (typeof item === 'string' ? item : `${item.name} <${item.email}>`)).join('\n')
    : String(parsed)
  assertPublisher(packageName, user, owners)
  console.log(`[publish-packages] token 用户 ${user} 是 ${packageName} 的维护者；还需确认 token 的 Packages 覆盖 ${scope}/*`)
  return user
}

/** 某个包版本是否已存在于 npm；网络/权限问题按「不确定」处理，交给真正的发布暴露。 */
export function versionExists(name, targetVersion) {
  try {
    const out = execFileSync('npm', ['view', `${name}@${targetVersion}`, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return out.trim() !== ''
  } catch {
    return false
  }
}

/**
 * 发布前确认所有包的目标版本都还没被占用。
 *
 * 插件先于根包发布：如果根包版本已存在，插件可能已经发出去了，形成半发布状态。
 * 这里一次性查完，任何包已占用就中止。
 */
export function assertUnpublished(names, targetVersion) {
  const taken = names.filter(name => {
    const pkg = readJson(packagePath(name))
    return versionExists(pkg.name, targetVersion)
  })
  if (taken.length > 0) {
    throw new Error(
      `${taken.map(name => readJson(packagePath(name)).name).join(', ')}@${targetVersion} 已存在于 npm，`
      + '请先升级根 package.json 的版本号再发布',
    )
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const sync = argv.includes('--sync')
  const dryRun = argv.includes('--dry-run')
  const check = argv.includes('--check-publisher')
  const checkVersions = argv.includes('--check-versions')
  if (sync) writeVersionedManifests(version)
  if (check) {
    const user = verifyPublisher('router-agent')
    console.log(`[publish-packages] 发布者校验通过：${user}`)
    return
  }
  if (checkVersions) {
    assertUnpublished(PUBLISH_ORDER, version)
    console.log(`[publish-packages] 待发布版本 ${version} 未被占用`)
    return
  }
  for (const name of PUBLISH_ORDER) {
    const pkg = readJson(packagePath(name))
    if (dryRun) {
      assertPackable(name, pkg)
      console.log(`[publish-packages] dry-run ${pkg.name}@${version}`)
      continue
    }
    publishOne(name, version)
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invoked === import.meta.url) {
  try {
    await main()
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
