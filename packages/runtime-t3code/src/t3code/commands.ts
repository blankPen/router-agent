/**
 * T3 Code CLI 的 argv 构造与输出解析。
 *
 * T3 Code（https://github.com/pingdotgg/t3code）是编码 Agent 的控制面：
 * 本机跑一个 server，手机 / 网页 / 桌面端连它，Agent 在 server 侧跑。
 * ra 只用它的 `t3 thread` 子命令做非交互派工：
 *
 * - `thread start`：新建线程并投第一条消息，**立即返回**（Agent 在 server 侧继续跑）；
 * - `thread send`：往已有线程投追问，忙时排队，不打断当前轮；
 * - `thread show`：读线程状态与最近消息。
 *
 * CLI 约定：成功时把结果 JSON 打到 stdout；失败时把一行原因打到 stderr 并以 1 退出；
 * `thread start/send --wait` 在需要人工回答时以 2 退出。
 *
 * stdout 不保证是纯 JSON：CLI 启动时会打印迁移日志。所以解析时要从后往前找 JSON 行，
 * 并且统一带 `--log-level none` 让日志闭嘴。
 */
import type { CommandRunner } from '@router-agent/infra/process.js'

/** T3 Code 官方下载页；面板的安装引导指向这里。 */
export const T3_INSTALL_URL = 'https://t3.codes/download'
export const T3_INSTALL_HINT = '安装 T3 Code 桌面端，或 `npm i -g t3`；并确保 t3 CLI 在 PATH 中'

/** 探测服务端是否在跑时用的假线程 id：只要服务端答话就会回「线程不存在」。 */
export const PROBE_THREAD_ID = 'mcp:00000000-0000-0000-0000-000000000000'

/** 服务端没起时 CLI 的两类报错文案（不同版本措辞略有差别）。 */
const SERVER_DOWN_PATTERN = /No running T3 Code server|Could not reach the T3 Code server|server is not running/i

export interface T3Flags {
  /** T3 数据目录（等价 T3CODE_HOME）；为空表示用 T3 自己的默认目录。 */
  baseDir?: string
}

/** 公共参数：关日志保证 stdout 只有 JSON；需要时带上数据目录。 */
export function t3Flags(flags: T3Flags = {}): string[] {
  return ['--log-level', 'none', ...(flags.baseDir ? ['--base-dir', flags.baseDir] : [])]
}

export interface ThreadStartOptions extends T3Flags {
  /** 项目 id 或项目目录；ra 传 worktree 目录，Agent 的 cwd 就是它。 */
  project: string
  message: string
  title?: string
  /** T3 provider 实例 id，例如 codex / claude。 */
  provider?: string
  /** 模型；与 provider 一起传。 */
  model?: string
}

export function threadStart(opts: ThreadStartOptions): string[] {
  return [
    'thread', 'start', opts.project, opts.message,
    ...(opts.title ? ['--title', opts.title] : []),
    ...(opts.provider ? ['--provider', opts.provider] : []),
    ...(opts.model ? ['--model', opts.model] : []),
    '--json',
    ...t3Flags(opts),
  ]
}

export interface ThreadSendOptions extends T3Flags {
  thread: string
  message: string
  /** 等这一轮跑完再返回；CLI 在需要人工回答时以 2 退出。 */
  wait?: boolean
}

export function threadSend(opts: ThreadSendOptions): string[] {
  return [
    'thread', 'send', opts.thread, opts.message,
    ...(opts.wait ? ['--wait'] : []),
    '--json',
    ...t3Flags(opts),
  ]
}

export interface ThreadShowOptions extends T3Flags {
  thread: string
  /** 读最近多少条消息。 */
  messages?: number
}

export function threadShow(opts: ThreadShowOptions): string[] {
  return [
    'thread', 'show', opts.thread,
    ...(opts.messages ? ['--messages', String(opts.messages)] : []),
    '--json',
    ...t3Flags(opts),
  ]
}

export interface ThreadListOptions extends T3Flags {
  project: string
}

export function threadList(opts: ThreadListOptions): string[] {
  return ['thread', 'list', '--project', opts.project, '--json', ...t3Flags(opts)]
}

export interface ProjectAddOptions extends T3Flags {
  path: string
  title?: string
}

/** 把 worktree 目录登记成 T3 项目；已存在时 CLI 会报错，调用方按幂等处理。 */
export function projectAdd(opts: ProjectAddOptions): string[] {
  return [
    'project', 'add', opts.path,
    ...(opts.title ? ['--title', opts.title] : []),
    ...t3Flags(opts),
  ]
}

export interface ProjectRemoveOptions extends T3Flags {
  project: string
  /** 连同线程一起删；工单收尾时用它清掉 ra 建的临时项目。 */
  force?: boolean
}

export function projectRemove(opts: ProjectRemoveOptions): string[] {
  return [
    'project', 'remove', opts.project,
    ...(opts.force ? ['--force'] : []),
    ...t3Flags(opts),
  ]
}

/** 拉起服务端；只在服务端缺席时用。 */
export function serve(opts: T3Flags & { port?: number } = {}): string[] {
  return [
    'serve', '--no-browser',
    ...(opts.port ? ['--port', String(opts.port)] : []),
    ...t3Flags(opts),
  ]
}

