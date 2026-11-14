/**
 * 节点守护进程：跑在一台远端电脑上。
 *
 * 它主动连回中心取任务，用本机的 runtime 执行，再把执行结果回传中心；
 * 被调度设备上不需要开任何入站端口。
 */
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Assignment, Attachment, Ticket } from '#core/model.js'
import type { CenterToNodeMessage, NodeProject, NodeTask } from '#core/node.js'
import { errorMessage, noopLogger, type Logger } from '#infra/logger.js'
import type { InboundMessage, WorkerContext, WorkerRef } from '#runtime/port.js'
import type { RuntimeRegistry } from '#runtime/registry.js'
import { buildWorkerContractText, ensureWorkerSkillDir, workerSkillSnapshot } from '#runtime/spec/index.js'
import { ReportPoller } from '#runtime/report-poller.js'
import { projectsForRuntime, type AppConfig } from '../config.js'
import type { NodeAgentLink } from './link.js'

export interface NodeAgentOptions {
  home: string
  config: AppConfig
  /** 与中心的链路。 */
  link: NodeAgentLink
  /** 本机运行时注册表；节点用默认运行时执行任务。 */
  runtimes: RuntimeRegistry
  logger?: Logger
  /** 中心长轮询的等待时长。 */
  pollTimeoutMs?: number
  /** 本机接收 worker 上报的端口；0 表示不监听。 */
  reportPort?: number
  /** 轮询失败后的退避等待（毫秒）。 */
  retryDelayMs?: number
}

interface NodeWorker {
  handle: string
  workdir: string
}

const DEFAULT_POLL_TIMEOUT_MS = 25_000
const DEFAULT_RETRY_DELAY_MS = 3_000

export class NodeAgent {
  private readonly home: string
  private readonly config: AppConfig
  private readonly link: NodeAgentLink
  private readonly runtimes: RuntimeRegistry
  private readonly logger: Logger
  private readonly pollTimeoutMs: number
  private readonly retryDelayMs: number
  private readonly reportPort: number | undefined
  private readonly workers = new Map<string, NodeWorker>()
  private readonly poller: ReportPoller
  private readonly projects: NodeProject[]
  private stopped = false
  private reportServer: Server | null = null
  private boundPort = 0

  constructor(opts: NodeAgentOptions) {
    this.home = opts.home
    this.config = opts.config
    this.link = opts.link
    this.runtimes = opts.runtimes
    this.logger = opts.logger ?? noopLogger
    this.pollTimeoutMs = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    this.reportPort = opts.reportPort
    this.projects = projectsForRuntime(opts.config, this.runtimes.default().id).map(project => ({
      name: project.name,
      path: project.repo,
    }))
    // worker 的 `ra reply` 走 HTTP 通道；连不上时会退回写 state.json，这里兜底捡起来。
    this.poller = new ReportPoller({
      workersDir: join(this.home, 'workers'),
      onState: state => {
        void this.forwardReport(state as unknown as Record<string, unknown>).catch(error => {
          this.logger.warn('node:state-forward-failed', { ticketId: state.ticketId, message: errorMessage(error) })
        })
      },
      onError: (ticketId, error) => {
        this.logger.warn('node:state-poll-failed', { ticketId, message: errorMessage(error) })
      },
    })
  }

  /** 本机对外声明的项目：逻辑名 + 本地绝对路径。 */
  advertisedProjects(): NodeProject[] {
    return this.projects
  }

  /** 连回中心、注册本机，然后一直取任务执行。 */
  async run(): Promise<void> {
    await this.listenForReports()
    const pollTimer = setInterval(() => this.poller.scan(), 1_000)
    pollTimer.unref()
    await this.register()
    while (!this.stopped) {
      try {
        const messages = await this.link.receive(this.pollTimeoutMs)
        for (const message of messages) await this.handleMessage(message)
      } catch (error) {
        if (this.stopped) break
        this.logger.warn('node:poll-failed', { message: errorMessage(error) })
        await delay(this.retryDelayMs)
      }
    }
  }

  stop(): void {
    this.stopped = true
    this.reportServer?.close()
    this.reportServer = null
  }

