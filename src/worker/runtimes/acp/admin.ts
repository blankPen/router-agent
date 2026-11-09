import { randomUUID } from 'node:crypto'
import type { AppConfig } from '../../../config.js'
import { realRunner, type CommandRunner } from '../../../infra/process.js'
import {
  ACP_RUNTIME_ID,
  CLAUDE_CODE_RUNTIME_ID,
  ORCA_RUNTIME_ID,
  WORKER_RUNTIMES,
  normalizeRuntimeId,
  type WorkerRuntimeMeta,
} from '../catalog.js'
import { acpAgentOf } from './agents.js'
import {
  checkAcpAgent,
  detectAcpAgent,
  detectAcpAgents,
  installHintOf,
  parseVersion,
  readDetectionSnapshot,
  resolveExecutable,
  writeDetectionSnapshot,
  type RuntimeChoice,
  type RuntimeDetection,
  type RuntimeRequirement,
} from './detect.js'
import { cleanupInstallState, installAcpAgent } from './install.js'

export type InstallPhase = 'queued' | 'installing' | 'verifying' | 'succeeded' | 'failed'

export interface InstallJob {
  id: string
  agentId: string
  runtimeId: string
  status: 'running' | 'ok' | 'failed'
  phase: InstallPhase
  startedAt: string
  finishedAt?: string
  version?: string
  lines: string[]
  error?: string
  choice?: RuntimeChoice
}

export class InstallStartError extends Error {
  constructor(
    readonly code: 'unknown-agent' | 'not-installable' | 'busy',
    message: string,
  ) {
    super(message)
    this.name = 'InstallStartError'
  }
}

export interface AcpRuntimeAdminOptions {
  home: string
  env: NodeJS.ProcessEnv
  config: AppConfig
  runner?: (bin: string) => CommandRunner
}

interface BuiltinProbe {
  status: RuntimeChoice['status']
  command?: string
  version?: string
  reason?: string
  requires?: RuntimeRequirement[]
}

/** 运行时探测快照 + 安装 job 的单进程管理器。API / CLI 共用。 */
export class AcpRuntimeAdmin {
  private current: RuntimeDetection | null
  private detecting = false
  private inflight: Promise<RuntimeDetection> | null = null
  private readonly jobs = new Map<string, InstallJob>()
  private readonly activeByAgent = new Map<string, string>()
  private readonly env: NodeJS.ProcessEnv
  private readonly runner: (bin: string) => CommandRunner

  constructor(private readonly opts: AcpRuntimeAdminOptions) {
    this.env = opts.env
    this.runner = opts.runner ?? realRunner
    this.current = readDetectionSnapshot(opts.home)
    cleanupInstallState(opts.home)
  }

  snapshot(): RuntimeDetection | null {
    return this.current
  }

  isDetecting(): boolean {
    return this.detecting
  }

  /** 重新探测；并发调用复用同一个 Promise。 */
  async detect(): Promise<RuntimeDetection> {
    if (this.inflight) return this.inflight
    this.detecting = true
    this.inflight = (async () => {
      try {
        const acp = await detectAcpAgents({
          home: this.opts.home,
          env: this.env,
          config: this.opts.config,
          runner: this.runner,
        })
        const snapshot: RuntimeDetection = {
          detectedAt: acp.detectedAt,
          choices: [...await this.builtinChoices(), ...acp.choices],
        }
        this.current = snapshot
        writeDetectionSnapshot(this.opts.home, snapshot)
        return snapshot
      } catch (error) {
        // 探测失败时保留上一次快照，避免 Web 面板突然清空。
        if (this.current) return this.current
        throw error
      } finally {
        this.detecting = false
        this.inflight = null
      }
    })()
    return this.inflight
  }

  /**
   * 内置运行时也探测一次，让卡片能显示版本、来源与安装状态。
   *
   * 说明：orca / claude-code 没有 ACP 协议，这里的 ready 只代表「CLI 能跑」，
   * 不代表已经登录；登录状态只有带 login.check 的 ACP Agent 才会判定。
   */
  private async builtinChoices(): Promise<RuntimeChoice[]> {
    const [orca, claude] = await Promise.all([
      this.probeBuiltin('orca', ORCA_RUNTIME_ID),
      this.probeBuiltin('claude', CLAUDE_CODE_RUNTIME_ID),
    ])
    const probes = new Map<string, BuiltinProbe>([
      [ORCA_RUNTIME_ID, orca],
      [CLAUDE_CODE_RUNTIME_ID, claude],
    ])
    return WORKER_RUNTIMES.map(meta => {
      if (meta.id === ACP_RUNTIME_ID) return this.genericAcpChoice(meta)
      const probe = probes.get(meta.id)!
      return {
        id: meta.id,
        label: meta.label,
        hint: meta.hint,
        status: probe.status,
        installable: false,
        cli: {
          command: meta.id === CLAUDE_CODE_RUNTIME_ID ? 'claude' : 'orca',
          label: meta.id === CLAUDE_CODE_RUNTIME_ID ? 'Claude Code CLI' : 'Orca CLI',
          installed: Boolean(probe.command),
          ...(probe.version ? { version: probe.version } : {}),
          ...(meta.installUrl ? { installUrl: meta.installUrl } : {}),
        },
        ...(probe.version ? { version: probe.version } : {}),
        ...(probe.command ? { command: probe.command, source: 'path' as const } : {}),
        ...(probe.reason ? { reason: probe.reason } : {}),
        ...(probe.requires && probe.requires.length > 0 ? { requires: probe.requires } : {}),
        ...(meta.installHint ? { installHint: meta.installHint } : {}),
      }
    })
  }

