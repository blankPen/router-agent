import { spawn } from 'node:child_process';
/** 用 child_process 执行绑定到 `bin` 的命令。 */
export function realRunner(bin) {
    return {
        run(argv, opts = {}) {
            return new Promise(resolve => {
                const child = spawn(bin, argv, {
                    cwd: opts.cwd,
                    env: opts.env ?? process.env,
                    stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
                });
                let stdout = '';
                let stderr = '';
                const timer = opts.timeoutMs
                    ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
                    : null;
                if (opts.input !== undefined) {
                    child.stdin?.end(opts.input);
                }
                child.stdout.on('data', chunk => { stdout += String(chunk); });
                child.stderr.on('data', chunk => { stderr += String(chunk); });
                child.on('error', error => {
                    if (timer)
                        clearTimeout(timer);
                    resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` });
                });
                child.on('close', code => {
                    if (timer)
                        clearTimeout(timer);
                    resolve({ code: code ?? 1, stdout, stderr });
                });
            });
        },
    };
}
//# sourceMappingURL=process.js.map