#!/usr/bin/env node
/**
 * 发布计划：决定一次分支推送（或 tag / 手动触发）要不要发版、发哪个版本、挂哪个 dist-tag。
 *
 * 背景：合并到 main 后自动升 patch 并发布，省掉每次手动改 package.json 的发版 PR。
 * 后来加了 beta / alpha 两条长期分支：同一份代码要按分支发到不同的 npm 渠道，
 * 稳定版走 `latest`，预发布走 `beta` / `alpha`，两者绝不共用同一个 dist-tag。
 *
 * 分支渠道约定（CHANNEL_DIST_TAGS）：
 *   main  → 稳定版 vX.Y.Z，dist-tag = latest
 *   beta  → 预发布 vX.Y.Z-beta.N，dist-tag = beta
 *   alpha → 预发布 vX.Y.Z-alpha.N，dist-tag = alpha
 *
 * 判断顺序（先命中先返回）：
 *   1. tag / 手动触发：按 package.json 当前版本发布；npm 上已有同版本则跳过。
 *   2. 分支推送：
 *      - 提交信息含 `[skip release]`，或由 Actions 机器人推送 → 跳过（防止回环）。
 *      - 本次推送改了 package.json 的 version → 视为手动发版（minor / major），按该版本发布。
 *      - 拿不到推送前的版本（force push / 首推）→ 当前版本未发布就发布，不自动升版。
 *      - 改动文件都不进 npm 包（文档 / 测试 / CI 等）→ 跳过，避免无意义地刷版本号。
 *      - 当前版本还没发出去（例如上一次发布失败）→ 先补发当前版本，不跳号。
 *      - 其余情况自动升版，并跳过 npm 上已被占用的版本
 *        （根包或任一组件包已发布都算占用，避免 npm 传播延迟导致同版本重复计划）。
 *
 * 输出：写到 `$GITHUB_OUTPUT`（should_publish / release_version / apply_version /
 * dist_tag / writeback / reason），有 `$GITHUB_STEP_SUMMARY` 时同时写一段可读的发布计划。
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PUBLISH_ORDER, packagePath } from './publish-packages.mjs'

/** 提交信息里带这个标记就跳过自动发版。 */
export const SKIP_KEYWORD = '[skip release]'

/** Actions 机器人推送的提交不再触发自动发版（避免自己升版后又被自己处理）。 */
export const BOT_ACTOR = 'github-actions[bot]'

/** 各分支渠道对应的 npm dist-tag。beta / alpha 绝不能占用 latest。 */
export const CHANNEL_DIST_TAGS = {
  main: 'latest',
  beta: 'beta',
  alpha: 'alpha',
}

/** 预发布渠道；它们的版本号带预发布后缀，且不回写 main。 */
export const PRERELEASE_BRANCHES = ['beta', 'alpha']

/** 分支 → 预发布后缀。 */
const PRERELEASE_SUFFIX = {
  beta: 'beta',
  alpha: 'alpha',
}

/** 连续这么多个 patch 都在 npm 上时中止，避免死循环。 */
const MAX_BUMP_STEPS = 100

/** 预发布序号的上限，避免在版本空间里无限找空位。 */
const MAX_PRERELEASE_STEPS = 100

/**
 * 不会进入 npm 包（package.json 的 files 白名单只有 bin/ 与 dist/）的改动。
 * 命中这些路径的改动不触发自动升版。
 *
 * 适配器包的源码（`packages/<name>/src/`）会被 tsc 编进 `dist/packages/`，
 * 因此属于产物改动；包内的测试 / 文档 / 清单（package.json、tests/、*.md）
 * 不会进包，单独命中时不触发发版。
 */
const NON_SHIPPING_PATTERNS = [
  /^docs\//,
  /^tests\//,
  /^packages\/[^/]+\/tests\//,
  /^packages\/[^/]+\/package\.json$/,
  /^\.github\//,
  /^\.claude\//,
  /\.md$/,
  /^(?:LICENSE|\.gitignore|\.npmrc|\.nvmrc|pnpm-workspace\.yaml)$/,
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
 * 解析预发布版本号，如 `0.3.41-beta.2`。
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number, channel: 'beta' | 'alpha', seq: number } | null}
 */
export function parsePrereleaseVersion(version) {
  const matched = /^(\d+)\.(\d+)\.(\d+)-(beta|alpha)\.(\d+)$/.exec(String(version).trim())
  if (!matched) return null
  return {
    major: Number(matched[1]),
    minor: Number(matched[2]),
    patch: Number(matched[3]),
    channel: matched[4],
    seq: Number(matched[5]),
  }
}