  /** 自定义 `acp` 运行时：命令来自 config.yaml，Web 面板只读展示。 */
  private genericAcpChoice(meta: WorkerRuntimeMeta): RuntimeChoice {
    const raw = this.opts.config.runtime.options?.[ACP_RUNTIME_ID]
    const options = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {}
    const command = typeof options.command === 'string' ? options.command.trim() : ''
    const base: RuntimeChoice = {
      id: meta.id,
      label: meta.label,
      hint: meta.hint,
      status: 'not-installed',
      installable: false,
      ...(meta.installHint ? { installHint: meta.installHint } : {}),
    }
    if (!command) {
      return { ...base, reason: '未配置 runtime.options.acp.command，请在 config.yaml 中配置' }
    }
    const resolved = resolveExecutable(command, this.env)
    if (!resolved) {
      return { ...base, command, source: 'config', reason: `找不到命令：${command}` }
    }
    return {
      ...base,
      status: 'unverified',
      command: resolved,
      source: 'config',
      reason: '已配置自定义 ACP 命令；重启服务后生效',
    }
  }

  /** 探测一个内置命令；claude-code 额外检查 git worktree 依赖。 */
  private async probeBuiltin(command: string, runtimeId: string): Promise<BuiltinProbe> {
    const resolved = resolveExecutable(command, this.env)
    if (!resolved) return { status: 'not-installed', reason: `未找到 ${command} CLI` }
    const versionResult = await this.runProbe(resolved, ['--version'])
    const version = parseVersion(versionResult.stdout) ?? parseVersion(versionResult.stderr)
    if (versionResult.code !== 0) {
      return {
        status: 'incompatible',
        command: resolved,
        ...(version ? { version } : {}),
        reason: `${command} --version 退出码 ${versionResult.code}`,
      }
    }
    const requirements: RuntimeRequirement[] = []
    let failure: string | undefined
    if (runtimeId === CLAUDE_CODE_RUNTIME_ID) {
      const gitBin = resolveExecutable('git', this.env)
      if (!gitBin) {
        requirements.push({ label: 'Git CLI', ok: false, reason: '未找到 git' })
        failure = '未找到 git；claude-code 运行时需要 git worktree'
      } else {
        const gitResult = await this.runProbe(gitBin, ['--version'], 1_500)
        const gitVersion = parseVersion(gitResult.stdout) ?? parseVersion(gitResult.stderr)
        if (gitResult.code !== 0) {
          requirements.push({ label: 'Git CLI', ok: false, ...(gitVersion ? { version: gitVersion } : {}), reason: 'git --version 不可用' })
          failure = 'git 不可用；claude-code 运行时需要 git worktree'
        } else {
          requirements.push({ label: 'Git CLI', ok: true, ...(gitVersion ? { version: gitVersion } : {}) })
        }
      }
    }
    return {
      status: failure ? 'incompatible' : 'ready',
      command: resolved,
      ...(version ? { version } : {}),
      ...(failure ? { reason: failure } : {}),
      ...(requirements.length > 0 ? { requires: requirements } : {}),
    }
  }

