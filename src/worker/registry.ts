import type { AppConfig } from '../config.js'
import type { CommandRunner } from '../infra/process.js'
import { WorkerRuntimeError, type WorkerRuntime } from './port.js'
import { OrcaRuntime } from './orca/index.js'
import { ClaudeCliRuntime } from './runtimes/claude-cli/index.js'
import { AcpRuntime } from './runtimes/acp/index.js'

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
  constructor(
    private readonly runtimes: Map<string, WorkerRuntime>,
    private readonly defaultId: string,
  ) {
    if (!runtimes.has(defaultId)) {
      throw new WorkerRuntimeError('runtime:unknown', `默认 runtime 未注册: ${defaultId}`)
    }
  }

  get(id: string): WorkerRuntime {
    const runtime = this.runtimes.get(id)
    if (!runtime) throw new WorkerRuntimeError('runtime:unknown', `未知 runtime: ${id}`)
    return runtime
  }

  has(id: string): boolean {
    return this.runtimes.has(id)
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
  runtimes.set('orca', new OrcaRuntime({
    runner: deps.orca,
    workersDir: deps.workersDir,
    spec: deps.spec,
  }))

  const claudeOptions = (config.runtime.options?.['claude-cli'] ?? {}) as Record<string, unknown>
  runtimes.set('claude-cli', new ClaudeCliRuntime({
    claude: deps.claude,
    git: deps.git,
    workersDir: deps.workersDir,
    home: deps.home,
    ...(deps.claudeProjectsDir ? { claudeProjectsDir: deps.claudeProjectsDir } : {}),
    // 只允许非安全参数；allowedTools / permissionMode / sandbox 由 worker.tools 与内置基线决定。
    ...(typeof claudeOptions.model === 'string' ? { model: claudeOptions.model } : {}),
    ...(deps.env ? { env: deps.env } : {}),
  }))

  const acpOptions = (config.runtime.options?.['acp'] ?? {}) as Record<string, unknown>
  const acpCommand = typeof acpOptions.command === 'string' ? acpOptions.command.trim() : ''
  if (acpCommand) {
    const acpArgs = Array.isArray(acpOptions.args)
      ? acpOptions.args.filter((item): item is string => typeof item === 'string')
      : []
    const acpEnv = acpOptions.env && typeof acpOptions.env === 'object'
      ? Object.fromEntries(Object.entries(acpOptions.env as Record<string, unknown>).filter(([, value]) => typeof value === 'string')) as NodeJS.ProcessEnv
      : undefined
    runtimes.set('acp', new AcpRuntime({
      command: acpCommand,
      args: acpArgs,
      workersDir: deps.workersDir,
      home: deps.home,
      git: deps.git,
      ...(acpEnv ? { env: { ...(deps.env ?? {}), ...acpEnv } } : deps.env ? { env: deps.env } : {}),
    }))
  }

  if (config.runtime.default === 'acp' && !runtimes.has('acp')) {
    throw new WorkerRuntimeError('runtime:unknown', '默认 runtime 为 acp，但未配置 runtime.options.acp.command')
  }

  return new RuntimeRegistry(runtimes, config.runtime.default)
}