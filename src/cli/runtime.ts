import { spawn } from 'node:child_process'
import { loadConfig, setRuntimePlugin, writeConfig } from '../config.js'
import { acpAgentOf } from '@router-agent/runtime-acp'
import { CODEX_APP_RUNTIME_ID, isWorkerRuntimeId, normalizeRuntimeId } from '#runtime/runtimes/catalog.js'
import { detectCodexBinary } from '@router-agent/runtime-codex'
import { AcpRuntimeAdmin } from '@router-agent/runtime-acp'
import { resolveAgentCommand, resolveExecutable } from '@router-agent/runtime-acp'
import { installAcpAgent, uninstallAcpAgent } from '@router-agent/runtime-acp'
import type { RuntimeChoice } from '@router-agent/runtime-acp'
import { pluginSpecifier, type PluginEntry } from '#infra/plugin-loader.js'
import { readPluginDeclaration } from '#infra/plugin-loader.js'
import { installPluginPackage, installedPluginVersion, npmPackageNameOf } from '#infra/plugin-install.js'
import { errorMessage } from '#infra/logger.js'
import { runtimeIdFromPluginSource } from '#runtime/plugins/id.js'

export interface RuntimeCliIo {
  stdout(line: string): void
  stderr(line: string): void
  env: Record<string, string | undefined>
}

function envOf(io: RuntimeCliIo): NodeJS.ProcessEnv {
  return { ...process.env, ...io.env }
}

function adminFor(home: string, io: RuntimeCliIo): AcpRuntimeAdmin {
  return new AcpRuntimeAdmin({ home, env: envOf(io), config: loadConfig(home) })
}

function pad(value: string, width: number): string {
  // 中文按 2 个字符宽度估算，避免表格错位。
  const visual = [...value].reduce((sum, char) => sum + (/[一-龥]/.test(char) ? 2 : 1), 0)
  return value + ' '.repeat(Math.max(0, width - visual))
}

const STATUS_LABEL: Record<RuntimeChoice['status'], string> = {
  ready: '可用',
  'not-installed': '未安装',
  incompatible: '不兼容',
  'needs-auth': '未登录',
  unverified: '未验证',
}

function formatChoice(choice: RuntimeChoice): string {
  const version = choice.version ?? '-'
  const source = choice.source ?? '-'
  const reason = choice.reason ? `；${choice.reason}` : ''
  return `${pad(choice.id, 16)} ${pad(STATUS_LABEL[choice.status], 8)} ${pad(version, 10)} ${pad(source, 8)} ${choice.hint}${reason}`
}

interface PluginRuntimeRow {
  id: string
  specifier: string
  packageName?: string
  installedVersion?: string
}

