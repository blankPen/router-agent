import type { RuntimePlugin, WorkerRuntime } from '@router-agent/runtime'
import { AcpRuntime } from './acp/index.js'
import { ACP_AGENTS } from './acp/agents.js'
import { acpRuntimeConfig, installHintOf, resolveAgentCommand } from './acp/detect.js'

const plugin: RuntimePlugin = {
  kind: 'runtime',
  meta: {
    id: 'acp',
    packageName: '@router-agent/runtime-acp',
    name: 'ACP',
    label: 'acp · 任意 ACP Agent',
    hint: '通过 ACP 协议接入其它 Agent；启用前需要在 runtime.options.acp 配置 command',
    installHint: '在 config.yaml 的 runtime.options.acp 下配置 command 与 args，然后重启服务',
  },
  create(ctx) {
    const options = (ctx.config.runtime.options?.acp ?? {}) as Record<string, unknown>
    const command = typeof options.command === 'string' ? options.command.trim() : ''
    if (!command) return null
    const args = Array.isArray(options.args)
      ? options.args.filter((item): item is string => typeof item === 'string')
      : []
    const env = options.env && typeof options.env === 'object'
      ? Object.fromEntries(Object.entries(options.env as Record<string, unknown>).filter(([, value]) => typeof value === 'string')) as NodeJS.ProcessEnv
      : undefined
    return new AcpRuntime({
      id: 'acp',
      command,
      args,
      workersDir: ctx.workersDir,
      home: ctx.home,
      git: ctx.runners.git,
      env: { ...ctx.env, ...env },
    })
  },
  createAll(ctx) {
    const runtimes: Array<WorkerRuntime | null> = []
    const resolveEnv = { ...ctx.env }
    for (const agent of ACP_AGENTS) {
      const resolved = resolveAgentCommand(agent, { home: ctx.home, env: resolveEnv, config: ctx.config })
      const runtimeConfig = acpRuntimeConfig(agent, ctx.config)
      const hint = installHintOf(agent)
      runtimes.push(new AcpRuntime({
        id: agent.runtimeId,
        ...(resolved.command ? { command: resolved.command } : {}),
        args: runtimeConfig.args,
        env: { ...ctx.env, ...runtimeConfig.env },
        workersDir: ctx.workersDir,
        home: ctx.home,
        git: ctx.runners.git,
        ...(resolved.reason ? { unavailableReason: resolved.reason } : {}),
        ...(hint ? { installHint: hint } : {}),
        probeArgs: [...(agent.probeArgs ?? ['--version'])],
      }))
    }
    return runtimes
  },
}

export default plugin
export * from './acp/agents.js'
export { AcpRuntimeAdmin, InstallStartError, type InstallJob } from './acp/admin.js'
export { installAcpAgent, uninstallAcpAgent } from './acp/install.js'
export * from './acp/index.js'
export * from './acp/detect.js'
export * from './acp/permissions.js'
export * from './acp/protocol.js'
