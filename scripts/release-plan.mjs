#!/usr/bin/env node
/**
 * 发布计划：决定一次 main 推送（或 tag / 手动触发）要不要发版、发哪个版本。
 *
 * 背景：合并到 main 后自动升 patch 并发布，省掉每次手动改 package.json 的发版 PR。
 * 判断顺序（先命中先返回）：
 *   1. tag / 手动触发：按 package.json 当前版本发布；npm 上已有同版本则跳过。
 *   2. main 推送：
 *      - 提交信息含 `[skip release]`，或由 Actions 机器人推送 → 跳过（防止回环）。
 *      - 本次推送改了 package.json 的 version → 视为手动发版（minor / major），按该版本发布。
 *      - 拿不到推送前的版本（force push / 首推）→ 当前版本未发布就发布，不自动升版。
 *      - 改动文件都不进 npm 包（文档 / 测试 / CI 等）→ 跳过，避免无意义地刷版本号。
 *      - 当前版本还没发出去（例如上一次发布失败）→ 先补发当前版本，不跳号。
 *      - 其余情况自动升 patch，并跳过 npm 上已被占用的版本（只跳过确实已发布的版本）。
 *
 * 输出：写到 `$GITHUB_OUTPUT`（should_publish / release_version / auto_bump / reason），
 * 有 `$GITHUB_STEP_SUMMARY` 时同时写一段可读的发布计划。
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 提交信息里带这个标记就跳过自动发版。 */
export const SKIP_KEYWORD = '[skip release]'

/** Actions 机器人推送的提交不再触发自动发版（避免自己升版后又被自己处理）。 */
export const BOT_ACTOR = 'github-actions[bot]'

/** 连续这么多个 patch 都在 npm 上时中止，避免死循环。 */
const MAX_BUMP_STEPS = 100

/**
 * 不会进入 npm 包（package.json 的 files 白名单只有 bin/ 与 dist/）的改动。
 * 命中这些路径的改动不触发自动升版。
 */
const NON_SHIPPING_PATTERNS = [
  /^docs\//,
  /^tests\//,
  /^\.github\//,
  /^\.claude\//,
  /\.md$/,
  /^(?:LICENSE|\.gitignore|\.npmrc|\.nvmrc)$/,
]

/**
 * 解析 `1.2.3` 形式的版本号；带预发布后缀等其它形式返回 null。
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number } | null}
 */
export function parseVersion(version) {
  const matched = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim())
  if (!matched) return null
  return {
    major: Number(matched[1]),
    minor: Number(matched[2]),
    patch: Number(matched[3]),
  }
}

/**
 * 判断这次改动里是否有会影响 npm 包产物的文件。
 * 空改动（例如只合了空提交）视为不影响产物。
 * @param {string[]} files
 * @returns {boolean}
 */
export function isShippableChange(files) {
  return files.some(file => {
    const path = file.trim()
    if (!path) return false
    return !NON_SHIPPING_PATTERNS.some(pattern => pattern.test(path))
  })
}

/**
 * 生成发布计划。
 * @param {{
 *   event: 'push' | 'tag' | 'workflow_dispatch',
 *   version: string,
 *   beforeVersion: string | null,
 *   changedFiles: string[],
 *   headMessage: string,
 *   actor: string,
 * }} context
 * @param {(version: string) => boolean} isPublished 该版本是否已存在于 npm
 * @returns {{ shouldPublish: boolean, releaseVersion: string, autoBump: boolean, reason: string }}
 */
