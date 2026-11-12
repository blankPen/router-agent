/**
 * 往「正在跑」的 Claude 后台会话里插一句话。
 *
 * Claude CLI 没有给后台会话提供「追加一轮输入」的命令：
 * - `--bg --resume` 在会话还活着时会复制出一个新会话（详见 AGENT-ADAPTER-DESIGN 附录 C）；
 * - `-p --resume` 会直接拒绝：「That session is running in the background…」；
 * - 唯一能进到同一会话、同一轮的通道是 `claude attach`：它把 TUI 接到后台会话上，
 *   在输入框里提交的文本会作为「用户在本轮中途发来的消息」交给当前回合。
 *
 * 这里刻意用非交互的方式驱动 attach：写文本 → 回车 → 等落盘 → 断开。
 * 结果必须由调用方用 transcript 校验，不能把「写进去了」当成「已经生效」。
 */
import { spawn } from 'node:child_process'

export interface AttachInjectOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** attach 的 TUI 启动等待，太短时首批按键会丢。 */
  readyMs?: number
  /** 文本写完到回车之间的等待；太短会被 TUI 当成粘贴。 */
  submitDelayMs?: number
  /** 回车后保持连接的时长，让 CLI 完成提交与落盘。 */
  settleMs?: number
}

export interface AttachInjectResult {
  ok: boolean
  /** 失败原因；ok=true 时为空。 */
  reason?: string
}

/**
 * 通过 attach 的输入框注入一条消息。
 *
 * 注意：这是对 TUI 的驱动，不是官方接口；调用方必须用会话记录校验是否真的收下，
 * 校验失败要退回「排队等本轮结束再 resume」的路径，不能吞掉输入。
 */
export function injectViaAttach(
  command: string,
  handle: string,
  text: string,
  opts: AttachInjectOptions = {},
): Promise<AttachInjectResult> {
  const readyMs = opts.readyMs ?? 6_000
  const submitDelayMs = opts.submitDelayMs ?? 2_500
  const settleMs = opts.settleMs ?? 6_000
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, ['attach', handle], {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        env: { ...(opts.env ?? process.env), TERM: 'xterm-256color' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, reason: error instanceof Error ? error.message : String(error) })
      return
    }

    let settled = false
    const timers: NodeJS.Timeout[] = []
    const finish = (result: AttachInjectResult): void => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      child.stdin?.end()
      child.kill()
      resolve(result)
    }
    child.on('error', error => finish({ ok: false, reason: error.message }))
    child.stdin?.on('error', error => finish({ ok: false, reason: error.message }))
    // attach 的输出只是 TUI 画面，丢弃即可；这里读走是为了避免管道写满。
    child.stdout?.resume()
    child.stderr?.resume()

    const send = (data: string): void => {
      try {
        child.stdin?.write(data)
      } catch (error) {
        finish({ ok: false, reason: error instanceof Error ? error.message : String(error) })
      }
    }

    timers.push(setTimeout(() => {
      // 输入框里可能残留上一次没提交的内容，先清行再写。
      send('\u0015')
      timers.push(setTimeout(() => send(text), 300))
      timers.push(setTimeout(() => send('\r'), 300 + submitDelayMs))
      timers.push(setTimeout(() => finish({ ok: true }), 300 + submitDelayMs + settleMs))
    }, readyMs))
  })
}
