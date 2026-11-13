/**
 * Claude Code 无人值守启动的前置确认。
 *
 * `claude --bg` 在拉起后台会话之前会检查两件事，任何一件没过就直接退出、不返回会话 id：
 * - 工作目录是否已被信任（`projects[目录].hasTrustDialogAccepted`）；
 * - 是否接受过「跳过权限确认」的免责提示（`bypassPermissionsModeAccepted`）。
 *
 * 这两项平时只能由交互式确认写进 `~/.claude.json`，所以无人值守启动前要先补上：
 * 否则每张工单都会卡在「请手动运行一次 claude」上，Router 只能转人工。
 */
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface ClaudeTrustOptions {
  /** 子进程看到的 HOME；决定 `~/.claude.json` 的位置。 */
  home?: string
  /** 直接指定配置文件路径。 */
  configPath?: string
}

export interface ClaudeTrustResult {
  /** 是否已具备无人值守启动条件。 */
  ready: boolean
  /** 本次补写的字段，空数组表示本来就满足条件。 */
  added: string[]
  /** 补不上时的原因。 */
  reason?: string
  configPath: string
}

/** Claude Code 的全局配置：默认在 `~/.claude.json`。 */
export function claudeConfigPath(home?: string): string {
  return join(home ?? homedir(), '.claude.json')
}

/**
 * Claude Code 用工作目录的真实路径作为信任记录的键（软链目录要按真实路径登记）。
 * 目录不存在时退回绝对路径，交由 Claude Code 自己去判。
 */
export function claudeTrustKey(workdir: string): string {
  try {
    return realpathSync(workdir)
  } catch {
    return resolve(workdir)
  }
}

/**
 * 补齐 `claude --bg` 无人值守启动所需的两项确认。
 *
 * 已经满足条件时不会碰文件；配置文件损坏时也不覆盖，直接报告原因，
 * 避免把用户 Claude Code 的配置写坏。
 */
export function ensureClaudeBackgroundReady(workdir: string, opts: ClaudeTrustOptions = {}): ClaudeTrustResult {
  const configPath = opts.configPath ?? claudeConfigPath(opts.home)
  const key = claudeTrustKey(workdir)

  let config: Record<string, unknown>
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ready: false, added: [], reason: 'Claude 配置不是合法 JSON 对象', configPath }
      }
      config = parsed as Record<string, unknown>
    } catch (error) {
      return {
        ready: false,
        added: [],
        reason: `Claude 配置读取失败: ${error instanceof Error ? error.message : String(error)}`,
        configPath,
      }
    }
  } else {
    config = {}
  }

  const projects = (config.projects && typeof config.projects === 'object' && !Array.isArray(config.projects))
    ? { ...(config.projects as Record<string, unknown>) }
    : {}
  const project = (projects[key] && typeof projects[key] === 'object' && !Array.isArray(projects[key]))
    ? { ...(projects[key] as Record<string, unknown>) }
    : {}

  const added: string[] = []
  if (config.bypassPermissionsModeAccepted !== true) {
    config.bypassPermissionsModeAccepted = true
    added.push('bypassPermissionsModeAccepted')
  }
  if (project.hasTrustDialogAccepted !== true) {
    project.hasTrustDialogAccepted = true
    projects[key] = project
    added.push('workspaceTrust')
  }
  if (added.length === 0) return { ready: true, added, configPath }

  config.projects = projects
  const tmp = `${configPath}.router-agent-${process.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    renameSync(tmp, configPath)
  } catch (error) {
    return {
      ready: false,
      added,
      reason: `Claude 配置写入失败: ${error instanceof Error ? error.message : String(error)}`,
      configPath,
    }
  }
  return { ready: true, added, configPath }
}