export function version(flags: T3Flags = {}): string[] {
  return ['--version', ...t3Flags(flags)]
}

export interface T3ThreadStartResult {
  threadId: string
  projectId: string
  runId: string | null
}

export interface T3ThreadSendResult {
  threadId: string
  messageId?: string
  runId: string | null
  /** started=已开跑；queued=线程忙，排队中。 */
  delivery?: string
  status?: string
}

export interface T3ThreadMessage {
  role: 'user' | 'assistant'
  runId: string | null
  text: string
}

export interface T3ThreadSummary {
  threadId: string
  projectId: string
  title: string
  /** idle / running / waiting / completed / failed / cancelled / interrupted … */
  status: string
  providerInstanceId: string
  model: string
  activeRunId: string | null
  latestRunId: string | null
  pendingRequestCount: number
  worktreePath: string | null
  branch: string | null
  createdAt: string
  updatedAt: string
  itemCount: number
}

export interface T3ThreadShowResult {
  thread: T3ThreadSummary
  messages: T3ThreadMessage[]
}

/**
 * 从 stdout 里取 JSON。
 *
 * CLI 正常只打一行 JSON，但启动迁移日志会混在前面，所以从后往前找第一行能解析的 JSON。
 */
export function extractJson(stdout: string): unknown | null {
  const text = stdout.trim()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    // 继续按行找。
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim()
    if (!line.startsWith('{') && !line.startsWith('[')) continue
    try {
      return JSON.parse(line) as unknown
    } catch {
      // 换上一行。
    }
  }
  return null
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringOf(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberOf(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 解析 `t3 thread start --json` 的输出。 */
export function parseThreadStart(stdout: string): T3ThreadStartResult | null {
  const record = recordOf(extractJson(stdout))
  if (!record) return null
  const threadId = stringOf(record, 'threadId')
  if (!threadId) return null
  return {
    threadId,
    projectId: stringOf(record, 'projectId') ?? '',
    runId: stringOf(record, 'runId'),
  }
}

/** 解析 `t3 thread send --json` 的输出。 */
export function parseThreadSend(stdout: string): T3ThreadSendResult | null {
  const record = recordOf(extractJson(stdout))
  if (!record) return null
  const threadId = stringOf(record, 'threadId')
  if (!threadId) return null
  return {
    threadId,
    ...(stringOf(record, 'messageId') ? { messageId: stringOf(record, 'messageId')! } : {}),
    runId: stringOf(record, 'runId'),
    ...(stringOf(record, 'delivery') ? { delivery: stringOf(record, 'delivery')! } : {}),
    ...(stringOf(record, 'status') ? { status: stringOf(record, 'status')! } : {}),
  }
}

/** 解析 `t3 thread show --json` 的输出。 */
export function parseThreadShow(stdout: string): T3ThreadShowResult | null {
  const record = recordOf(extractJson(stdout))
  if (!record) return null
  const thread = recordOf(record.thread)
  if (!thread) return null
  const threadId = stringOf(thread, 'threadId')
  if (!threadId) return null
  const messages = Array.isArray(record.messages)
    ? record.messages.flatMap(item => {
      const message = recordOf(item)
      if (!message) return []
      const role = stringOf(message, 'role')
      if (role !== 'user' && role !== 'assistant') return []
      return [{
        role: role as 'user' | 'assistant',
        runId: stringOf(message, 'runId'),
        text: typeof message.text === 'string' ? message.text : '',
      }]
    })
    : []
  return {
    thread: {
      threadId,
      projectId: stringOf(thread, 'projectId') ?? '',
      title: stringOf(thread, 'title') ?? '',
      status: stringOf(thread, 'status') ?? 'unknown',
      providerInstanceId: stringOf(thread, 'providerInstanceId') ?? '',
      model: stringOf(thread, 'model') ?? '',
      activeRunId: stringOf(thread, 'activeRunId'),
      latestRunId: stringOf(thread, 'latestRunId'),
      pendingRequestCount: numberOf(thread, 'pendingRequestCount'),
      worktreePath: stringOf(thread, 'worktreePath'),
      branch: stringOf(thread, 'branch'),
      createdAt: stringOf(thread, 'createdAt') ?? '',
      updatedAt: stringOf(thread, 'updatedAt') ?? '',
      itemCount: numberOf(thread, 'itemCount'),
    },
    messages,
  }
}

/** CLI 报「服务端没起」时返回 true；其它报错说明服务端答了话。 */
export function isServerDown(text: string): boolean {
  return SERVER_DOWN_PATTERN.test(text)
}

/** CLI 报「线程没了」时返回 true。 */
export function isThreadGone(text: string): boolean {
  return /is no longer available|not found|unknown thread/i.test(text)
}

/** 把 CLI 的失败输出压成一行可读原因。 */
export function failureText(stdout: string, stderr: string): string {
  const text = `${stderr}\n${stdout}`.trim()
  const line = text.split('\n').map(item => item.trim()).find(item => item.length > 0) ?? ''
  return line.slice(0, 300)
}

/** 跑一条 t3 命令，返回原始结果；调用方自己判断退出码。 */
export function runT3(runner: CommandRunner, argv: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return runner.run(argv, opts)
}
