import type { RuntimeConfigView } from '@router-agent/core/config.js'
import type { CommandRunner } from '@router-agent/infra/process.js'
import type { Logger } from '@router-agent/infra/logger.js'
import type { PluginEntry, PluginModuleLoader } from '@router-agent/infra/plugin-loader.js'
import type { WorkerRuntime } from '../port.js'
import type { RuntimeOptionSpec } from '../runtimes/options.js'

export type { PluginEntry, PluginModuleLoader }

/** 运行时插件元数据；Web 面板与配置校验共用。 */
export interface RuntimePluginMeta {
  id: string
  name: string
  label: string
  hint: string
  installHint?: string
  installUrl?: string
  /** 是否可由 ra 自动安装（ACP 扩展）。 */
  installable?: boolean
  packageName?: string
  /** 已有原生运行时替代品：面板不再作为可选项展示。 */
  deprecated?: boolean
  /** 是否接受非本地仓库选择器（Orca 的 name: / id:）。 */
  repoSelector?: boolean
}

/** 运行时 adapter 创建上下文；宿主只注入中立依赖。 */
export interface RuntimePluginContext {
  home: string
  workersDir: string
  config: RuntimeConfigView
  env: NodeJS.ProcessEnv
  logger: Logger
  /** 运行时可能需要的工作目录运行器；插件自行选择使用哪一个。 */
  runners: {
    orca: CommandRunner
    claude: CommandRunner
    git: CommandRunner
    herdr: CommandRunner
    /** T3 Code CLI；t3code 运行时用。 */
    t3: CommandRunner
  }
  claudeBin?: string
  claudeProjectsDir?: string
}

/** 运行时插件：一个包可以导出多个运行时实例。 */
export interface RuntimePlugin {
  kind: 'runtime'
  meta?: RuntimePluginMeta
  /** 声明面板可配置项；配置落点统一为 runtime.options.<id>.<key>。 */
  options?: RuntimeOptionSpec
  /** 创建 adapter；返回 null 表示当前配置下不启用（例如未配置 command）。 */
  create(ctx: RuntimePluginContext): WorkerRuntime | null | Promise<WorkerRuntime | null>
  /** 附加运行时；ACP 这类目录型插件用它一次注册多个 id。 */
  createAll?(ctx: RuntimePluginContext): Array<WorkerRuntime | null> | Promise<Array<WorkerRuntime | null>>
}

export type Plugin = RuntimePlugin

