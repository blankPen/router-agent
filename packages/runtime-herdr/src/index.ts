import type { RuntimePlugin } from '@router-agent/runtime'
import { HERDR_OPTION_SPEC } from './herdr/options.js'
import { HerdrRuntime } from './herdr/index.js'

const plugin: RuntimePlugin = {
  kind: 'runtime',
  meta: {
    id: 'herdr',
    packageName: '@router-agent/runtime-herdr',
    name: 'Herdr',
    label: 'herdr · git worktree + Herdr 终端',
    hint: '检出由 ra 用 git worktree 建，Herdr 只开终端窗口跑 Agent；状态来自 Herdr 的 Agent 检测',
    installHint: '从 Herdr 官方发布页下载安装，并确保 herdr CLI 在 PATH 中',
    installUrl: 'https://github.com/herdrdev/herdr/releases',
  },
  options: HERDR_OPTION_SPEC,
  create(ctx) {
    return new HerdrRuntime({
      herdr: ctx.runners.herdr,
      git: ctx.runners.git,
      workersDir: ctx.workersDir,
      home: ctx.home,
      ...(ctx.claudeProjectsDir ? { claudeProjectsDir: ctx.claudeProjectsDir } : {}),
    })
  },
}

export default plugin
export * from './herdr/agents.js'
export * from './herdr/options.js'
export { ensureHerdrServer, probeHerdrServer, type HerdrServerSpawner } from './herdr/server.js'
export * from './herdr/index.js'
export * from './herdr/commands.js'
