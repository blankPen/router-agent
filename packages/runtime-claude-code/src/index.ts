import type { RuntimePlugin } from '@router-agent/runtime'
import { ClaudeCodeRuntime } from './claude-code/index.js'

const plugin: RuntimePlugin = {
  kind: 'runtime',
  meta: {
    id: 'claude-code',
    packageName: '@router-agent/runtime-claude-code',
    name: 'Claude Code',
    label: 'claude-code · git worktree + claude --bg',
    hint: '直接调用 Claude Code CLI 的后台会话；项目 repo 需要填本地仓库绝对路径',
    installHint: '参考 Claude Code 官方安装说明',
    installUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
  },
  create(ctx) {
    return new ClaudeCodeRuntime({
      claude: ctx.runners.claude,
      ...(ctx.claudeBin ? { claudeBin: ctx.claudeBin } : {}),
      git: ctx.runners.git,
      workersDir: ctx.workersDir,
      home: ctx.home,
      ...(ctx.claudeProjectsDir ? { claudeProjectsDir: ctx.claudeProjectsDir } : {}),
      env: ctx.env,
      logger: ctx.logger,
    })
  },
}

export default plugin
export * from './claude-code/index.js'
