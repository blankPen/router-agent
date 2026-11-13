export { T3CODE_OPTION_SPEC } from '@router-agent/runtime'

/** T3 Code 运行时的配置项读取：落点是 runtime.options.t3code.*。 */
import type { RuntimeConfigView } from '@router-agent/core/config.js'
import { runtimeOptionString } from '@router-agent/runtime'

export interface T3CodeOptions {
  /** t3 可执行文件；默认 t3。 */
  command?: string
  /** T3 provider 实例 id，例如 codex / claude。 */
  provider?: string
  /** 模型；与 provider 一起传给 `t3 thread start`。 */
  model?: string
  /** T3 数据目录（等价 T3CODE_HOME）；留空用 T3 默认目录。 */
  baseDir?: string
}

/** 读取 `runtime.options.t3code`；未配置的项留空，由运行时按默认值兜底。 */
export function t3CodeOptionsOf(config: RuntimeConfigView | undefined): T3CodeOptions {
  const options = config?.runtime.options
  const pick = (key: string): string | undefined => {
    const value = runtimeOptionString(options, 't3code', key)
    return value ? value : undefined
  }
  return {
    ...(pick('command') ? { command: pick('command')! } : {}),
    ...(pick('provider') ? { provider: pick('provider')! } : {}),
    ...(pick('model') ? { model: pick('model')! } : {}),
    ...(pick('baseDir') ? { baseDir: pick('baseDir')! } : {}),
  }
}