export function planRelease(context, isPublished) {
  const { event, version, beforeVersion, changedFiles, headMessage, actor } = context

  const publish = (releaseVersion, autoBump, reason) => ({
    shouldPublish: true,
    releaseVersion,
    autoBump,
    reason,
  })
  const skip = reason => ({
    shouldPublish: false,
    releaseVersion: version,
    autoBump: false,
    reason,
  })

  if (event === 'tag' || event === 'workflow_dispatch') {
    return isPublished(version)
      ? skip(`v${version} 已存在于 npm，跳过`)
      : publish(version, false, `按 ${event === 'tag' ? 'tag' : '手动触发'}发布 v${version}`)
  }

  if (headMessage.includes(SKIP_KEYWORD)) {
    return skip(`提交信息包含 ${SKIP_KEYWORD}，跳过自动发版`)
  }
  if (actor === BOT_ACTOR) {
    return skip('由 Actions 机器人推送，跳过自动发版')
  }

  // 本次推送动了版本号：尊重人工选择（minor / major / 指定 patch），不再自动升。
  if (beforeVersion !== null && beforeVersion !== version) {
    return isPublished(version)
      ? skip(`v${version} 已存在于 npm，跳过`)
      : publish(version, false, `本次推送包含版本号变更，发布 v${version}`)
  }

  // 拿不到推送前的版本（force push、首次推送）时不做自动升版，避免猜错基线。
  if (beforeVersion === null) {
    return isPublished(version)
      ? skip(`v${version} 已存在于 npm，跳过`)
      : publish(version, false, '无法确定推送前的版本，按当前版本发布')
  }

  if (!isShippableChange(changedFiles)) {
    return skip('本次改动未触及会进入 npm 包的文件，跳过自动升版')
  }

  // 当前版本还没发出去（通常是上一次发布失败）：先补发当前版本，避免直接升 patch 把它跳成空洞。
  if (!isPublished(version)) {
    return publish(version, false, `v${version} 尚未发布，先补发当前版本`)
  }

  const parsed = parseVersion(version)
  if (!parsed) {
    throw new Error(
      `package.json 版本 ${version} 不是 x.y.z 形式，无法自动升 patch；请手动改好版本号后再合并到 main`,
    )
  }

  let { major, minor, patch } = parsed
  for (let step = 0; step < MAX_BUMP_STEPS; step += 1) {
    patch += 1
    const candidate = `${major}.${minor}.${patch}`
    if (!isPublished(candidate)) {
      return publish(candidate, true, `自动升 patch：v${version} → v${candidate}`)
    }
  }

  throw new Error(`连续 ${MAX_BUMP_STEPS} 个 patch 版本都已在 npm 上，自动升版已中止，请检查发布链路`)
}

/** 读取包名与版本；脚本默认在仓库根目录执行。 */
function readPackage() {
  const path = resolve(process.cwd(), 'package.json')
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
    throw new Error(`${path} 缺少 name 或 version`)
  }
  return { name: pkg.name, version: pkg.version }
}

/** 用 npm view 判断版本是否已发布；网络异常按「未发布」处理，与原有工作流一致。 */
function publishedChecker(name) {
  return version => {
    try {
      execFileSync('npm', ['view', `${name}@${version}`, 'version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
}

function writeOutput(key, value) {
  const line = `${key}=${String(value).replace(/[\r\n]+/g, ' ')}\n`
  const outputPath = process.env.GITHUB_OUTPUT
  if (outputPath) {
    appendFileSync(outputPath, line)
  } else {
    process.stdout.write(line)
  }
}

function readLines(path) {
  if (!path) return []
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function readText(path) {
  if (!path) return ''
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function writeSummary(plan) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (!summaryPath) return
  appendFileSync(
    summaryPath,
    [
      '### 发布计划',
      '',
      `- 是否发布：${plan.shouldPublish ? '是' : '否'}`,
      `- 发布版本：v${plan.releaseVersion}`,
      `- 自动升版：${plan.autoBump ? '是' : '否'}`,
      `- 原因：${plan.reason}`,
      '',
    ].join('\n'),
  )
}

function main() {
  const { name, version } = readPackage()
  const event = process.env.PLAN_EVENT === 'tag' || process.env.PLAN_EVENT === 'workflow_dispatch'
    ? process.env.PLAN_EVENT
    : 'push'

  const plan = planRelease(
    {
      event,
      version,
      beforeVersion: process.env.PLAN_BEFORE_VERSION || null,
      changedFiles: readLines(process.env.PLAN_CHANGED_FILES_FILE),
      headMessage: readText(process.env.PLAN_HEAD_MESSAGE_FILE),
      actor: process.env.PLAN_ACTOR ?? '',
    },
    publishedChecker(name),
  )

  writeOutput('should_publish', plan.shouldPublish)
  writeOutput('release_version', plan.releaseVersion)
  writeOutput('auto_bump', plan.autoBump)
  writeOutput('reason', plan.reason)
  writeSummary(plan)

  process.stdout.write(
    `[release-plan] ${plan.shouldPublish ? `发布 v${plan.releaseVersion}` : '跳过发布'}：${plan.reason}\n`,
  )
  return 0
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) {
  try {
    process.exitCode = main()
  } catch (error) {
    process.stderr.write(`[release-plan] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
