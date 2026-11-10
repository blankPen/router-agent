import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { AppConfig } from '../../../config.js'
import { realRunner, type CommandRunner } from '../../../infra/process.js'
import { parseVersion, resolveExecutable } from '../acp/detect.js'

/** Codex App / CLI 的官方下载入口；找不到二进制时展示。 */
export const CODEX_INSTALL_URL = 'https://chatgpt.com/codex'
export const CODEX_INSTALL_HINT = '安装 Codex App（macOS/Windows）或 Codex CLI；ra 会优先使用 Codex App 内置的 Codex'

export type CodexBinarySource = 'config' | 'env' | 'app' | 'path' | 'missing'

export interface CodexAppOptions {
  /** 显式指定 codex 可执行文件；优先级最高。 */
  command?: string
  /** 传给 Codex 的模型；缺省用 Codex 自己的配置。 */
  model?: string
  /** 传给 Codex 的 model provider；缺省用 Codex 自己的配置。 */
  modelProvider?: string
  /**
   * full：danger-full-access（默认，按工单要求完全不审批）；
   * workspace：workspace-write + 可写根，日常改代码。
   */
  permissions: 'workspace' | 'full'
  /** 默认 never，不产生审批请求；改成 on-request/untrusted 时才走审批处理器。 */
  approvalPolicy: 'never' | 'on-request' | 'untrusted'
  /** workspace 模式下是否允许命令联网；full 模式天然允许。 */
  network: boolean
  /** 追加到 `codex` 与 `app-server` 之间的参数（高级选项）。 */
  args: string[]
  /** 传给 codex 子进程的额外环境变量；用于显式指定 CODEX_HOME 等。 */
  env: NodeJS.ProcessEnv
}

function optionRecordOf(config: AppConfig | undefined): Record<string, unknown> {
  const value = config?.runtime.options?.['codex-app']
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** 读取 `runtime.options.codex-app`；未配置时按工单要求默认 full + never。 */
export function codexAppOptionsOf(config: AppConfig | undefined): CodexAppOptions {
  const options = optionRecordOf(config)
  const permissions = options.permissions === 'workspace' ? 'workspace' : 'full'
  const approval = options.approvalPolicy
  const approvalPolicy = approval === 'on-request' || approval === 'untrusted' ? approval : 'never'
  const args = Array.isArray(options.args)
    ? options.args.filter((item): item is string => typeof item === 'string')
    : []
  const env = options.env && typeof options.env === 'object' && !Array.isArray(options.env)
    ? Object.fromEntries(
      Object.entries(options.env as Record<string, unknown>).filter(([, value]) => typeof value === 'string'),
    ) as NodeJS.ProcessEnv
    : {}
  return {
    ...(typeof options.command === 'string' && options.command.trim() ? { command: options.command.trim() } : {}),
    ...(typeof options.model === 'string' && options.model.trim() ? { model: options.model.trim() } : {}),
    ...(typeof options.modelProvider === 'string' && options.modelProvider.trim() ? { modelProvider: options.modelProvider.trim() } : {}),
    permissions,
    approvalPolicy,
    network: options.network !== false,
    args,
    env,
  }
}

/** macOS 桌面 App 内的 Codex CLI 候选路径；版本/布局变化时按存在性逐个探测。 */
export function codexAppCandidates(home: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'darwin') return []
  const roots = ['/Applications', join(home, 'Applications')]
  const relative = [
    join('ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'),
    join('ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'),
    join('ChatGPT.app', 'Contents', 'Resources', 'codex'),
    join('Codex.app', 'Contents', 'Resources', 'codex'),
  ]
  return roots.flatMap(root => relative.map(path => join(root, path)))
}

export interface CodexBinaryCandidate {
  command: string
  source: Exclude<CodexBinarySource, 'missing'>
}

export interface CodexBinaryResolution {
  command?: string
  source: CodexBinarySource
  candidates: CodexBinaryCandidate[]
  reason?: string
  installHint: string
  installUrl: string
}

/**
 * 二进制发现顺序（按工单要求）：
 *   显式配置 > 环境变量 > Codex App bundle > PATH > 缺失。
 * 只做文件存在性判断，真正兼容性由 detectCodexBinary 探测。
 */
export function resolveCodexBinary(opts: {
  home: string
  env?: NodeJS.ProcessEnv
  config?: AppConfig
  /** 直接指定命令；优先于 config 里的 runtime.options.codex-app.command。 */
  command?: string
  /** 直接指定运行时选项；测试 / registry 已解析过配置时使用。 */
  options?: CodexAppOptions
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
}): CodexBinaryResolution {
  const env = opts.env ?? process.env
  const exists = opts.exists ?? existsSync
  const options = opts.options ?? codexAppOptionsOf(opts.config)
  const candidates: CodexBinaryCandidate[] = []
  const push = (command: string | undefined, source: CodexBinaryCandidate['source']): void => {
    const value = command?.trim()
    if (value && !candidates.some(item => item.command === value)) candidates.push({ command: value, source })
  }

  push(opts.command, 'config')
  push(options.command, 'config')
  push(env.RA_CODEX_BIN, 'env')
  push(env.CODEX_BIN, 'env')
  push(env.CODEX_CLI_PATH, 'env')
  for (const path of codexAppCandidates(opts.home, opts.platform ?? process.platform)) push(path, 'app')
  push(resolveExecutable('codex', env), 'path')

  const existing = candidates.find(item => exists(item.command))
  if (existing) return { ...existing, candidates, installHint: CODEX_INSTALL_HINT, installUrl: CODEX_INSTALL_URL }

  // 显式配置/环境变量指向了不存在的文件：保留它，让 doctor 明确报错，而不是静默换一个版本。
  const explicit = candidates.find(item => item.source === 'config' || item.source === 'env')
  if (explicit) {
    return {
      command: explicit.command,
      source: explicit.source,
      candidates,
      reason: `指定的 Codex 可执行文件不存在：${explicit.command}`,
      installHint: CODEX_INSTALL_HINT,
      installUrl: CODEX_INSTALL_URL,
    }
  }

  return {
    source: 'missing',
    candidates,
    reason: '未找到 Codex App 内置的 Codex CLI，PATH 中也没有 codex',
    installHint: CODEX_INSTALL_HINT,
    installUrl: CODEX_INSTALL_URL,
  }
}

