import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

/** ACP（Agent Client Protocol）v1 的 stdio JSON-RPC 客户端。 */
export class AcpProtocolError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'AcpProtocolError'
    this.code = code
    this.data = data
  }
}

export interface AcpConnectionOptions {
  command: string
  args?: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Agent 主动发来的通知（session/update 等）。 */
  onNotification?: (method: string, params: unknown) => void
  /** Agent 主动发来的请求（权限、文件、终端等）；返回 JSON-RPC result。 */
  onRequest?: (method: string, params: unknown) => Promise<unknown>
  /** 进程退出；stderr 保留尾部，便于诊断。 */
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
 * 与一个 ACP Agent 子进程通信。
 *
 * ACP 的消息是换行分隔的 JSON-RPC 2.0（JSONL）：stdout 解析，stdin 写入。
 * 请求带 id，响应按 id 匹配；通知没有 id；Agent 也可以反向发请求。
 */
export class AcpConnection {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, PendingRequest>()
  private readonly maxStderrBytes: number
  private readonly maxLineBytes: number
  private buffer = ''
  private nextId = 1
  private closed = false
  private stderr = ''
  private exitCode: number | null = null
  private exitSignal: NodeJS.Signals | null = null
  readonly pid: number | undefined

  constructor(private readonly opts: AcpConnectionOptions) {
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
      this.failAll(new Error(`ACP agent 已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`))
      this.opts.onExit?.(code, signal, this.stderr)
    })
  }

  /** 进程是否仍可写。 */
  get alive(): boolean {
    return !this.closed && this.child.exitCode === null && this.child.signalCode === null
  }

  get stderrTail(): string {
    return this.stderr
  }

  get exit(): { code: number | null; signal: NodeJS.Signals | null } {
    return { code: this.exitCode, signal: this.exitSignal }
  }

  /** 发请求并等待响应；timeoutMs=0 表示不设超时（用于 session/prompt）。 */
  request<T = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.alive) return Promise.reject(new Error('ACP agent 进程不可用'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = { resolve: value => resolve(value as T), reject }
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new AcpProtocolError(-32001, `ACP 请求超时: ${method}`))
        }, timeoutMs)
      }
      this.pending.set(id, entry)
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    if (!this.alive) return
    this.write({ jsonrpc: '2.0', method, params })
  }

  respond(id: number, result: unknown): void {
    if (!this.alive) return
    this.write({ jsonrpc: '2.0', id, result })
  }

  respondError(id: number, code: number, message: string): void {
    if (!this.alive) return
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  /** 结束 stdin 并终止子进程；幂等。 */
  async close(graceMs = 200): Promise<void> {
    if (this.closed) return
    try {
      this.child.stdin.end()
    } catch {
      // stdin 已关闭时忽略。
    }
    await delay(graceMs)
    if (this.child.exitCode === null) this.child.kill('SIGTERM')
    await delay(300)
    if (this.child.exitCode === null) this.child.kill('SIGKILL')
    this.closed = true
    this.failAll(new Error('ACP agent 连接已关闭'))
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) {
        if (this.buffer.length > this.maxLineBytes) {
          this.buffer = ''
          this.failAll(new AcpProtocolError(-32700, 'ACP 单行消息超过上限'))
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
      // 非 JSON 输出（部分 CLI 会打日志到 stdout）忽略。
      return
    }
    const method = typeof message.method === 'string' ? message.method : undefined
    const hasId = typeof message.id === 'number'
    if (method && hasId) {
      const id = message.id as number
      Promise.resolve(this.opts.onRequest?.(method, message.params))
        .then(result => this.respond(id, result ?? {}))
        .catch(error => {
          const code = error instanceof AcpProtocolError ? error.code : -32603
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
      const id = message.id as number
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      if (entry.timer) clearTimeout(entry.timer)
      if (message.error) {
        const error = message.error as Record<string, unknown>
        entry.reject(new AcpProtocolError(
          typeof error.code === 'number' ? error.code : -32603,
          typeof error.message === 'string' ? error.message : 'ACP 请求失败',
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