/**
 * 解析发布 tag：稳定版 `vX.Y.Z`、预发布 `vX.Y.Z-beta.N` / `vX.Y.Z-alpha.N`。
 * 不认识的格式返回 null（例如 `vX.Y.Z-rc.1`）。
 * @param {string} tagName
 * @returns {{ channel: 'stable' | 'beta' | 'alpha', version: string } | null}
 */
export function parseReleaseTag(tagName) {
  const name = String(tagName ?? '').trim()
  if (!name.startsWith('v')) return null
  const version = name.slice(1)
  if (parseVersion(version)) return { channel: 'stable', version }
  const prerelease = parsePrereleaseVersion(version)
  if (prerelease) return { channel: prerelease.channel, version }
  return null
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
 *   branch: 'main' | 'beta' | 'alpha',
 *   latestStable?: string | null,
 *   tagName?: string | null,
 *   tagBranches?: string[],
 * }} context
 * @param {(version: string) => boolean} isPublished 该版本是否已存在于 npm
 * @returns {{
 *   shouldPublish: boolean,
 *   releaseVersion: string,
 *   applyVersion: boolean,
 *   distTag: string,
 *   writeback: boolean,
 *   reason: string,
 * }}
 */
export function planRelease(context, isPublished) {
  const {
    event,
    version,
    beforeVersion,
    changedFiles,
    headMessage,
    actor,
    branch = 'main',
    latestStable = null,
    tagName = null,
    tagBranches = [],
  } = context

  const isPrereleaseBranch = PRERELEASE_BRANCHES.includes(branch)
  const distTag = CHANNEL_DIST_TAGS[branch] ?? CHANNEL_DIST_TAGS.main

  const publish = (releaseVersion, autoBump, reason) => ({
    shouldPublish: true,
    releaseVersion,
    applyVersion: autoBump,
    distTag,
    // 预发布分支不回写 main：main 的版本号只跟稳定版对齐。
    writeback: autoBump && !isPrereleaseBranch,
    reason,
  })
  const skip = reason => ({
    shouldPublish: false,
    releaseVersion: version,
    applyVersion: false,
    distTag,
    writeback: false,
    reason,
  })

  if (event === 'tag') {
    return planTagRelease({ version, tagName, tagBranches, isPublished })
  }

  if (event === 'workflow_dispatch') {
    if (isPrereleaseBranch) {
      // 手动触发预发布分支：版本号必须已是本渠道的预发布形式，避免误占 latest。
      assertPrereleaseVersion(version, branch)
    } else {
      assertStableVersion(version)
    }
    return isPublished(version)
      ? skip(`v${version} 已存在于 npm，跳过`)
      : publish(version, false, `按手动触发发布 v${version}`)
  }

  if (headMessage.includes(SKIP_KEYWORD)) {
    return skip(`提交信息包含 ${SKIP_KEYWORD}，跳过自动发版`)
  }
  if (actor === BOT_ACTOR) {
    return skip('由 Actions 机器人推送，跳过自动发版')
  }

  // 本次推送动了版本号：尊重人工选择（minor / major / 指定 patch），不再自动升。
  if (beforeVersion !== null && beforeVersion !== version) {
    if (isPrereleaseBranch) {
      // 预发布分支的版本号会随 main 同步而变（同步过来的仍是稳定版号），
      // 这种变动不是人工指定预发布版本，按最新稳定版重新计算即可。
      // 人工把版本号改成本渠道的预发布形式时，尊重人工选择。
      const manual = parsePrereleaseVersion(version)
      if (manual) {
        if (manual.channel !== branch) {
          throw new Error(
            `package.json 版本 ${version} 是 ${manual.channel} 预发布，与所在分支 ${branch} 不一致；`
            + '不同分支不能产出相同版本号',
          )
        }
        return isPublished(version)
          ? skip(`v${version} 已存在于 npm，跳过`)
          : publish(version, false, `本次推送包含版本号变更，发布 v${version}`)
      }
    } else {
      assertStableVersion(version)
      return isPublished(version)
        ? skip(`v${version} 已存在于 npm，跳过`)
        : publish(version, false, `本次推送包含版本号变更，发布 v${version}`)
    }
  }

  // 拿不到推送前的版本（force push、首次推送）时不做自动升版，避免猜错基线。
  if (beforeVersion === null) {
    if (isPrereleaseBranch) {
      // 新分支的首推没有基线提交：此时算不出「相对上次改了什么」，跳过，
      // 等分支有了后续提交再发第一版预发布。
      return skip('拿不到推送前的基线提交，跳过预发布')
    }
    // 稳定版渠道只发 x.y.z：预发布版本落到 latest 会让所有人装到未稳定的版本。
    assertStableVersion(version)
    return isPublished(version)
      ? skip(`v${version} 已存在于 npm，跳过`)
      : publish(version, false, '无法确定推送前的版本，按当前版本发布')
  }

  if (!isShippableChange(changedFiles)) {
    return skip('本次改动未触及会进入 npm 包的文件，跳过自动升版')
  }

  if (isPrereleaseBranch) {
    return planPrereleaseBump({ version, branch, latestStable, isPublished })
  }

  // 当前版本还没发出去（通常是上一次发布失败）：先补发当前版本，避免直接升 patch 把它跳成空洞。
  if (!isPublished(version)) {
    assertStableVersion(version)
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

/** main（稳定版）上的版本必须是 x.y.z，否则会产出带后缀的 latest。 */
function assertStableVersion(version) {
  if (!parseVersion(version)) {
    throw new Error(
      `package.json 版本 ${version} 不是 x.y.z 形式；稳定版渠道只能发布 x.y.z，请手动改好版本号后再合并到 main`,
    )
  }
}

/** 预发布分支的版本必须是本渠道的预发布形式，且基线版本必须存在。 */
function assertPrereleaseVersion(version, branch) {
  const parsed = parsePrereleaseVersion(version)
  if (!parsed) {
    throw new Error(
      `package.json 版本 ${version} 不是 ${branch} 预发布形式；${branch} 分支只能发布 x.y.z-${branch}.N，请手动改好版本号`,
    )
  }
  if (parsed.channel !== branch) {
    throw new Error(
      `package.json 版本 ${version} 是 ${parsed.channel} 预发布，与所在分支 ${branch} 不一致；`
      + '不同分支不能产出相同版本号',
    )
  }
}

/**
 * 计算预发布版本号：以 npm 上的最新稳定版为基线，取它的下一个 patch 作为预发布基座，
 * 再从 1 开始找第一个未被占用的 `-beta.N` / `-alpha.N`。
 *
 * 这样 beta 与 alpha 天然不会产出相同版本：后缀不同；同一渠道的序号也不会重号。
 */
function planPrereleaseBump({ version, branch, latestStable, isPublished }) {
  const suffix = PRERELEASE_SUFFIX[branch]

  const base = parseVersion(latestStable)
  if (!base) {
    throw new Error(
      `基线版本 ${latestStable} 不是 x.y.z 形式，无法计算 ${branch} 预发布版本；`
      + '请检查 npm 上是否已有稳定版',
    )
  }

  let { major, minor, patch } = base
  // 基线所在 patch 已被稳定版占用时，往上找一个还没被占用的 patch 作为预发布基座。
  for (let step = 0; step < MAX_BUMP_STEPS; step += 1) {
    patch += 1
    const candidateBase = `${major}.${minor}.${patch}`
    if (isPublished(candidateBase)) continue

    for (let seq = 1; seq <= MAX_PRERELEASE_STEPS; seq += 1) {
      const candidate = `${candidateBase}-${suffix}.${seq}`
      if (!isPublished(candidate)) {
        // 版本与分支上的一致时无需改写 package.json（多半是上次发布失败留下的空位）。
        const sameAsBranch = candidate === version
        return {
          shouldPublish: true,
          releaseVersion: candidate,
          applyVersion: !sameAsBranch,
          distTag: CHANNEL_DIST_TAGS[branch],
          writeback: false,
          reason: sameAsBranch
            ? `v${candidate} 尚未发布，先补发当前版本`
            : `自动升 ${branch} 预发布：v${latestStable} → v${candidate}`,
        }
      }
    }
    throw new Error(`v${candidateBase}-${suffix}.1 到 .${MAX_PRERELEASE_STEPS} 都已在 npm 上，自动升版已中止`)
  }

  throw new Error(`连续 ${MAX_BUMP_STEPS} 个 patch 版本都已在 npm 上，自动升版已中止，请检查发布链路`)
}

/** tag 触发：按 tag 里的渠道决定 dist-tag，稳定 tag 只允许出现在 main 上。 */
function planTagRelease({ version, tagName, tagBranches, isPublished }) {
  const parsed = parseReleaseTag(tagName)
  if (!parsed) {
    throw new Error(
      `tag ${tagName} 不是受支持的发布 tag；只支持 vX.Y.Z（稳定）、vX.Y.Z-beta.N、vX.Y.Z-alpha.N`,
    )
  }

  // tag 的渠道由 tag 名本身决定（vX.Y.Z-beta.N 就是 beta 渠道），
  // 但必须确认这个 tag 确实落在对应分支上：beta / alpha 会同步 main 的提交，
  // 只靠「提交属于哪条分支」无法区分来源。
  if (parsed.channel !== 'stable') {
    if (!tagBranches.includes(parsed.channel)) {
      throw new Error(
        `${parsed.channel} tag ${tagName} 不在 ${parsed.channel} 分支上`
        + `（该提交所属分支：${tagBranches.join('、') || '无法确定'}）；`
        + '预发布 tag 必须从自己的分支推送，不同分支不能产出相同版本号',
      )
    }
    if (parsed.version !== version) {
      throw new Error(
        `tag ${tagName} 与 package.json 版本 ${version} 不一致，请先执行 pnpm version 再推 tag`,
      )
    }
    return isPublished(parsed.version)
      ? {
          shouldPublish: false,
          releaseVersion: parsed.version,
          applyVersion: false,
          distTag: CHANNEL_DIST_TAGS[parsed.channel],
          writeback: false,
          reason: `v${parsed.version} 已存在于 npm，跳过`,
        }
      : {
          shouldPublish: true,
          releaseVersion: parsed.version,
          applyVersion: false,
          distTag: CHANNEL_DIST_TAGS[parsed.channel],
          writeback: false,
          reason: `按 tag 发布 v${parsed.version}（${parsed.channel} 渠道）`,
        }
  }

  if (parsed.channel === 'stable') {
    // 稳定 tag 只允许从 main 推：否则会占用 latest dist-tag，
    // 让 npm install 拿到未经 main 验证的版本。
    if (!tagBranches.includes('main')) {
      throw new Error(
        `稳定 tag ${tagName} 不在 main 上（该提交所属分支：${tagBranches.join('、') || '无法确定'}）；`
        + '稳定版只能从 main 发布，避免占用 latest dist-tag',
      )
    }
    if (parsed.version !== version) {
      throw new Error(
        `tag ${tagName} 与 package.json 版本 ${version} 不一致，请先执行 pnpm version 再推 tag`,
      )
    }
    return isPublished(parsed.version)
      ? {
          shouldPublish: false,
          releaseVersion: parsed.version,
          applyVersion: false,
          distTag: CHANNEL_DIST_TAGS.main,
          writeback: false,
          reason: `v${parsed.version} 已存在于 npm，跳过`,
        }
      : {
          shouldPublish: true,
          releaseVersion: parsed.version,
          applyVersion: false,
          distTag: CHANNEL_DIST_TAGS.main,
          writeback: false,
          reason: `按 tag 发布 v${parsed.version}`,
        }
  }
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

/** 读取某个包已发布的所有版本；网络异常按「未发布」处理，与原有工作流一致。 */
function npmVersions(name) {
  try {
    const stdout = execFileSync('npm', ['view', name, 'versions', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const parsed = JSON.parse(stdout)
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)]
  } catch {
    return []
  }
}

/**
 * 同一版本会同时发布到所有包，任一个包已存在该版本就说明版本已被占用。
 * 根包最后发布、在 npm 上可见最晚；只查根包会把「上一轮组件包已可见」误判为未占用。
 */
export function createPublishedChecker(names, listVersions = npmVersions) {
  const published = new Set(names.flatMap(name => listVersions(name)))
  return version => published.has(version)
}

/** 根包 + 所有参与发布的组件包。 */
function releasePackageNames(rootName) {
  return [
    ...PUBLISH_ORDER.map(name => JSON.parse(readFileSync(packagePath(name), 'utf8')).name),
    rootName,
  ]
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
      `- dist-tag：${plan.distTag}`,
      `- 自动升版：${plan.applyVersion ? '是' : '否'}`,
      `- 回写版本号到 main：${plan.writeback ? '是' : '否'}`,
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
      branch: process.env.PLAN_BRANCH || 'main',
      latestStable: process.env.PLAN_LATEST_STABLE || null,
      tagName: process.env.PLAN_TAG_NAME || null,
      tagBranches: readLines(process.env.PLAN_TAG_BRANCHES_FILE),
    },
    createPublishedChecker(releasePackageNames(name)),
  )

  writeOutput('should_publish', plan.shouldPublish)
  writeOutput('release_version', plan.releaseVersion)
  writeOutput('apply_version', plan.applyVersion)
  writeOutput('dist_tag', plan.distTag)
  writeOutput('writeback', plan.writeback)
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
