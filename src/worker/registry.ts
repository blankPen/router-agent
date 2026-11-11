import type { AppConfig } from '../config.js'
import type { CommandRunner } from '../infra/process.js'
import type { Logger } from '../infra/logger.js'
import { WorkerRuntimeError, type WorkerRuntime } from './port.js'
import { OrcaRuntime } from './orca/index.js'
import { ClaudeCodeRuntime } from './runtimes/claude-code/index.js'
import { CodexAppRuntime } from './runtimes/codex/index.js'
import { codexAppOptionsOf } from './runtimes/codex/detect.js'
import { HerdrRuntime } from './runtimes/herdr/index.js'
import { AcpRuntime } from './runtimes/acp/index.js'
import { ACP_AGENTS } from './runtimes/acp/agents.js'
import { acpRuntimeConfig, installHintOf, resolveAgentCommand } from './runtimes/acp/detect.js'
import {
  ACP_RUNTIME_ID,
  CLAUDE_CODE_RUNTIME_ID,
  CODEX_APP_RUNTIME_ID,
  HERDR_RUNTIME_ID,
  LEGACY_CLAUDE_CODE_RUNTIME_ID,
  ORCA_RUNTIME_ID,
  normalizeRuntimeId,
} from './runtimes/catalog.js'
import { runtimeOptionString } from './runtimes/options.js'

export interface RuntimeDeps {
  home: string
  workersDir: string
  /** 已绑定 orca 的 runner。 */
  orca: CommandRunner
  /** 已绑定 claude 的 runner。 */
  claude: CommandRunner
  /** 已绑定 git 的 runner。 */
  git: CommandRunner
  /** 已绑定 herdr 的 runner。 */
  herdr: CommandRunner
  claudeProjectsDir?: string
  env?: NodeJS.ProcessEnv
  logger?: Logger
}

/** 按 id 持有运行时；内核只通过它取运行时，不直接 new OrcaRuntime。 */
export class RuntimeRegistry {
  private readonly defaultId: string

  constructor(
    private readonly runtimes: Map<string, WorkerRuntime>,
    defaultId: string,
  ) {
    // 默认值可能来自旧配置（claude-cli），先归一再校验。
    this.defaultId = normalizeRuntimeId(defaultId)
    if (!runtimes.has(this.defaultId)) {
      throw new WorkerRuntimeError('runtime:unknown', `默认 runtime 未注册: ${this.defaultId}`)
    }
  }

  get(id: string): WorkerRuntime {
    const runtime = this.runtimes.get(normalizeRuntimeId(id))
    if (!runtime) throw new WorkerRuntimeError('runtime:unknown', `未知 runtime: ${id}`)
    return runtime
  }

  has(id: string): boolean {
    return this.runtimes.has(normalizeRuntimeId(id))
  }

  ids(): string[] {
    return [...this.runtimes.keys()]
  }

  default(): WorkerRuntime {
    return this.get(this.defaultId)
  }
}

