import type { RuntimePlugin } from '@router-agent/runtime'
import { T3CODE_OPTION_SPEC } from './t3code/options.js'
import { t3CodeOptionsOf } from './t3code/options.js'
import { T3CodeRuntime } from './t3code/index.js'
import { T3_INSTALL_HINT, T3_INSTALL_URL } from './t3code/commands.js'

const plugin: RuntimePlugin = {
  kind: 'runtime',
  meta: {
    id: 't3code',
    packageName: '@router-agent/runtime-t3code',
    name: 'T3 Code',
    label: 't3code · git worktree + T3 Code 线程',
    hint: '用 T3 Code 的线程承载工单；Agent 在 ra 建的 worktree 里跑，手机端也能看到同一个线程',
    installHint: T3_INSTALL_HINT,
    installUrl: T3_INSTALL_URL,
  },
  options: T3CODE_OPTION_SPEC,
  create(ctx) {
    const options = t3CodeOptionsOf(ctx.config)
    return new T3CodeRuntime({
      t3: ctx.runners.t3,
      git: ctx.runners.git,
      workersDir: ctx.workersDir,
      home: ctx.home,
      ...(options.command ? { command: options.command } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.baseDir ? { baseDir: options.baseDir } : {}),
      env: ctx.env,
      logger: ctx.logger,
    })
  },
}

export default plugin
export * from './t3code/commands.js'
export * from './t3code/options.js'
export * from './t3code/server.js'
export * from './t3code/index.js'