  private async runProbe(bin: string, args: string[], timeoutMs = 2_500): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      return await this.runner(bin).run(args, {
        cwd: this.opts.home,
        env: { ...process.env, ...this.env },
        timeoutMs,
      })
    } catch (error) {
      return { code: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
    }
  }

  /** L2 完整握手；结果写回快照，让下拉框反映「实际能不能连上」。 */
  async check(idOrRuntimeId: string): Promise<{
    ok: boolean
    detail: string
    choice?: RuntimeChoice
    protocolVersion?: number
    agentInfo?: { name?: string; version?: string }
    loadSession?: boolean
  }> {
    const normalized = normalizeRuntimeId(idOrRuntimeId)
    if (normalized === ORCA_RUNTIME_ID || normalized === CLAUDE_CODE_RUNTIME_ID || normalized === ACP_RUNTIME_ID) {
      return this.checkBuiltin(normalized)
    }
    const result = await checkAcpAgent(idOrRuntimeId, {
      home: this.opts.home,
      env: this.env,
      config: this.opts.config,
      runner: this.runner,
    })
    const agent = acpAgentOf(idOrRuntimeId)
    if (!agent) return result
    const detected = await detectAcpAgent(agent.runtimeId, {
      home: this.opts.home,
      env: this.env,
      config: this.opts.config,
      runner: this.runner,
    })
    const snapshot = this.current ?? { detectedAt: new Date().toISOString(), choices: await this.builtinChoices() }
    const existing = snapshot.choices.find(choice => choice.id === agent.runtimeId)
    const baseChoice = detected ?? existing ?? {
      id: agent.runtimeId,
      label: agent.label,
      hint: agent.hint,
      status: 'not-installed' as const,
      installable: Boolean(agent.package),
      ...(installHintOf(agent) ? { installHint: installHintOf(agent) } : {}),
    }
    // 握手成功不代表已登录（codex-acp 的 session/new 不校验账号）；保留 needs-auth。
    const status = !result.ok
      ? 'incompatible'
      : detected?.status === 'needs-auth'
        ? 'needs-auth'
        : 'ready'
    const reason = status === 'needs-auth'
      ? detected?.reason ?? agent.login?.hint ?? '需要先登录'
      : status === 'incompatible'
        ? result.detail
        : undefined
    const { reason: _previousReason, ...rest } = baseChoice
    const choice: RuntimeChoice = {
      ...rest,
      status,
      ...(reason ? { reason } : {}),
      ...(result.agentInfo?.version ? { version: result.agentInfo.version } : {}),
    }
    const choices = snapshot.choices.some(item => item.id === choice.id)
      ? snapshot.choices.map(item => (item.id === choice.id ? choice : item))
      : [...snapshot.choices, choice]
    this.current = { detectedAt: new Date().toISOString(), choices }
    writeDetectionSnapshot(this.opts.home, this.current)
    return { ...result, choice }
  }

  /** 内置运行时没有 ACP 握手：重新解析命令、探测版本与依赖即可。 */
  private async checkBuiltin(id: string): Promise<{ ok: boolean; detail: string; choice?: RuntimeChoice }> {
    const choices = await this.builtinChoices()
    this.mergeChoices(choices)
    const choice = choices.find(item => item.id === id)
    if (!choice) return { ok: false, detail: `未知运行时：${id}` }
    const detail = choice.status === 'ready'
      ? `版本探测通过${choice.version ? `（${choice.version}）` : ''}`
      : choice.reason ?? `运行时状态：${choice.status}`
    return {
      ok: choice.status === 'ready' || choice.status === 'unverified',
      detail,
      choice,
    }
  }

  /** 把单个/一批 choice 合并回快照，保留其它运行时的探测结果。 */
  private mergeChoices(choices: RuntimeChoice[]): void {
    const snapshot = this.current ?? { detectedAt: new Date().toISOString(), choices: [] }
    const merged = new Map(snapshot.choices.map(item => [item.id, item]))
    for (const choice of choices) merged.set(choice.id, choice)
    this.current = { detectedAt: new Date().toISOString(), choices: [...merged.values()] }
    writeDetectionSnapshot(this.opts.home, this.current)
  }

  startInstall(idOrRuntimeId: string, opts: { version?: string } = {}): { jobId: string } {
    const agent = acpAgentOf(idOrRuntimeId)
    if (!agent) throw new InstallStartError('unknown-agent', `未知 ACP Agent: ${idOrRuntimeId}`)
    if (!agent.package) throw new InstallStartError('not-installable', `${agent.label} 不支持由 ra 在线安装`)

    const active = this.activeByAgent.get(agent.id)
    if (active) {
      const running = this.jobs.get(active)
      if (running && running.status === 'running') {
        throw new InstallStartError('busy', `${agent.label} 正在安装（job ${active}）`)
      }
    }

    const job: InstallJob = {
      id: randomUUID(),
      agentId: agent.id,
      runtimeId: agent.runtimeId,
      status: 'running',
      phase: 'queued',
      startedAt: new Date().toISOString(),
      lines: [],
    }
    this.jobs.set(job.id, job)
    this.activeByAgent.set(agent.id, job.id)

    void (async () => {
      job.phase = 'installing'
      const result = await installAcpAgent({
        home: this.opts.home,
        agentId: agent.id,
        ...(opts.version ? { version: opts.version } : {}),
        env: this.env,
        onLine: line => {
          job.lines.push(line)
          if (job.lines.length > 200) job.lines.splice(0, job.lines.length - 200)
        },
      })
      if (result.ok) {
        job.phase = 'verifying'
        const snapshot = await this.detect().catch(() => this.current)
        job.status = 'ok'
        job.phase = 'succeeded'
        job.version = result.version
        job.choice = snapshot?.choices.find(choice => choice.id === agent.runtimeId)
      } else {
        job.status = 'failed'
        job.phase = 'failed'
        job.error = result.error
      }
      job.finishedAt = new Date().toISOString()
      this.activeByAgent.delete(agent.id)
    })()

    return { jobId: job.id }
  }

  installJob(jobId: string): InstallJob | null {
    return this.jobs.get(jobId) ?? null
  }
}