/** 生产环境装配：只注册已实现的运行时；配置了未注册运行时会在启动期失败。 */
export function createRuntimes(config: AppConfig, deps: RuntimeDeps): RuntimeRegistry {
  const runtimes = new Map<string, WorkerRuntime>()
  // 运行时选项走通用的 `runtime.options.<runtimeId>.<key>`；没配就是「跟随工具自己的默认」。
  const orcaAgent = runtimeOptionString(config.runtime.options, ORCA_RUNTIME_ID, 'agent')
  runtimes.set(ORCA_RUNTIME_ID, new OrcaRuntime({
    runner: deps.orca,
    workersDir: deps.workersDir,
    home: deps.home,
    ...(orcaAgent ? { agent: orcaAgent } : {}),
  }))

  // 旧配置可能把选项写在 claude-cli 下，两个键都认。
  const claudeOptions = (config.runtime.options?.[CLAUDE_CODE_RUNTIME_ID]
    ?? config.runtime.options?.[LEGACY_CLAUDE_CODE_RUNTIME_ID]
    ?? {}) as Record<string, unknown>
  runtimes.set(CLAUDE_CODE_RUNTIME_ID, new ClaudeCodeRuntime({
    claude: deps.claude,
    git: deps.git,
    workersDir: deps.workersDir,
    home: deps.home,
    ...(deps.claudeProjectsDir ? { claudeProjectsDir: deps.claudeProjectsDir } : {}),
    // 只允许非安全参数；allowedTools / 跳过权限确认 / sandbox 由 worker.tools 与内置基线决定。
    ...(typeof claudeOptions.model === 'string' ? { model: claudeOptions.model } : {}),
    ...(deps.env ? { env: deps.env } : {}),
  }))

  const codexOptions = codexAppOptionsOf(config)
  // 服务继承的 CODEX_HOME 可能指向别处（例如从别的工具的隔离 HOME 启动服务），
  // 那会让 thread 落在桌面端读不到的目录；只有 runtime.options.codex-app.env 显式配置的才生效。
  const inheritedCodexEnv = { ...(deps.env ?? {}) }
  delete inheritedCodexEnv.CODEX_HOME
  runtimes.set(CODEX_APP_RUNTIME_ID, new CodexAppRuntime({
    command: codexOptions.command,
    model: codexOptions.model,
    modelProvider: codexOptions.modelProvider,
    permissions: codexOptions.permissions,
    approvalPolicy: codexOptions.approvalPolicy,
    network: codexOptions.network,
    args: codexOptions.args,
    workersDir: deps.workersDir,
    home: deps.home,
    git: deps.git,
    env: { ...inheritedCodexEnv, ...codexOptions.env },
    ...(deps.logger ? { logger: deps.logger } : {}),
  }))

  const acpOptions = (config.runtime.options?.[ACP_RUNTIME_ID] ?? {}) as Record<string, unknown>
  const acpCommand = typeof acpOptions.command === 'string' ? acpOptions.command.trim() : ''
  if (acpCommand) {
    const acpArgs = Array.isArray(acpOptions.args)
      ? acpOptions.args.filter((item): item is string => typeof item === 'string')
      : []
    const acpEnv = acpOptions.env && typeof acpOptions.env === 'object'
      ? Object.fromEntries(Object.entries(acpOptions.env as Record<string, unknown>).filter(([, value]) => typeof value === 'string')) as NodeJS.ProcessEnv
      : undefined
    runtimes.set(ACP_RUNTIME_ID, new AcpRuntime({
      id: ACP_RUNTIME_ID,
      command: acpCommand,
      args: acpArgs,
      workersDir: deps.workersDir,
      home: deps.home,
      git: deps.git,
      ...(acpEnv ? { env: { ...(deps.env ?? {}), ...acpEnv } } : deps.env ? { env: deps.env } : {}),
    }))
  }

  // Herdr：与 Orca 同构的「worktree + 终端」运行时，但控制面是 Herdr 自己的 CLI。
  const herdrOptions = (config.runtime.options?.[HERDR_RUNTIME_ID] ?? {}) as Record<string, unknown>
  const herdrAgent = runtimeOptionString(config.runtime.options, HERDR_RUNTIME_ID, 'agent')
  const herdrModel = typeof herdrOptions.model === 'string' ? herdrOptions.model.trim() : ''
  runtimes.set(HERDR_RUNTIME_ID, new HerdrRuntime({
    herdr: deps.herdr,
    git: deps.git,
    workersDir: deps.workersDir,
    home: deps.home,
    ...(herdrAgent ? { agent: herdrAgent } : {}),
    ...(herdrModel ? { model: herdrModel } : {}),
    ...(deps.claudeProjectsDir ? { claudeProjectsDir: deps.claudeProjectsDir } : {}),
  }))

  // 目录里的 ACP Agent 全部注册：是否安装只影响可用性，不影响 runtime id 是否存在。
  // 命令解析只做文件存在性检查，不 spawn 进程；真正探测由 detect.ts 负责。
  const resolveEnv = { ...process.env, ...(deps.env ?? {}) }
  for (const agent of ACP_AGENTS) {
    const resolved = resolveAgentCommand(agent, { home: deps.home, env: resolveEnv, config })
    const runtimeConfig = acpRuntimeConfig(agent, config)
    const hint = installHintOf(agent)
    runtimes.set(agent.runtimeId, new AcpRuntime({
      id: agent.runtimeId,
      ...(resolved.command ? { command: resolved.command } : {}),
      args: runtimeConfig.args,
      env: { ...(deps.env ?? {}), ...runtimeConfig.env },
      workersDir: deps.workersDir,
      home: deps.home,
      git: deps.git,
      ...(resolved.reason ? { unavailableReason: resolved.reason } : {}),
      ...(hint ? { installHint: hint } : {}),
      probeArgs: [...(agent.probeArgs ?? ['--version'])],
    }))
  }

  if (normalizeRuntimeId(config.runtime.default) === ACP_RUNTIME_ID && !runtimes.has(ACP_RUNTIME_ID)) {
    throw new WorkerRuntimeError('runtime:unknown', '默认 runtime 为 acp，但未配置 runtime.options.acp.command')
  }

  return new RuntimeRegistry(runtimes, config.runtime.default)
}
