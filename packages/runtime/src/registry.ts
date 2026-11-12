import { WorkerRuntimeError, type WorkerRuntime } from './port.js'
import { normalizeRuntimeId } from './runtimes/catalog.js'
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

/** 用插件创建好的 adapter 组装注册表；插件发现与加载由 plugins/loader 负责。 */
export function createRuntimes(runtimes: Iterable<WorkerRuntime>, defaultId: string): RuntimeRegistry {
  return new RuntimeRegistry(new Map([...runtimes].map(runtime => [runtime.id, runtime])), defaultId)
}
