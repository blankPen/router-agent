/**
 * Codex 启动时的版本更新提示。
 *
 * Codex TUI 启动时若发现有新版本，会弹一个只能用键盘选的浮层
 * （Update now / Skip / Skip until next version）。浮层会挡住输入，
 * 无人值守的工单就停在这里，只能人工去终端里按一下。
 *
 * 消除办法与用户在浮层里选「Skip until next version」完全一致：
 * 把当前最新版本记成已忽略，写进 `$CODEX_HOME/version.json`。
 * Codex 只在「缓存里的 latest_version 比装的版本新，且没有被忽略过」时才弹浮层，
 * 所以写入后这一版就不会再挡路；出新版本时会重新弹（Router 会在下次启动时再消一次）。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface CodexUpdateDismissal {
  /** dismissed=本次写入了忽略记录；already-dismissed=本来就忽略过；no-cache=没有缓存文件；failed=读写出错。 */
  status: 'dismissed' | 'already-dismissed' | 'no-cache' | 'failed'
  /** 版本缓存文件路径。 */
  path: string
  /** 缓存里记录的最新版本。 */
  latestVersion?: string
  /** 失败原因。 */
  reason?: string
}

/** Codex 的家目录：$CODEX_HOME，缺省 ~/.codex。 */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME?.trim()
  if (configured) return configured
  return join(env.HOME?.trim() || homedir(), '.codex')
}

/** Codex 的版本缓存：<codex home>/version.json。 */
export function codexVersionCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(codexHome(env), 'version.json')
}

/**
 * 把当前最新版本记成已忽略，避免 Codex 启动时弹更新浮层挡住输入。
 *
 * 没有缓存文件时不创建：Codex 没有缓存就不会在这次启动弹浮层，
 * 无从得知最新版本，硬造一个文件只会写入猜测值。
 */
export function dismissCodexUpdatePrompt(env: NodeJS.ProcessEnv = process.env): CodexUpdateDismissal {
  const path = codexVersionCachePath(env)
  if (!existsSync(path)) return { status: 'no-cache', path }

  let cache: Record<string, unknown>
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 'failed', path, reason: 'Codex 版本缓存不是合法 JSON 对象' }
    }
    cache = parsed as Record<string, unknown>
  } catch (error) {
    return {
      status: 'failed',
      path,
      reason: `Codex 版本缓存读取失败: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const latest = typeof cache.latest_version === 'string' ? cache.latest_version.trim() : ''
  if (!latest) return { status: 'no-cache', path }
  if (cache.dismissed_version === latest) return { status: 'already-dismissed', path, latestVersion: latest }

  cache.dismissed_version = latest
  const tmp = `${path}.router-agent-${process.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(cache)}\n`, 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    return {
      status: 'failed',
      path,
      latestVersion: latest,
      reason: `Codex 版本缓存写入失败: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return { status: 'dismissed', path, latestVersion: latest }
}
