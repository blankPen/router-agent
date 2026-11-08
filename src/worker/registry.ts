import type { AppConfig } from '../config.js'
import type { CommandRunner } from '../infra/process.js'
import { WorkerBackendError, type WorkerBackend } from './port.js'
import { OrcaAdapter } from './orca/index.js'
import { ClaudeCliBackend } from './backends/claude-cli/index.js'

export interface BackendDeps {
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

/** 按 id 持有后端；内核只通过它取后端，不直接 new OrcaAdapter。 */
export class BackendRegistry {
  constructor(
    private readonly backends: Map<string, WorkerBackend>,
    private readonly defaultId: string,
  ) {
    if (!backends.has(defaultId)) {
      throw new WorkerBackendError('backend:unknown', `默认 backend 未注册: ${defaultId}`)
    }
  }

  get(id: string): WorkerBackend {
    const backend = this.backends.get(id)
    if (!backend) throw new WorkerBackendError('backend:unknown', `未知 backend: ${id}`)
    return backend
  }

  has(id: string): boolean {
    return this.backends.has(id)
  }

  ids(): string[] {
    return [...this.backends.keys()]
  }

  default(): WorkerBackend {
    return this.get(this.defaultId)
  }
}

/** 生产环境装配：只注册已实现的后端；配置了未注册后端会在启动期失败。 */
export function createBackends(config: AppConfig, deps: BackendDeps): BackendRegistry {
  const backends = new Map<string, WorkerBackend>()
  backends.set('orca', new OrcaAdapter({
    runner: deps.orca,
    workersDir: deps.workersDir,
    spec: deps.spec,
  }))

  const claudeOptions = (config.backend.options?.['claude-cli'] ?? {}) as Record<string, unknown>
  backends.set('claude-cli', new ClaudeCliBackend({
    claude: deps.claude,
    git: deps.git,
    workersDir: deps.workersDir,
    home: deps.home,
    ...(deps.claudeProjectsDir ? { claudeProjectsDir: deps.claudeProjectsDir } : {}),
    ...(typeof claudeOptions.model === 'string' ? { model: claudeOptions.model } : {}),
    ...(typeof claudeOptions.permissionMode === 'string' ? { permissionMode: claudeOptions.permissionMode } : {}),
    ...(typeof claudeOptions.allowedTools === 'string' ? { allowedTools: claudeOptions.allowedTools } : {}),
    ...(deps.env ? { env: deps.env } : {}),
  }))

  return new BackendRegistry(backends, config.backend.default)
}