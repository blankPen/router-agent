import { spawn } from 'node:child_process'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
  /** 被信号终止时的信号名（SIGKILL 等）；正常退出为 null。 */
  signal?: string | null
  /** 是否因为超时被 kill —— 与「命令自己报错退出」要区分开。 */
  timedOut?: boolean
}

/** argv 不含二进制名：runner 已绑定到某个可执行文件。 */
export interface CommandRunner {
  run(argv: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string }): Promise<CommandResult>
}

/** 用 child_process 执行绑定到 `bin` 的命令。 */
export function realRunner(bin: string): CommandRunner {
  return {
    run(argv, opts = {}) {
      return new Promise(resolve => {
        const child = spawn(bin, argv, {
          cwd: opts.cwd,
          env: opts.env ?? process.env,
          stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        let timedOut = false
        const timer = opts.timeoutMs
          ? setTimeout(() => {
              timedOut = true
              child.kill('SIGKILL')
            }, opts.timeoutMs)
          : null
        if (opts.input !== undefined) {
          child.stdin?.end(opts.input)
        }
        child.stdout!.on('data', chunk => { stdout += String(chunk) })
        child.stderr!.on('data', chunk => { stderr += String(chunk) })
        child.on('error', error => {
          if (timer) clearTimeout(timer)
          resolve({ code: 127, stdout, stderr: `${stderr}${error.message}`, signal: null, timedOut })
        })
        child.on('close', code => {
          if (timer) clearTimeout(timer)
          resolve({
            code: code ?? 1,
            stdout,
            stderr,
            signal: child.signalCode ?? null,
            timedOut,
          })
        })
      })
    },
  }
}