/** 按配置列出插件运行时；npm 包是否已下载到 RA_HOME 也一并标出。 */
function pluginRuntimeRows(home: string): PluginRuntimeRow[] {
  const config = loadConfig(home)
  return Object.entries(config.runtime.plugins ?? {})
    .map(([id, entry]) => {
      const specifier = pluginSpecifier(entry)
      if (!specifier) return { id, specifier: '' }
      const packageName = npmPackageNameOf(specifier)
      const version = packageName ? installedPluginVersion(home, packageName) : null
      return {
        id,
        specifier,
        ...(packageName ? { packageName } : {}),
        ...(version ? { installedVersion: version } : {}),
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

function pluginRowStatus(row: PluginRuntimeRow): string {
  if (!row.specifier) return '已禁用'
  if (!row.packageName) return '本地路径'
  return row.installedVersion ? `已安装 ${row.installedVersion}` : '未安装'
}

export async function cmdRuntimeList(home: string, opts: { json?: boolean }, io: RuntimeCliIo): Promise<number> {
  const admin = adminFor(home, io)
  const snapshot = await admin.detect()
  const plugins = pluginRuntimeRows(home)
  if (opts.json) {
    io.stdout(JSON.stringify({ ...snapshot, plugins }, null, 2))
    return 0
  }
  io.stdout(`探测时间：${snapshot.detectedAt}`)
  io.stdout(`${pad('运行时', 16)} ${pad('状态', 8)} ${pad('版本', 10)} ${pad('来源', 8)} 说明`)
  for (const choice of snapshot.choices) io.stdout(formatChoice(choice))
  const installable = snapshot.choices
    .filter(choice => choice.installable && choice.status === 'not-installed')
    .map(choice => choice.id)
  if (installable.length > 0) {
    io.stdout('')
    io.stdout(`可安装：${installable.join(', ')}；运行 ra runtime install <id> 安装`)
  }
  if (plugins.length > 0) {
    io.stdout('')
    io.stdout('插件运行时（runtime.plugins）')
    io.stdout(`${pad('id', 16)} ${pad('npm 包 / 路径', 34)} 状态`)
    for (const row of plugins) io.stdout(`${pad(row.id, 16)} ${pad(row.specifier, 34)} ${pluginRowStatus(row)}`)
    const missing = plugins.filter(row => row.packageName && !row.installedVersion).map(row => row.id)
    if (missing.length > 0) io.stdout(`未下载的包：运行 ra runtime install <id> 安装（${missing.join(', ')}）`)
  }
  return 0
}

export async function cmdRuntimeCheck(home: string, id: string, io: RuntimeCliIo): Promise<number> {
  const admin = adminFor(home, io)
  const result = await admin.check(id)
  io.stdout(JSON.stringify(result, null, 2))
  return result.ok ? 0 : 1
}

/**
 * 安装 `runtime.plugins.<id>` 里声明的插件包。
 *
 * 本地路径插件不需要下载；npm 包装到 `<RA_HOME>/node_modules`，重启后加载器才能按包名解析到。
 */
async function installConfiguredPlugin(
  home: string,
  id: string,
  entry: PluginEntry,
  opts: { version?: string },
  io: RuntimeCliIo,
): Promise<number> {
  const specifier = pluginSpecifier(entry)
  if (!specifier) {
    io.stderr(`${id} 在配置里被禁用（enabled: false）；先修改 runtime.plugins.${id}`)
    return 1
  }
  const packageName = npmPackageNameOf(specifier)
  if (!packageName) {
    io.stdout(`${id} 配置的是本地路径 ${specifier}，不需要下载；重启 ra 后按路径加载。`)
    return 0
  }
  const result = await installPluginPackage({
    home,
    packageName,
    ...(opts.version ? { version: opts.version } : {}),
    env: envOf(io),
    onLine: line => io.stdout(line),
  })
  if (!result.ok) {
    io.stderr(`安装失败：${result.error ?? '未知错误'}`)
    return 1
  }
  io.stdout('提示：安装后需要重启 ra 服务，插件运行时才会加载；默认运行时用 ra config set runtime.default <运行时 id> 切换。')
  return 0
}

export async function cmdRuntimeInstall(
  home: string,
  id: string,
  opts: { version?: string },
  io: RuntimeCliIo,
): Promise<number> {
  if (normalizeRuntimeId(id) === CODEX_APP_RUNTIME_ID) {
    const detection = await detectCodexBinary({ home, env: envOf(io), config: loadConfig(home) })
    io.stderr(detection.installHint)
    if (detection.installUrl) io.stderr(`下载 / 安装：${detection.installUrl}`)
    io.stderr('安装后重启 ra；也可以用 runtime.options.codex-app.command 指定可执行文件。')
    return 1
  }
  const config = loadConfig(home)
  if (!acpAgentOf(id)) {
    const entry = config.runtime.plugins?.[id]
    if (entry === undefined) {
      const declared = Object.keys(config.runtime.plugins ?? {})
      io.stderr(
        `未知运行时 ${id}：既不是 ACP Agent，也没有在 runtime.plugins 里声明`
        + `${declared.length > 0 ? `（已声明：${declared.join(', ')}）` : '；先用 ra runtime add <id> <npm 包名> 添加'}`,
      )
      return 1
    }
    return installConfiguredPlugin(home, id, entry, opts, io)
  }
  const result = await installAcpAgent({
    home,
    agentId: id,
    ...(opts.version ? { version: opts.version } : {}),
    env: envOf(io),
    onLine: line => io.stdout(line),
  })
  if (!result.ok) {
    io.stderr(`安装失败：${result.error ?? '未知错误'}`)
    return 1
  }
  io.stdout('提示：安装后需要重启 ra 服务，运行时才会生效。')
  return 0
}

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

function isLocalPluginEntry(value: string): boolean {
  return value.startsWith('.') || value.startsWith('/') || value.startsWith('file:') || /^[a-zA-Z]:[\\/]/.test(value)
}

/**
 * 按 npm 包名（或本地路径）添加一个运行时插件。
 *
 * runtime id 不由包名推导：装好并成功加载后，从插件包声明的 `meta.id` 读出来。
 * 显式给了 id（兼容旧写法 `ra runtime add <id> <入口>`）时按 id 写配置。
 * 不自动切换 `runtime.default`，避免误改正在派工的运行时。
 */
export async function cmdRuntimeAdd(
  home: string,
  entry: string,
  opts: { version?: string; id?: string },
  io: RuntimeCliIo,
): Promise<number> {
  const target = entry.trim()
  if (!target) {
    io.stderr('用法：ra runtime add <npm 包名 | 本地路径>')
    return 2
  }
  const packageName = npmPackageNameOf(target)
  if (!packageName && !isLocalPluginEntry(target)) {
    io.stderr(`入口只能是 npm 包名（如 @scope/runtime-x）或本地路径（如 ./my-runtime）：${target}`)
    return 2
  }
  const explicitId = opts.id?.trim()
  if (packageName && !explicitId) {
    const installedVersion = installedPluginVersion(home, packageName)
    if (installedVersion) {
      io.stdout(`${packageName}@${installedVersion} 已安装，直接读取它的声明`)
    } else {
      const installed = await installPluginPackage({
        home,
        packageName,
        ...(opts.version ? { version: opts.version } : {}),
        env: envOf(io),
        onLine: line => io.stdout(line),
      })
      if (!installed.ok) {
        io.stderr(`安装失败：${installed.error ?? '未知错误'}`)
        return 1
      }
    }
  }
  // 只有真正能加载的包才知道自己是什么运行时：id 取自插件包的 meta.id。
  let pluginId = explicitId
  if (!pluginId) {
    try {
      const declaration = await readPluginDeclaration({ kind: 'runtime', home, specifier: target })
      pluginId = declaration.id
      io.stdout(`runtime id 来自插件包声明：${pluginId}`)
    } catch (error) {
      io.stderr(`读不出插件声明：${errorMessage(error)}`)
      io.stderr('插件包需要默认导出 kind=runtime 的对象，并在 meta.id 里声明自己的 id')
      return 1
    }
  }
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    io.stderr(`插件 id 只能是小写字母、数字与连字符：${pluginId}`)
    return 2
  }
  if (isWorkerRuntimeId(pluginId)) {
    io.stderr(`${pluginId} 是内置运行时；如需替换插件包，用 ra config set runtime.plugins.${pluginId} <包名>`)
    return 1
  }
  const config = loadConfig(home)
  const existed = config.runtime.plugins?.[pluginId] !== undefined
  setRuntimePlugin(config, pluginId, target)
  writeConfig(home, config)
  io.stdout(`已写入 runtime.plugins.${pluginId} = ${target}${existed ? '（覆盖原入口）' : ''}`)

  if (!packageName) {
    io.stdout('本地路径插件不需要下载；重启 ra 后生效。')
    return 0
  }
  io.stdout(`提示：重启 ra 后插件运行时才会加载；插件声明的运行时 id 以它自己的 meta.id 为准。`)
  io.stdout('切换默认运行时：ra config set runtime.default <运行时 id>')
  return 0
}

export async function cmdRuntimeUninstall(home: string, id: string, io: RuntimeCliIo): Promise<number> {
  if (normalizeRuntimeId(id) === CODEX_APP_RUNTIME_ID) {
    io.stderr('codex-app 使用 Codex App / 全局 Codex CLI，不归 ra 管理；请用官方安装器卸载。')
    return 1
  }
  const agent = acpAgentOf(id)
  const config = loadConfig(home)
  // 自定义插件运行时只归配置管：删掉 runtime.plugins.<id> 并重启即可。
  // npm 包可能被多个插件复用，不在这里删除 node_modules。
  if (!agent && config.runtime.plugins?.[id] !== undefined) {
    if (normalizeRuntimeId(config.runtime.default) === id) {
      io.stderr(`${id} 是当前默认 runtime；先 ra config set runtime.default orca，再移除插件`)
      return 1
    }
    io.stdout(`自定义运行时由配置声明：运行 ra config set runtime.plugins.${id} '' 后重启 ra 即可移除。`)
    io.stdout(`已下载的 npm 包保留在 ${home}/node_modules，避免影响其它正在使用它的插件。`)
    return 0
  }
  if (agent && normalizeRuntimeId(config.runtime.default) === agent.runtimeId) {
    io.stderr(`${agent.runtimeId} 是当前默认 runtime；先 ra config set runtime.default orca，再卸载`)
    return 1
  }
  const result = await uninstallAcpAgent({ home, agentId: id })
  for (const line of result.log) io.stdout(line)
  if (!result.ok) {
    io.stderr(`卸载失败：${result.error ?? '未知错误'}`)
    return 1
  }
  return 0
}

export async function cmdRuntimeLogin(home: string, id: string, io: RuntimeCliIo): Promise<number> {
  const config = loadConfig(home)
  if (normalizeRuntimeId(id) === CODEX_APP_RUNTIME_ID) {
    const detection = await detectCodexBinary({ home, env: envOf(io), config })
    if (!detection.command || !detection.compatible) {
      io.stderr(detection.reason ?? 'Codex 不可用；先安装 Codex App 或 Codex CLI')
      return 1
    }
    return new Promise<number>(resolve => {
      const child = spawn(detection.command!, ['login'], { stdio: 'inherit', env: envOf(io) })
      child.on('error', error => { io.stderr(error.message); resolve(1) })
      child.on('close', code => resolve(code ?? 1))
    })
  }
  const agent = acpAgentOf(id)
  if (!agent) {
    io.stderr(`未知 ACP Agent: ${id}`)
    return 1
  }
  if (!agent.login) {
    io.stderr(`${agent.label} 没有配置登录命令${agent.hint ? `：${agent.hint}` : ''}`)
    return 1
  }
  const resolvedAgent = resolveAgentCommand(agent, { home, env: envOf(io), config })
  const bin = agent.login.command === agent.command
    ? resolvedAgent.command
    : resolveExecutable(agent.login.command, envOf(io))
  if (!bin) {
    io.stderr(`找不到登录命令 ${agent.login.command}；先安装 ${agent.label}`)
    return 1
  }
  return new Promise<number>(resolve => {
    const child = spawn(bin, [...agent.login!.args], {
      stdio: 'inherit',
      env: { ...process.env, ...io.env },
    })
    child.on('error', error => {
      io.stderr(error.message)
      resolve(1)
    })
    child.on('close', code => resolve(code ?? 1))
  })
}
