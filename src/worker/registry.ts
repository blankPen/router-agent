import type { AppConfig } from '../config.js'
import type { CommandRunner } from '../infra/process.js'
import { WorkerBackendError, type WorkerBackend } from './port.js'
import { OrcaAdapter } from './orca/index.js'
import { ClaudeCodeBackend } from './backends/claude-code/index.js'
import { CLAUDE_CODE_BACKEND_ID, LEGACY_CLAUDE_CODE_BACKEND_ID, ORCA_BACKEND_ID, normalizeBackendId } from './backends/catalog.js'

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
  private readonly defaultId: string

  constructor(
    private readonly backends: Map<string, WorkerBackend>,
    defaultId: string,
  ) {
    // 默认值可能来自旧配置（claude-cli），先归一再校验。
    this.defaultId = normalizeBackendId(defaultId)
    if (!backends.has(this.defaultId)) {
      throw new WorkerBackendError('backend:unknown', `默认 backend 未注册: ${defaultId}`)
    }
  }

  get(id: string): WorkerBackend {
    const resolved = normalizeBackendId(id)
    const backend = this.backends.get(resolved)
    if (!backend) throw new WorkerBackendError('backend:unknown', `未知 backend: ${id}`)
    return backend
  }

  has(id: string): boolean {
    return this.backends.has(normalizeBackendId(id))
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
  backends.set(ORCA_BACKEND_ID, new OrcaAdapter({
    runner: deps.orca,
    workersDir: deps.workersDir,
    spec: deps.spec,
  }))

  // 旧配置里的 backend.options.claude-cli 仍可读，避免升级后模型配置丢失。
  const claudeOptions = (config.backend.options?.[CLAUDE_CODE_BACKEND_ID]
    ?? config.backend.options?.[LEGACY_CLAUDE_CODE_BACKEND_ID]
    ?? {}) as Record<string, unknown>
  backends.set(CLAUDE_CODE_BACKEND_ID, new ClaudeCodeBackend({
    claude: deps.claude,
    git: deps.git,
    workersDir: deps.workersDir,
    home: deps.home,
    ...(deps.claudeProjectsDir ? { claudeProjectsDir: deps.claudeProjectsDir } : {}),
    // 只允许非安全参数；allowedTools / sandbox 由 worker.tools 与内置基线决定。
    ...(typeof claudeOptions.model === 'string' ? { model: claudeOptions.model } : {}),
    ...(deps.env ? { env: deps.env } : {}),
  }))

  return new BackendRegistry(backends, config.backend.default)
}
