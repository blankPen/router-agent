import type { RuntimePlugin } from '@router-agent/runtime'

/**
 * 最小运行时插件。
 *
 * 安装后 ra 会读这里的 meta.id 作为 runtime id，写进 config.yaml 的 runtime.plugins.<id>，
 * 重启 ra 即可在「配置 → 派工与服务」里看到。
 */
const plugin: RuntimePlugin = {
  kind: 'runtime',
  meta: {
    id: 'example',
    name: 'Example Runtime',
    label: 'example · 自定义 Worker 运行时',
    hint: '说明这个运行时如何启动 Worker、如何读取状态',
  },
  create(ctx) {
    return {
      id: 'example',
      capabilities: {
        agent: {
          liveStatus: false,
          processExit: false,
          output: false,
          activity: false,
          structuredInput: false,
          nudge: false,
        },
        workspace: {
          cleanup: false,
          prLink: false,
          discovery: false,
        },
      },
      async start(input) {
        return { handle: `${input.ticket.id}-example`, workdir: input.workdir || ctx.workersDir }
      },
      async deliver() {
        return { status: 'accepted', inputIds: [] }
      },
      async stop() {},
    }
  },
}

export default plugin
