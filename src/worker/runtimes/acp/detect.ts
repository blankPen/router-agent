import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type { AppConfig } from '../../../config.js'
import { realRunner, type CommandRunner } from '../../../infra/process.js'
import { acpAgentOf, ACP_AGENTS, type AcpAgentMeta } from './agents.js'
import { AcpConnection, AcpProtocolError } from './protocol.js'

export type RuntimeStatus = 'ready' | 'not-installed' | 'incompatible' | 'needs-auth' | 'unverified'

export interface RuntimeRequirement {
  label: string
  ok: boolean
  version?: string
  reason?: string
}

/** 底层 CLI 的安装状态；Web 用它决定「安装 CLI」按钮。 */
export interface RuntimeCliInfo {
  command: string
  label: string
  installed: boolean
  version?: string
  installUrl?: string
}

/** ACP 适配器（npm 包）的安装状态；Web 用它决定「安装 ACP 扩展」按钮。 */
export interface RuntimeExtensionInfo {
  packageName: string
  installed: boolean
  installable: boolean
  installUrl?: string
}

export interface RuntimeChoice {
  id: string
  label: string
  hint: string
  status: RuntimeStatus
  version?: string
  command?: string
  source?: 'config' | 'managed' | 'path' | 'app' | 'env'
  reason?: string
  installable: boolean
  packageName?: string
  installHint?: string
  loginHint?: string
  loadSession?: boolean
  verifyRequired?: boolean
  requires?: RuntimeRequirement[]
  cli?: RuntimeCliInfo
  extension?: RuntimeExtensionInfo
}

export interface RuntimeDetection {
  detectedAt: string
  choices: RuntimeChoice[]
}

export interface ResolvedCommand {
  command?: string
  source?: 'config' | 'managed' | 'path' | 'app' | 'env'
  reason?: string
}

