#!/usr/bin/env node
/**
 * 判定一次 `npm publish` 是否成功。
 *
 * 背景：发布流水线不再回查 npm registry（`npm view` 轮询），而是直接依据
 * `npm publish` 命令的退出码与 JSON 输出判断发布是否成功，并把结果传给后续步骤。
 *
 * npm 各版本在 `--json` 下的输出形态：
 *   · npm 10（Node 22 自带）：成功时 stdout 是 tarball 信息对象
 *     `{ "id": "router-agent@0.3.7", "name": "router-agent", "version": "0.3.7", ... }`；
 *     失败时 stdout 是 `{ "error": { "code": "...", "summary": "...", "detail": "..." } }`。
 *   · npm 11：成功时 stdout 外面多包一层包名 `{ "router-agent": { ... } }`；
 *     暂存发布时 tarball 信息里带 `stageId`。
 *
 * 用法：
 *   node scripts/publish-result.mjs --stdout <文件> --stderr <文件> \
 *     --exit-code <码> --name <包名> --version <版本>
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 从 npm 的 JSON 输出里找出发布结果对象（兼容 npm 10 / npm 11 两种外层形态）。 */
function findTarball(payload) {
  if (!payload || typeof payload !== 'object') return null
  if (typeof payload.name === 'string' && typeof payload.version === 'string') {
    return payload
  }
  for (const value of Object.values(payload)) {
    if (value && typeof value === 'object'
      && typeof value.name === 'string' && typeof value.version === 'string') {
      return value
    }
  }
  return null
}

/** 解析 npm 的 JSON 输出；解析不了返回 null。 */
export function parsePublishJson(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * 判定发布结果。
 * @param {{
 *   stdout: string,
 *   stderr: string,
 *   exitCode: number,
 *   expectedName: string,
 *   expectedVersion: string,
 * }} input
 * @returns {{
 *   ok: boolean,
 *   code: string | null,
 *   message: string,
 *   id: string | null,
 *   name: string | null,
 *   version: string | null,
 *   staged: boolean,
 * }}
 */
export function evaluatePublishResult(input) {
  const { stdout, stderr, exitCode, expectedName, expectedVersion } = input

  const fail = (code, message) => ({
    ok: false,
    code,
    message,
    id: null,
    name: null,
    version: null,
    staged: false,
  })

  const payload = parsePublishJson(stdout)

  if (exitCode !== 0) {
    const error = payload && typeof payload === 'object' ? payload.error : null
    if (error && typeof error === 'object') {
      const code = typeof error.code === 'string' ? error.code : 'EPUBLISH'
      const summary = typeof error.summary === 'string' ? error.summary : 'npm publish 失败'
      if (code === 'E_STAGE_REQUIRED') {
        return fail(
          code,
          `npm publish 失败（${code}）：${summary}。`
          + '这通常说明 NPM_TOKEN 只有 stage 权限，'
          + '请改用 Read and write (publish and stage) 的 token，'
          + '或改用 Trusted Publishing。',
        )
      }
      return fail(code, `npm publish 失败（${code}）：${summary}`)
    }
    const detail = (stderr || '').trim().split('\n').slice(-5).join('\n')
    return fail(
      'EPUBLISH',
      `npm publish 退出码 ${exitCode}，未能从输出中解析出 npm 的错误信息。\n${detail}`.trim(),
    )
  }

  if (!payload) {
    return fail('EPUBLISH_OUTPUT', 'npm publish 退出码为 0，但没有返回可解析的 JSON 输出')
  }

  if (typeof payload === 'object' && payload.error) {
    const error = payload.error
    const code = typeof error?.code === 'string' ? error.code : 'EPUBLISH'
    const summary = typeof error?.summary === 'string' ? error.summary : 'npm publish 失败'
    return fail(code, `npm publish 失败（${code}）：${summary}`)
  }

  const tarball = findTarball(payload)
  if (!tarball) {
    return fail('EPUBLISH_OUTPUT', 'npm publish 输出中没有找到包名与版本信息')
  }

  const id = typeof tarball.id === 'string' ? tarball.id : `${tarball.name}@${tarball.version}`
  // npm 11 的暂存发布会在 JSON 里带 stageId，并在 stderr 打印 "has been staged"；
  // 两个信号都认，避免只判到一边。
  const staged =
    (typeof tarball.stageId === 'string' && tarball.stageId !== '')
    || /has been staged|\(staged( with id [^)]*)?\)/i.test(stderr)

  if (staged) {
    return {
      ok: false,
      code: 'EPUBLISH_STAGED',
      message:
        `npm 只把 ${id} 写进了暂存区（staged），并未真正发布到 npm。`
        + '最常见原因是 NPM_TOKEN 只有 stage 权限，请改用 Read and write (publish and stage) 的 token，'
        + '或在 npm 页面 Staged Packages 中批准该暂存版本。',
      id,
      name: tarball.name,
      version: tarball.version,
      staged: true,
    }
  }

  if (tarball.name !== expectedName || tarball.version !== expectedVersion) {
    return fail(
      'EPUBLISH_MISMATCH',
      `npm publish 的结果与预期不符：期望 ${expectedName}@${expectedVersion}，实际 ${tarball.name}@${tarball.version}`,
    )
  }

  return {
    ok: true,
    code: null,
    message: `${id} 发布成功`,
    id,
    name: tarball.name,
    version: tarball.version,
    staged: false,
  }
}

/** 读取参数值。 */
function readArg(argv, flag) {
  const index = argv.indexOf(flag)
  if (index === -1) return ''
  return argv[index + 1] ?? ''
}

/** 读取文本文件；不存在或读不到返回空串。 */
function readText(path) {
  if (!path) return ''
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** 往 GITHUB_OUTPUT 写一行；没有该环境变量时写到 stdout。 */
function writeOutput(key, value) {
  const line = `${key}=${String(value).replace(/[\r\n]+/g, ' ')}\n`
  const outputPath = process.env.GITHUB_OUTPUT
  if (outputPath) {
    appendFileSync(outputPath, line)
  } else {
    process.stdout.write(line)
  }
}

function main() {
  const argv = process.argv.slice(2)
  const exitCode = Number(readArg(argv, '--exit-code'))
  const expectedName = readArg(argv, '--name')
  const expectedVersion = readArg(argv, '--version')
  const stdout = readText(readArg(argv, '--stdout'))
  const stderr = readText(readArg(argv, '--stderr'))

  const result = evaluatePublishResult({
    stdout,
    stderr,
    exitCode: Number.isFinite(exitCode) ? exitCode : 1,
    expectedName,
    expectedVersion,
  })

  writeOutput('published', String(result.ok))
  writeOutput('published_id', result.id ?? '')
  writeOutput('published_name', result.name ?? '')
  writeOutput('published_version', result.version ?? '')

  if (result.ok) {
    console.log(result.message)
    return
  }

  console.error(`::error::${result.message}`)
  process.exitCode = 1
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`[publish-result] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
