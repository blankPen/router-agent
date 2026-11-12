import { spawn } from 'node:child_process'
import { loadConfig } from '../config.js'
import { acpAgentOf } from '#runtime/runtimes/acp/agents.js'
import { CODEX_APP_RUNTIME_ID, normalizeRuntimeId } from '#runtime/runtimes/catalog.js'
import { detectCodexBinary } from '#runtime/runtimes/codex/detect.js'
import { AcpRuntimeAdmin } from '#runtime/runtimes/acp/admin.js'
import { resolveAgentCommand, resolveExecutable } from '#runtime/runtimes/acp/detect.js'
import { installAcpAgent, uninstallAcpAgent } from '#runtime/runtimes/acp/install.js'
import type { RuntimeChoice } from '#runtime/runtimes/acp/detect.js'

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

export async function cmdRuntimeList(home: string, opts: { json?: boolean }, io: RuntimeCliIo): Promise<number> {
  const admin = adminFor(home, io)
  const snapshot = await admin.detect()
  if (opts.json) {
    io.stdout(JSON.stringify(snapshot, null, 2))
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
  return 0
}

export async function cmdRuntimeCheck(home: string, id: string, io: RuntimeCliIo): Promise<number> {
  const admin = adminFor(home, io)
  const result = await admin.check(id)
  io.stdout(JSON.stringify(result, null, 2))
  return result.ok ? 0 : 1
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

export async function cmdRuntimeUninstall(home: string, id: string, io: RuntimeCliIo): Promise<number> {
  if (normalizeRuntimeId(id) === CODEX_APP_RUNTIME_ID) {
    io.stderr('codex-app 使用 Codex App / 全局 Codex CLI，不归 ra 管理；请用官方安装器卸载。')
    return 1
  }
  const agent = acpAgentOf(id)
  const config = loadConfig(home)
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