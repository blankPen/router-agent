import type { AppConfig } from '../config.js'
import type { CommandRunner } from '../infra/process.js'
import { WorkerRuntimeError, type WorkerRuntime } from './port.js'
import { OrcaRuntime } from './orca/index.js'
import { ClaudeCodeRuntime } from './runtimes/claude-code/index.js'
import { AcpRuntime } from './runtimes/acp/index.js'
import {
  ACP_RUNTIME_ID,
  CLAUDE_CODE_RUNTIME_ID,
  LEGACY_CLAUDE_CODE_RUNTIME_ID,
  ORCA_RUNTIME_ID,
  normalizeRuntimeId,
} from './runtimes/catalog.js'

export interface RuntimeDeps {
  home: string
  workersDir: string
  spec: 'prompt' | 'agent'
  /** 已绑定 orca 的 runner。 */
  orca: CommandRunner
  /** 已绑定 claude 的 runner。 */
  claude: CommandRunner
  /** 已绑定 git 的 runner。 */
  git: CommandRunner
  claudeProjectsDir?: string
  env?: NodeJS.ProcessEnv
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
  runtimes.set(ORCA_RUNTIME_ID, new OrcaRuntime({
    runner: deps.orca,
    workersDir: deps.workersDir,
    spec: deps.spec,
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
      command: acpCommand,
      args: acpArgs,
      workersDir: deps.workersDir,
      home: deps.home,
      git: deps.git,
      ...(acpEnv ? { env: { ...(deps.env ?? {}), ...acpEnv } } : deps.env ? { env: deps.env } : {}),
    }))
  }

  if (normalizeRuntimeId(config.runtime.default) === ACP_RUNTIME_ID && !runtimes.has(ACP_RUNTIME_ID)) {
    throw new WorkerRuntimeError('runtime:unknown', '默认 runtime 为 acp，但未配置 runtime.options.acp.command')
  }

  return new RuntimeRegistry(runtimes, config.runtime.default)
}