  /** 注册本机身份、项目与可用运行时。 */
  async register(): Promise<void> {
    const runtime = this.runtimes.default()
    const result = await this.link.send({
      kind: 'register',
      payload: {
        nodeId: this.config.nodes.nodeId,
        name: this.config.nodes.name || this.config.nodes.nodeId,
        runtimes: [runtime.id],
        projects: this.projects,
      },
    })
    if (result.status >= 400) {
      throw new Error(`中心拒绝节点注册(${result.status})：${JSON.stringify(result.body).slice(0, 200)}`)
    }
    this.logger.info('node:registered', {
      node: this.config.nodes.nodeId,
      runtime: runtime.id,
      projects: this.projects.map(project => project.name),
    })
  }

  /** 处理一条中心发来的消息。 */
  async handleMessage(message: CenterToNodeMessage): Promise<void> {
    if (message.kind === 'task') {
      await this.runTask(message.payload)
      return
    }
    if (message.kind === 'delivery') {
      await this.deliver(message.payload.ticketId, message.payload.inputs)
      return
    }
    if (message.kind === 'stop') {
      await this.stopWorker(message.payload.ticketId, message.payload.reason)
    }
  }

  /** 把 worker 的上报回传中心；返回中心的应答，worker 要看到拒绝原因。 */
  async forwardReport(payload: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    return this.link.send({ kind: 'report', payload: payload as never })
  }

  /** 回报失败结果；中心拒绝时只记日志，不能让任务处理本身崩掉。 */
  private async reportFailure(task: NodeTask, summary: string): Promise<void> {
    try {
      await this.forwardReport({
        ticketId: task.ticketId,
        assignmentId: task.assignmentId,
        state: 'failed',
        summary,
        ackedInputs: [],
      })
    } catch (error) {
      this.logger.warn('node:failure-report-failed', { ticketId: task.ticketId, message: errorMessage(error) })
    }
  }

  private async runTask(task: NodeTask): Promise<void> {
    const project = this.projects.find(item => item.name === task.project || item.path === task.project)
    if (!project) {
      this.logger.error('node:project-missing', { node: this.config.nodes.nodeId, project: task.project, ticketId: task.ticketId })
      await this.reportFailure(task, `设备 ${this.config.nodes.nodeId} 上没有项目 ${task.project}，无法执行。`)
      return
    }
    const workerDir = join(this.home, 'workers', task.ticketId)
    mkdirSync(workerDir, { recursive: true })
    const statePath = join(workerDir, 'state.json')
    const eventsPath = join(workerDir, 'events.log')
    const requestPath = join(workerDir, 'request.md')
    if (task.request) writeFileSync(requestPath, task.request, 'utf8')
    const attachments = this.writeAttachments(workerDir, task.attachments ?? [])
    const runtime = this.runtimes.default()
    const skillDir = this.config.worker.skill.mode === 'path' ? ensureWorkerSkillDir(this.home) : undefined
    const skill = skillDir ? workerSkillSnapshot(this.home) : undefined
    const contract = buildWorkerContractText({
      skillMode: this.config.worker.skill.mode,
      runtimeId: runtime.id,
      ticketId: task.ticketId,
      title: task.title,
      scope: task.scope,
      ...(task.request ? { request: task.request } : {}),
      ...(task.requestActorName ? { requestActorName: task.requestActorName } : {}),
      ...(task.requestAt ? { requestAt: task.requestAt } : {}),
      repo: project.path,
      branch: task.branch,
      workBranch: task.workBranch,
      workdir: '',
      statePath,
      eventsPath,
      workerDir,
      ...(skillDir ? { skillDir } : {}),
      ...(skill ? { skill: { name: skill.name, version: skill.version, sha256: skill.sha256 } } : {}),
      ...(task.request ? { requestPath } : {}),
      attachments,
      home: this.home,
    })
    const assignment: Assignment = {
      id: task.assignmentId,
      ticketId: task.ticketId,
      runtimeId: runtime.id,
      handle: '',
      workdir: '',
      status: 'running',
      startedAt: new Date().toISOString(),
    }
    const ctx: WorkerContext = {
      ticket: ticketOf(task, project.path, attachments),
      assignment,
      workdir: '',
      report: { statePath, eventsPath },
      brief: { ticketId: task.ticketId, title: task.title, scope: task.scope, workBranch: task.workBranch, contract },
      tools: this.config.worker.tools,
    }
    try {
      const started = await runtime.start(ctx)
      this.workers.set(task.ticketId, { handle: started.handle, workdir: started.workdir })
      this.logger.info('node:task-started', {
        node: this.config.nodes.nodeId,
        ticketId: task.ticketId,
        runtime: runtime.id,
        project: task.project,
      })
    } catch (error) {
      this.logger.error('node:task-failed', {
        node: this.config.nodes.nodeId,
        ticketId: task.ticketId,
        message: errorMessage(error),
      })
      await this.reportFailure(task, `设备 ${this.config.nodes.nodeId} 上启动 worker 失败：${errorMessage(error)}`)
    }
  }