export interface DetectOptions {
  home: string
  env: NodeJS.ProcessEnv
  config: AppConfig
  /** 测试注入：按命令名返回 runner。 */
  runner?: (bin: string) => CommandRunner
  /** 单项版本探测超时，默认 1200ms。 */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 2_500
const REQUIRE_TIMEOUT_MS = 1_500

/** 运行时目录根：~/.router-agent/runtimes */
export function acpRuntimesRoot(home: string): string {
  return join(home, 'runtimes')
}

/** 某个 Agent 的 managed 安装目录：~/.router-agent/runtimes/<agentId> */
export function managedAgentDir(home: string, agentId: string): string {
  return join(acpRuntimesRoot(home), agentId)
}

/** 在 PATH 里解析命令；支持 Windows 的 PATHEXT。返回绝对路径。 */
export function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = command.trim()
  if (!value) return undefined
  if (isAbsolute(value) || value.includes('/') || value.includes('\\')) {
    return existsSync(value) ? value : undefined
  }
  const pathValue = env.PATH ?? env.Path ?? ''
  const extensions = process.platform === 'win32'
    ? ['', '.cmd', '.exe', '.bat']
    : ['']
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const ext of extensions) {
      const candidate = join(dir, `${value}${ext}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function managedBin(agent: AcpAgentMeta, home: string): string | undefined {
  const dir = join(managedAgentDir(home, agent.id), 'node_modules', '.bin')
  const names = process.platform === 'win32'
    ? [`${agent.command}.cmd`, `${agent.command}.exe`, agent.command]
    : [agent.command]
  for (const name of names) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function optionRecordOf(config: AppConfig, runtimeId: string): Record<string, unknown> {
  const value = config.runtime.options?.[runtimeId]
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** 读取某个 ACP 运行时的 args/env 覆盖。registry 与探测共用。 */
export function acpRuntimeConfig(agent: AcpAgentMeta, config: AppConfig): { args: string[]; env: NodeJS.ProcessEnv } {
  const options = optionRecordOf(config, agent.runtimeId)
  const args = Array.isArray(options.args)
    ? options.args.filter((item): item is string => typeof item === 'string')
    : [...agent.args]
  const env: NodeJS.ProcessEnv = { ...(agent.env ?? {}) }
  if (options.env && typeof options.env === 'object' && !Array.isArray(options.env)) {
    for (const [key, value] of Object.entries(options.env as Record<string, unknown>)) {
      if (typeof value === 'string') env[key] = value
    }
  }
  return { args, env }
}

export function installHintOf(agent: AcpAgentMeta): string | undefined {
  return agent.package ? `ra runtime install ${agent.runtimeId}` : agent.installHint
}

/**
 * 同步解析 Agent 命令，不 spawn 任何进程。
 *
 * 优先级：runtime.options.<id>.command → ~/.router-agent/runtimes/<agent>/node_modules/.bin
 * → PATH。找不到时返回 reason，registry 会把它变成 start() 的 runtime:unavailable。
 */
export function resolveAgentCommand(agent: AcpAgentMeta, opts: {
  home: string
  env: NodeJS.ProcessEnv
  config: AppConfig
}): ResolvedCommand {
  const options = optionRecordOf(opts.config, agent.runtimeId)
  const override = typeof options.command === 'string' ? options.command.trim() : ''
  if (override) {
    const resolved = resolveExecutable(override, opts.env)
    return resolved
      ? { command: resolved, source: 'config' }
      : { source: 'config', reason: `runtime.options.${agent.runtimeId}.command 指向的文件不存在：${override}` }
  }
  const managed = managedBin(agent, opts.home)
  if (managed) return { command: managed, source: 'managed' }
  const onPath = resolveExecutable(agent.command, opts.env)
  if (onPath) return { command: onPath, source: 'path' }
  return { reason: `未找到 ${agent.command}，也没有 managed 安装` }
}

export function parseVersion(text: string): string | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined
}

function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function tail(text: string, max = 300): string {
  const value = text.trim().replace(/\s+/g, ' ')
  return value.length <= max ? value : `…${value.slice(-max)}`
}

interface ProbeResult {
  code: number
  stdout: string
  stderr: string
}

async function probe(
  runner: (bin: string) => CommandRunner,
  bin: string,
  args: readonly string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ProbeResult> {
  try {
    return await runner(bin).run([...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      timeoutMs: opts.timeoutMs,
    })
  } catch (error) {
    return { code: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
}

async function detectOne(agent: AcpAgentMeta, opts: DetectOptions): Promise<RuntimeChoice> {
  const runner = opts.runner ?? realRunner
  const base: RuntimeChoice = {
    id: agent.runtimeId,
    label: agent.label,
    hint: agent.hint,
    status: 'not-installed',
    installable: Boolean(agent.package),
    ...(agent.package ? { packageName: agent.package.name } : {}),
    ...(installHintOf(agent) ? { installHint: installHintOf(agent) } : {}),
    ...(agent.login ? { loginHint: agent.login.hint } : {}),
    ...(agent.loadSession !== undefined ? { loadSession: agent.loadSession } : {}),
    ...(agent.verifyRequired ? { verifyRequired: true } : {}),
  }
  const resolved = resolveAgentCommand(agent, { home: opts.home, env: opts.env, config: opts.config })

  // CLI 与 ACP 扩展分开探测：例如 claude 已安装但 claude-agent-acp 还没装，
  // 卡片应该只显示「安装 ACP 扩展」，而不是笼统的「未安装」。
  const cliCommand = agent.cli?.command ?? agent.command
  const cliBin = cliCommand === agent.command && resolved.command
    ? resolved.command
    : resolveExecutable(cliCommand, opts.env)
  let cliVersion: string | undefined
  if (cliBin && cliCommand !== agent.command) {
    const cliProbe = await probe(runner, cliBin, ['--version'], {
      cwd: opts.home,
      env: opts.env,
      timeoutMs: REQUIRE_TIMEOUT_MS,
    })
    if (cliProbe.code === 0) cliVersion = parseVersion(cliProbe.stdout) ?? parseVersion(cliProbe.stderr)
  }
  const installUrl = agent.cli?.installUrl ?? agent.installUrl
  const cli: RuntimeCliInfo = {
    command: cliCommand,
    label: agent.cli?.label ?? agent.label,
    installed: Boolean(cliBin),
    ...(cliVersion ? { version: cliVersion } : {}),
    ...(installUrl ? { installUrl } : {}),
  }
  base.cli = cli
  if (agent.package) {
    base.extension = {
      packageName: agent.package.name,
      installed: Boolean(resolved.command),
      installable: true,
      ...(agent.packageUrl ? { installUrl: agent.packageUrl } : {}),
    }
  }

  if (!resolved.command) {
    return { ...base, source: resolved.source, reason: resolved.reason }
  }
  const command = resolved.command
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const probeArgs = agent.probeArgs ?? ['--version']
  const versionResult = await probe(runner, command, probeArgs, { cwd: opts.home, env: opts.env, timeoutMs })
  if (versionResult.code !== 0) {
    return {
      ...base,
      status: 'incompatible',
      command,
      source: resolved.source,
      reason: `版本探测失败（${probeArgs.join(' ')}）：${tail(versionResult.stderr || versionResult.stdout)}`,
    }
  }
  const version = parseVersion(versionResult.stdout) ?? parseVersion(versionResult.stderr)
  if (version && cli.command === agent.command) cli.version = version

  const requirements: RuntimeRequirement[] = []
  let failure: string | undefined
  for (const requirement of agent.requires ?? []) {
    const bin = resolveExecutable(requirement.command, opts.env)
    if (!bin) {
      const reason = `未找到 ${requirement.label}（${requirement.command}）`
      requirements.push({ label: requirement.label, ok: false, reason })
      failure ??= `${reason}；${requirement.hint}`
      continue
    }
    const versionProbe = await probe(runner, bin, ['--version'], { cwd: opts.home, env: opts.env, timeoutMs: REQUIRE_TIMEOUT_MS })
    const requiredVersion = versionProbe.code === 0 ? parseVersion(versionProbe.stdout || versionProbe.stderr) : undefined
    if (requirement.minVersion && requiredVersion && compareVersion(requiredVersion, requirement.minVersion) < 0) {
      const reason = `${requirement.label} ${requiredVersion} 低于要求 ${requirement.minVersion}`
      requirements.push({ label: requirement.label, ok: false, version: requiredVersion, reason })
      failure ??= `${reason}；${requirement.hint}`
      continue
    }
    if (requirement.capabilityArgs) {
      const capability = await probe(runner, bin, requirement.capabilityArgs, { cwd: opts.home, env: opts.env, timeoutMs: REQUIRE_TIMEOUT_MS })
      if (capability.code !== 0) {
        const reason = `${requirement.label} 缺少 ${requirement.capabilityArgs.join(' ')} 能力（可能是版本过旧）`
        requirements.push({ label: requirement.label, ok: false, version: requiredVersion, reason })
        failure ??= `${reason}；${requirement.hint}`
        continue
      }
    }
    requirements.push({ label: requirement.label, ok: true, ...(requiredVersion ? { version: requiredVersion } : {}) })
  }

  if (failure) {
    return {
      ...base,
      status: 'incompatible',
      command,
      source: resolved.source,
      ...(version ? { version } : {}),
      reason: failure,
      ...(requirements.length > 0 ? { requires: requirements } : {}),
    }
  }

  if (agent.login?.check) {
    const login = await probe(runner, resolveExecutable(agent.login.check.command, opts.env) ?? agent.login.check.command, agent.login.check.args, {
      cwd: opts.home,
      env: opts.env,
      timeoutMs: REQUIRE_TIMEOUT_MS,
    })
    if (login.code !== 0) {
      return {
        ...base,
        status: 'needs-auth',
        command,
        source: resolved.source,
        ...(version ? { version } : {}),
        reason: agent.login.hint,
        ...(requirements.length > 0 ? { requires: requirements } : {}),
      }
    }
  }

  if (agent.verifyRequired) {
    return {
      ...base,
      status: 'unverified',
      command,
      source: resolved.source,
      ...(version ? { version } : {}),
      reason: '版本探测通过，建议运行 ra runtime check 做完整 ACP 握手',
      ...(requirements.length > 0 ? { requires: requirements } : {}),
    }
  }

  return {
    ...base,
    status: 'ready',
    command,
    source: resolved.source,
    ...(version ? { version } : {}),
    ...(requirements.length > 0 ? { requires: requirements } : {}),
  }
}

/** 并行探测全部 ACP Agent；单个失败不抛，只体现在 status/reason。 */
export async function detectAcpAgents(opts: DetectOptions): Promise<RuntimeDetection> {
  const choices = await Promise.all(ACP_AGENTS.map(agent => detectOne(agent, opts)))
  return { detectedAt: new Date().toISOString(), choices }
}

/** 只探测一个 Agent；未知 id 返回 null。 */
export async function detectAcpAgent(idOrRuntimeId: string, opts: DetectOptions): Promise<RuntimeChoice | null> {
  const agent = acpAgentOf(idOrRuntimeId)
  return agent ? detectOne(agent, opts) : null
}

function detectCachePath(home: string): string {
  return join(acpRuntimesRoot(home), 'detect.json')
}

export function readDetectionSnapshot(home: string): RuntimeDetection | null {
  try {
    const parsed = JSON.parse(readFileSync(detectCachePath(home), 'utf8')) as RuntimeDetection
    return Array.isArray(parsed?.choices) ? parsed : null
  } catch {
    return null
  }
}

export function writeDetectionSnapshot(home: string, snapshot: RuntimeDetection): void {
  const path = detectCachePath(home)
  mkdirSync(acpRuntimesRoot(home), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

export interface AcpCheckResult {
  ok: boolean
  status: RuntimeStatus
  detail: string
  protocolVersion?: number
  agentInfo?: { name?: string; version?: string }
  loadSession?: boolean
}

/**
 * L2 完整握手：initialize + session/new（临时 cwd），随后关闭。
 * 只在 `ra runtime check` / Web「检查」时调用。
 */
export async function checkAcpAgent(idOrRuntimeId: string, opts: {
  home: string
  env: NodeJS.ProcessEnv
  config: AppConfig
  timeoutMs?: number
  runner?: (bin: string) => CommandRunner
}): Promise<AcpCheckResult> {
  const agent = acpAgentOf(idOrRuntimeId)
  if (!agent) return { ok: false, status: 'not-installed', detail: `未知 ACP Agent: ${idOrRuntimeId}` }
  const resolved = resolveAgentCommand(agent, { home: opts.home, env: opts.env, config: opts.config })
  if (!resolved.command) {
    return { ok: false, status: 'not-installed', detail: resolved.reason ?? '未找到可执行文件' }
  }
  const { args, env } = acpRuntimeConfig(agent, opts.config)
  const timeoutMs = opts.timeoutMs ?? 10_000
  const cwd = mkdtempSync(join(tmpdir(), 'ra-acp-check-'))
  const connection = new AcpConnection({
    command: resolved.command,
    args,
    cwd,
    env: { ...process.env, ...opts.env, ...env },
    onNotification: () => {},
    onRequest: async (method: string) => {
      if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } }
      throw new AcpProtocolError(-32601, `ra runtime check 不处理该请求: ${method}`)
    },
    onExit: () => {},
  })
  let protocolVersion: number | undefined
  let agentInfo: { name?: string; version?: string } | undefined
  let loadSession: boolean | undefined
  try {
    const init = await connection.request<{
      protocolVersion?: number
      agentCapabilities?: { loadSession?: boolean }
      agentInfo?: { name?: string; version?: string }
    }>('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'router-agent', title: 'Router Agent', version: '0.1.0' },
    }, timeoutMs)
    protocolVersion = init?.protocolVersion
    agentInfo = init?.agentInfo
    loadSession = init?.agentCapabilities?.loadSession
    if (Number(protocolVersion) !== 1) {
      return {
        ok: false,
        status: 'incompatible',
        detail: `协议版本不兼容: ${protocolVersion ?? 'unknown'}`,
        ...(protocolVersion !== undefined ? { protocolVersion } : {}),
        ...(agentInfo ? { agentInfo } : {}),
        ...(loadSession !== undefined ? { loadSession } : {}),
      }
    }
    await connection.request('session/new', { cwd, mcpServers: [] }, timeoutMs)
    return {
      ok: true,
      status: 'ready',
      detail: `initialize + session/new 成功（协议 v1${loadSession ? '，支持 session/load' : ''}）`,
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      ...(agentInfo ? { agentInfo } : {}),
      ...(loadSession !== undefined ? { loadSession } : {}),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      status: 'incompatible',
      detail,
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      ...(agentInfo ? { agentInfo } : {}),
      ...(loadSession !== undefined ? { loadSession } : {}),
    }
  } finally {
    await connection.close().catch(() => {})
    rmSync(cwd, { recursive: true, force: true })
  }
}