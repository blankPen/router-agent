import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

/** Codex App Server 的 JSON-RPC 错误；协议省略了 `jsonrpc` 字段。 */
export class CodexProtocolError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'CodexProtocolError'
    this.code = code
    this.data = data
  }
}

export interface CodexAppClientOptions {
  command: string
  args?: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  onNotification?: (method: string, params: unknown) => void
  /** 服务端主动发来的审批/用户输入请求；返回 JSON-RPC result。 */
  onRequest?: (method: string, params: unknown) => Promise<unknown>
  onExit?: (code: number | null, signal: NodeJS.Signals | null, stderr: string) => void
  maxStderrBytes?: number
  maxLineBytes?: number
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: NodeJS.Timeout
}

/**
 * Codex App Server 的 stdio 客户端。
 *
 * 协议是换行分隔的 JSON-RPC 2.0（JSONL），但消息里通常省略 `"jsonrpc":"2.0"`；
 * 请求/响应按 id 匹配，通知没有 id，服务端也可以反向发请求（审批、用户输入）。
 */
export class CodexAppClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, PendingRequest>()
  private readonly maxStderrBytes: number
  private readonly maxLineBytes: number
  private buffer = ''
  private nextId = 1
  private closed = false
  private stderr = ''
  private exitCode: number | null = null
  private exitSignal: NodeJS.Signals | null = null
  readonly pid: number | undefined

  constructor(private readonly opts: CodexAppClientOptions) {
    this.maxStderrBytes = opts.maxStderrBytes ?? 8_192
    this.maxLineBytes = opts.maxLineBytes ?? 4 * 1024 * 1024
    this.child = spawn(opts.command, opts.args ?? [], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.pid = this.child.pid
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-this.maxStderrBytes)
    })
    this.child.on('error', error => {
      this.closed = true
      this.failAll(error)
      this.opts.onExit?.(null, null, this.stderr)
    })
    this.child.on('close', (code, signal) => {
      this.exitCode = code
      this.exitSignal = signal
      this.closed = true
      this.failAll(new Error(`Codex app-server 已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`))
      this.opts.onExit?.(code, signal, this.stderr)
    })
  }

  get alive(): boolean {
    return !this.closed && this.child.exitCode === null && this.child.signalCode === null
  }

  get stderrTail(): string {
    return this.stderr
  }

  get exit(): { code: number | null; signal: NodeJS.Signals | null } {
    return { code: this.exitCode, signal: this.exitSignal }
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.alive) return Promise.reject(new Error('Codex app-server 进程不可用'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = { resolve: value => resolve(value as T), reject }
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(String(id))
          reject(new CodexProtocolError(-32001, `Codex 请求超时: ${method}`))
        }, timeoutMs)
      }
      this.pending.set(String(id), entry)
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    if (!this.alive) return
    this.write(params === undefined ? { method } : { method, params })
  }

  respond(id: number | string, result: unknown): void {
    if (!this.alive) return
    this.write({ id, result })
  }

  respondError(id: number | string, code: number, message: string, data?: unknown): void {
    if (!this.alive) return
    this.write({ id, error: { code, message, ...(data === undefined ? {} : { data }) } })
  }

  /** 结束 stdin 并终止子进程；幂等。 */
  async close(graceMs = 200): Promise<void> {
    if (this.closed) return
    try { this.child.stdin.end() } catch { /* stdin 已关闭 */ }
    await delay(graceMs)
    if (this.child.exitCode === null) this.child.kill('SIGTERM')
    await delay(300)
    if (this.child.exitCode === null) this.child.kill('SIGKILL')
    this.closed = true
    this.failAll(new Error('Codex app-server 连接已关闭'))
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) {
        if (this.buffer.length > this.maxLineBytes) {
          this.buffer = ''
          this.failAll(new CodexProtocolError(-32700, 'Codex 单行消息超过上限'))
        }
        return
      }
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) this.onLine(line)
    }
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>
    try {
      const parsed = JSON.parse(line) as unknown
      if (!parsed || typeof parsed !== 'object') return
      message = parsed as Record<string, unknown>
    } catch {
      // Codex 可能把日志写到 stdout；非 JSON 输出忽略。
      return
    }
    const method = typeof message.method === 'string' ? message.method : undefined
    const hasId = typeof message.id === 'number' || typeof message.id === 'string'
    if (method && hasId) {
      const id = message.id as number | string
      Promise.resolve(this.opts.onRequest?.(method, message.params))
        .then(result => this.respond(id, result ?? {}))
        .catch(error => {
          const code = error instanceof CodexProtocolError ? error.code : -32603
          const text = error instanceof Error ? error.message : String(error)
          this.respondError(id, code, text)
        })
      return
    }
    if (method) {
      this.opts.onNotification?.(method, message.params)
      return
    }
    if (hasId) {
      const key = String(message.id)
      const entry = this.pending.get(key)
      if (!entry) return
      this.pending.delete(key)
      if (entry.timer) clearTimeout(entry.timer)
      if (message.error) {
        const error = message.error as Record<string, unknown>
        entry.reject(new CodexProtocolError(
          typeof error.code === 'number' ? error.code : -32603,
          typeof error.message === 'string' ? error.message : 'Codex 请求失败',
          error.data,
        ))
      } else {
        entry.resolve(message.result)
      }
    }
  }

  private write(message: Record<string, unknown>): void {
    if (!this.alive) return
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`)
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}