  private async deliver(ticketId: string, inputs: Array<{ id: string; kind: InboundMessage['kind']; text: string }>): Promise<void> {
    const worker = this.workers.get(ticketId)
    if (!worker) {
      this.logger.warn('node:delivery-dropped', { node: this.config.nodes.nodeId, ticketId, reason: 'no-local-worker' })
      return
    }
    const ref: WorkerRef = { handle: worker.handle, ticketId, workdir: worker.workdir }
    await this.runtimes.default().deliver(ref, inputs)
    this.logger.info('node:delivered', { node: this.config.nodes.nodeId, ticketId, inputs: inputs.length })
  }

  private async stopWorker(ticketId: string, reason: string): Promise<void> {
    const worker = this.workers.get(ticketId)
    if (!worker) return
    try {
      await this.runtimes.default().stop({ handle: worker.handle, ticketId, workdir: worker.workdir }, reason)
    } catch (error) {
      this.logger.warn('node:stop-failed', { node: this.config.nodes.nodeId, ticketId, message: errorMessage(error) })
    }
    this.workers.delete(ticketId)
  }

  /** 把中心带来的附件写到本机 worker 目录，返回本机可读的路径。 */
  private writeAttachments(workerDir: string, attachments: NodeTask['attachments']): Attachment[] {
    if (!attachments || attachments.length === 0) return []
    const dir = join(workerDir, 'attachments')
    mkdirSync(dir, { recursive: true })
    const result: Attachment[] = []
    for (const attachment of attachments) {
      try {
        const path = join(dir, attachment.name)
        writeFileSync(path, Buffer.from(attachment.content, 'base64'))
        result.push({ path, mimeType: attachment.mimeType })
      } catch (error) {
        this.logger.warn('node:attachment-write-failed', { message: errorMessage(error) })
      }
    }
    return result
  }

  /**
   * 本机监听 worker 的上报端口。
   *
   * worker 的 `ra reply` 默认打本机 Router；节点上没有 Router，
   * 这里接住它并转给中心，worker 才能拿到「证据不足」这类拒绝原因。
   * 返回实际监听的端口；0 表示没监听。
   */
  async listenForReports(): Promise<number> {
    const port = this.reportPort ?? this.config.server.port
    if (this.reportServer) return this.boundPort
    const server = createServer((req, res) => {
      void this.handleReport(req, res)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => resolve())
      })
    } catch (error) {
      // 端口被占用不致命：worker 的 ra reply 会退回写 state.json，节点照样能捡起来。
      this.logger.warn('node:report-listen-failed', { port, message: errorMessage(error) })
      server.close()
      return 0
    }
    this.reportServer = server
    const address = server.address()
    this.boundPort = typeof address === 'object' && address ? address.port : port
    this.logger.info('node:report-listening', { node: this.config.nodes.nodeId, port: this.boundPort })
    return this.boundPort
  }

  private async handleReport(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (path !== '/api/reports' || req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not-found' }))
      return
    }
    const body = await readJson(req)
    try {
      // 中心的判定原样回给 worker：证据不足时它要知道自己要补什么。
      const result = await this.forwardReport(body)
      res.writeHead(result.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result.body ?? { ok: true }))
    } catch (error) {
      this.logger.error('node:report-forward-failed', { message: errorMessage(error) })
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'center-unreachable', message: errorMessage(error) }))
    }
  }
}

/** 节点侧工单对象：运行时只读 id / title / repo / branch。 */
function ticketOf(task: NodeTask, repo: string, attachments: Attachment[]): Ticket {
  return {
    id: task.ticketId,
    title: task.title,
    threadId: '',
    source: 'node',
    chatId: '',
    mandateId: '',
    stage: 'running',
    repo,
    branch: task.branch,
    ...(attachments.length > 0 ? { attachments } : {}),
    prNumber: 0,
    prUrl: '',
    prState: 'none',
    createdAt: '',
    updatedAt: '',
  }
}

async function readJson(req: import('node:http').IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    // 请求体不是合法 JSON：按空对象处理，交给校验层统一报错。
    return {}
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
