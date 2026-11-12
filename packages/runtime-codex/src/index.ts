import type { RuntimePlugin } from '@router-agent/runtime'
import { CodexAppRuntime } from './codex/index.js'
import { codexAppOptionsOf } from './codex/detect.js'

const plugin: RuntimePlugin = {
  kind: 'runtime',
  meta: {
    id: 'codex-app',
    packageName: '@router-agent/runtime-codex',
    name: 'Codex App',
    label: 'codex-app · Codex App Server',
    hint: '直连 Codex App Server；优先使用 Codex App 内置 CLI，桌面端可见同一 thread',
    installHint: '安装 Codex App（macOS/Windows）或 Codex CLI；ra 会优先使用 Codex App 内置的版本',
    installUrl: 'https://chatgpt.com/codex',
  },
  create(ctx) {
    const options = codexAppOptionsOf(ctx.config)
    const inherited = { ...ctx.env }
    delete inherited.CODEX_HOME
    return new CodexAppRuntime({
      command: options.command,
      model: options.model,
      modelProvider: options.modelProvider,
      permissions: options.permissions,
      approvalPolicy: options.approvalPolicy,
      network: options.network,
      args: options.args,
      workersDir: ctx.workersDir,
      home: ctx.home,
      git: ctx.runners.git,
      env: { ...inherited, ...options.env },
      logger: ctx.logger,
    })
  },
}

export default plugin
export * from './codex/index.js'
export * from './codex/detect.js'