export interface CodexBinaryDetection extends CodexBinaryResolution {
  version?: string
  /** `--version` 与 `app-server --help` 都通过。 */
  compatible: boolean
}

interface ProbeResult {
  ok: boolean
  version?: string
  appServer: boolean
  reason?: string
}

async function probeCandidate(
  command: string,
  runner: (bin: string) => CommandRunner,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<ProbeResult> {
  try {
    const versionResult = await runner(command).run(['--version'], { cwd, env, timeoutMs: 5_000 })
    const version = parseVersion(versionResult.stdout) ?? parseVersion(versionResult.stderr)
    if (versionResult.code !== 0) {
      return {
        ok: false,
        ...(version ? { version } : {}),
        appServer: false,
        reason: `codex --version 退出码 ${versionResult.code}${versionResult.stderr ? `：${versionResult.stderr.trim().slice(0, 160)}` : ''}`,
      }
    }
    const appServerResult = await runner(command).run(['app-server', '--help'], { cwd, env, timeoutMs: 5_000 })
    if (appServerResult.code !== 0) {
      return {
        ok: false,
        ...(version ? { version } : {}),
        appServer: false,
        reason: '该 Codex 版本不包含 app-server 子命令，请升级 Codex 或 Codex App',
      }
    }
    return { ok: true, ...(version ? { version } : {}), appServer: true }
  } catch (error) {
    return {
      ok: false,
      appServer: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 按优先级逐个探测，返回第一个能跑 `codex app-server` 的版本。 */
export async function detectCodexBinary(opts: {
  home: string
  env?: NodeJS.ProcessEnv
  config?: AppConfig
  command?: string
  options?: CodexAppOptions
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
  runner?: (bin: string) => CommandRunner
}): Promise<CodexBinaryDetection> {
  const env = opts.env ?? process.env
  const runner = opts.runner ?? realRunner
  const resolution = resolveCodexBinary(opts)
  if (!resolution.command) return { ...resolution, compatible: false }

  // 同一个候选只探测一次；config/env 指向的缺失文件会探测失败，继续尝试后续候选。
  const candidates: CodexBinaryCandidate[] = [...resolution.candidates]
  if (!candidates.some(item => item.command === resolution.command)) {
    candidates.unshift({ command: resolution.command, source: resolution.source as CodexBinaryCandidate['source'] })
  }
  const exists = opts.exists ?? existsSync
  let failure: { candidate: CodexBinaryCandidate; probe: ProbeResult } | undefined
  for (const candidate of candidates) {
    if (!exists(candidate.command)) continue
    const probe = await probeCandidate(candidate.command, runner, env, opts.home)
    if (probe.ok) {
      return {
        command: candidate.command,
        source: candidate.source,
        candidates,
        version: probe.version,
        compatible: true,
        installHint: CODEX_INSTALL_HINT,
        installUrl: CODEX_INSTALL_URL,
      }
    }
    failure ??= { candidate, probe }
  }

  if (failure) {
    return {
      command: failure.candidate.command,
      source: failure.candidate.source,
      candidates,
      ...(failure.probe.version ? { version: failure.probe.version } : {}),
      compatible: false,
      reason: failure.probe.reason ?? 'Codex 版本不兼容',
      installHint: CODEX_INSTALL_HINT,
      installUrl: CODEX_INSTALL_URL,
    }
  }
  return { ...resolution, compatible: false }
}

/** L2 探测：真正拉起 app-server 做一次 initialize 握手；用于 `ra runtime check`。 */
export async function probeCodexHandshake(opts: {
  command: string
  env?: NodeJS.ProcessEnv
  cwd: string
  timeoutMs?: number
}): Promise<{ ok: boolean; userAgent?: string; reason?: string }> {
  const timeoutMs = opts.timeoutMs ?? 5_000
  return new Promise(resolve => {
    let settled = false
    let buffer = ''
    const child = spawn(opts.command, ['app-server', '--stdio'], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const finish = (result: { ok: boolean; userAgent?: string; reason?: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.stdin.end() } catch { /* 进程可能已退出 */ }
      try { child.kill('SIGTERM') } catch { /* 已退出 */ }
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, reason: `initialize 握手超时（${timeoutMs}ms）` }), timeoutMs)
    child.on('error', error => finish({ ok: false, reason: error.message }))
    child.on('close', code => {
      if (!settled) finish({ ok: false, reason: `app-server 提前退出（code=${code ?? 'null'}）` })
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) return
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        try {
          const message = JSON.parse(line) as { id?: number; result?: { userAgent?: string }; error?: { message?: string } }
          if (message.id !== 1) continue
          if (message.error) finish({ ok: false, reason: message.error.message ?? 'initialize 失败' })
          else finish({ ok: true, ...(message.result?.userAgent ? { userAgent: message.result.userAgent } : {}) })
        } catch {
          // 非 JSON 输出忽略。
        }
      }
    })
    try {
      child.stdin.write(`${JSON.stringify({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'router-agent', title: 'router-agent', version: '0.0.0' } },
      })}\n`)
    } catch (error) {
      finish({ ok: false, reason: error instanceof Error ? error.message : String(error) })
    }
  })
}