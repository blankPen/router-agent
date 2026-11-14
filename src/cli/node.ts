/**
 * 多设备节点的命令行入口。
 *
 * - `ra node`：在这台电脑上跑节点守护进程；
 * - `ra relay`：在公网服务器上跑中继服务；
 * - `ra nodes`：看中心 Router 侧登记的设备与在线状态。
 */
import { join } from 'node:path'
import { loadConfig, type AppConfig } from '../config.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import { loadRuntimePlugins } from '#runtime/plugins/loader.js'
import { DirectNodeAgentLink, RelayNodeAgentLink, type NodeAgentLink } from '../node/link.js'
import { NodeAgent } from '../node/agent.js'
import { createRelayServer } from '../node/relay.js'

export interface NodeCliIo {
  stdout(line: string): void
  stderr(line: string): void
  env: Record<string, string | undefined>
  orca?: import('#infra/process.js').CommandRunner
  claude?: import('#infra/process.js').CommandRunner
  git?: import('#infra/process.js').CommandRunner
  herdr?: import('#infra/process.js').CommandRunner
  t3?: import('#infra/process.js').CommandRunner
  claudeBin?: string
  logger?: Logger
}

/** 节点侧的链路：直连中心，或经中继转发。 */
export function nodeAgentLinkOf(config: AppConfig): NodeAgentLink {
  const nodes = config.nodes
  if (nodes.mode === 'relay') {
    return new RelayNodeAgentLink({
      baseUrl: nodes.relay,
      routerId: nodes.routerId,
      nodeId: nodes.nodeId,
      relayToken: nodes.relayToken,
    })
  }
  return new DirectNodeAgentLink({
    baseUrl: nodes.server,
    nodeId: nodes.nodeId,
    token: nodes.token,
  })
}

/** 跑节点守护进程：连回中心取任务，用本机 runtime 执行。 */
export async function cmdNode(home: string, opts: { once?: boolean }, io: NodeCliIo): Promise<number> {
  const config = loadConfig(home, io.env as NodeJS.ProcessEnv)
  const nodes = config.nodes
  if (!nodes.enabled) {
    io.stderr('多设备节点未启用：在 config.yaml 的 nodes.enabled 设为 true')
    return 2
  }
  if (!nodes.nodeId) {
    io.stderr('缺少 nodes.nodeId：本机作为节点时的设备 id')
    return 2
  }
  if (!nodes.token) {
    io.stderr('缺少 nodes.token：节点密钥（要与中心 Router 的 devices 里配的一致）')
    return 2
  }
  if (nodes.mode === 'relay' && !nodes.relay) {
    io.stderr('中继模式缺少 nodes.relay：中继服务地址')
    return 2
  }
  if (nodes.mode === 'direct' && !nodes.server) {
    io.stderr('直连模式缺少 nodes.server：中心 Router 地址（例如 http://100.64.0.2:3083）')
    return 2
  }
  const logger = io.logger ?? noopLogger
  const runtimePlugins = await loadRuntimePlugins(config, {
    home,
    workersDir: join(home, 'workers'),
    runners: {
      orca: io.orca ?? unavailableRunner('orca'),
      claude: io.claude ?? unavailableRunner('claude'),
      git: io.git ?? unavailableRunner('git'),
      herdr: io.herdr ?? unavailableRunner('herdr'),
      t3: io.t3 ?? unavailableRunner('t'),
    },
    ...(io.claudeBin ? { claudeBin: io.claudeBin } : {}),
    logger,
  })
  const agent = new NodeAgent({
    home,
    config,
    link: nodeAgentLinkOf(config),
    runtimes: runtimePlugins.registry,
    logger,
  })
  io.stdout(`节点 ${nodes.nodeId} 已启动：${nodes.mode === 'relay' ? `中继 ${nodes.relay}` : `直连 ${nodes.server}`}`)
  const stop = (): void => {
    agent.stop()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  try {
    await agent.run()
  } catch (error) {
    io.stderr(`节点退出：${errorMessage(error)}`)
    return 1
  }
  return 0
}

/** 跑中继服务：中心与各设备都连它，由它转发消息。 */
export async function cmdRelay(home: string, opts: { port?: string; host?: string; token?: string }, io: NodeCliIo): Promise<number> {
  const config = loadConfig(home, io.env as NodeJS.ProcessEnv)
  const token = (opts.token ?? config.nodes.relayToken).trim()
  if (!token) {
    io.stderr('缺少中继密钥：用 --token 指定，或在 config.yaml 的 nodes.relayToken 配置')
    return 2
  }
  const port = Number(opts.port ?? process.env.RA_RELAY_PORT ?? 9090)
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) {
    io.stderr(`端口不合法：${opts.port ?? port}`)
    return 2
  }
  const host = opts.host ?? '0.0.0.0'
  const logger = io.logger ?? noopLogger
  const relay = createRelayServer({ port, host, token, logger })
  await new Promise<void>((resolve, reject) => {
    relay.server.once('error', reject)
    relay.server.listen(port, host, () => resolve())
  })
  io.stdout(`中继服务已启动：http://${host}:${port}/relay/<routerId>/...`)
  const shutdown = (): void => {
    void relay.close().then(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  return new Promise<number>(() => {
    // 常驻直到收到信号
  })
}

/** 看中心 Router 侧登记的设备与在线状态。 */
export async function cmdNodes(home: string, opts: { json?: boolean; port?: string }, io: NodeCliIo): Promise<number> {
  const config = loadConfig(home, io.env as NodeJS.ProcessEnv)
  const port = Number(opts.port ?? process.env.RA_PORT ?? config.server.port)
  let nodes: unknown[] = []
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/nodes`)
    if (res.ok) {
      const body = (await res.json()) as { nodes?: unknown[] }
      nodes = body.nodes ?? []
    }
  } catch {
    // 中心没起或端口不对：退回展示配置里登记的设备。
  }
  if (nodes.length === 0) {
    nodes = config.nodes.devices.map(device => ({
      nodeId: device.id,
      name: device.name,
      online: false,
      projects: device.projects.map(project => project.name),
      runtimes: [],
      tickets: [],
      lastSeenAt: '',
    }))
  }
  if (opts.json) {
    io.stdout(JSON.stringify({ nodes }, null, 2))
    return 0
  }
  io.stdout(`${pad('设备', 16)} ${pad('状态', 8)} ${pad('项目', 24)} 工单`)
  for (const node of nodes as Array<Record<string, any>>) {
    const projects = (node.projects ?? []).join('、') || '-'
    io.stdout(`${pad(String(node.nodeId), 16)} ${pad(node.online ? '在线' : '离线', 8)} ${pad(projects, 24)} ${(node.tickets ?? []).join('、') || '-'}`)
  }
  return 0
}

/** 命令不可用时的替身：返回 127 而不是抛错，让适配器自己降级。 */
function unavailableRunner(bin: string): import('#infra/process.js').CommandRunner {
  return {
    async run() {
      return { code: 127, stdout: '', stderr: `${bin} 不可用` }
    },
  }
}

function pad(value: string, width: number): string {
  // 中文按 2 个字符宽度估算，避免表格错位。
  const visual = [...value].reduce((sum, char) => sum + (/[一-鿿]/.test(char) ? 2 : 1), 0)
  return value + ' '.repeat(Math.max(0, width - visual))
}
