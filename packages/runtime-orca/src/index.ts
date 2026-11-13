import type { RuntimePlugin } from '@router-agent/runtime'
import { runtimeOptionString, runtimeOptionDefault } from '@router-agent/runtime'
import { ORCA_OPTION_SPEC } from './orca/options.js'
import { OrcaRuntime } from './orca/index.js'

const plugin: RuntimePlugin = {
  kind: 'runtime',
  meta: {
    id: 'orca',
    packageName: '@router-agent/runtime-orca',
    name: 'Orca',
    label: 'orca · Orca worktree + 终端',
    hint: '通过 Orca 创建 worktree 并启动 Agent 终端（默认跟随 Orca 配置），交互与状态读取走 Orca',
    installHint: '从 Orca 官方发布页下载安装，并确保 orca CLI 在 PATH 中',
    installUrl: 'https://github.com/stablyai/orca/releases',
    repoSelector: true,
  },
  options: ORCA_OPTION_SPEC,
  create(ctx) {
    return new OrcaRuntime({
      runner: ctx.runners.orca,
      workersDir: ctx.workersDir,
      home: ctx.home,
      ...(ctx.claudeProjectsDir ? { claudeProjectsDir: ctx.claudeProjectsDir } : {}),
      agent: runtimeOptionString(ctx.config.runtime.options, 'orca', 'agent')
        || String(runtimeOptionDefault('orca', 'agent') ?? ''),
      logger: ctx.logger,
      env: ctx.env,
    })
  },
}

export default plugin
export * from './orca/index.js'
export * from './orca/options.js'
export * from './orca/report-poller.js'
export * from './orca/commands.js'
export * from './orca/codex-update.js'
