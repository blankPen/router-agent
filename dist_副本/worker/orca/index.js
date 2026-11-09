import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildWorkerPrompt } from '../spec/index.js';
import { agentLaunch, terminalClose, terminalList, terminalSend, worktreeCreate, worktreeRemove, worktreeShow, } from './commands.js';
/** 解析 `orca worktree create --json` 的返回；不同 Orca 版本字段不同。 */
export function parseCreateResult(stdout) {
    let json;
    try {
        json = JSON.parse(stdout);
    }
    catch {
        throw new Error(`orca:invalid-json: ${stdout.slice(0, 200)}`);
    }
    const root = json;
    if (root.ok === false) {
        throw new Error(`orca:create-failed: ${root.error?.message ?? JSON.stringify(root).slice(0, 200)}`);
    }
    const result = (root.result ?? root);
    const handle = result.launch?.outcome?.handle ?? result.agentTerminalHandle ?? result.terminalHandle ?? result.terminal?.handle;
    if (!handle)
        throw new Error(`orca:create-failed: 返回中没有 terminal handle: ${stdout.slice(0, 200)}`);
    const workdir = result.worktree?.path ?? result.worktreePath ?? result.path;
    return workdir ? { handle: String(handle), workdir: String(workdir) } : { handle: String(handle) };
}
export class OrcaRuntime {
    id = 'orca';
    runner;
    workersDir;
    spec;
    constructor(opts) {
        this.runner = opts.runner;
        this.workersDir = opts.workersDir;
        this.spec = opts.spec;
    }
    async start(ctx) {
        const statePath = join(this.workersDir, ctx.ticket.id, 'state.json');
        const eventsPath = join(this.workersDir, ctx.ticket.id, 'events.log');
        const name = sanitize(`ra-${ctx.ticket.id}`);
        // 每张工单自带 repo/branch（多项目派工）；缺了说明是脏数据，直接报错不猜。
        const repo = ctx.ticket.repo;
        const branch = ctx.ticket.branch;
        if (!repo)
            throw new Error('orca:missing-repo: 工单没有指定仓库，拒绝创建 worktree');
        if (!branch)
            throw new Error('orca:missing-branch: 工单没有指定起始分支，拒绝创建 worktree');
        const prompt = buildWorkerPrompt({
            mode: this.spec,
            ticket: ctx.ticket,
            mandateScope: ctx.ticket.title,
            statePath,
            eventsPath,
            repo,
            branch,
            workdir: ctx.workdir,
        });
        const res = await this.run(worktreeCreate({ repo, name, prompt, ...(branch ? { baseBranch: branch } : {}) }));
        const parsed = parseCreateResult(res.stdout);
        const workdir = parsed.workdir ?? ctx.workdir;
        this.writeMeta(ctx, { handle: parsed.handle, workdir, statePath, eventsPath, repo, branch });
        return { handle: parsed.handle, workdir };
    }
    async deliver(handle, inputs) {
        for (const input of inputs) {
            if (!input.text.trim())
                continue;
            await this.run(terminalSend(handle, renderInput(input)));
        }
    }
    async registerContext(handle, items) {
        const text = renderContext(items);
        if (!text)
            return;
        await this.run(terminalSend(handle, text));
    }
    async stop(handle, reason) {
        void reason;
        await this.run(terminalClose(handle));
    }
    async inspect(handle) {
        const res = await this.run(terminalList());
        const parsed = parseJsonOrThrow(res.stdout);
        const terminals = extractTerminals(parsed);
        const found = terminals.find(t => String(t.handle) === handle);
        return found ? normalizeTerminal(found) : null;
    }
    async inspectWorktree(selector) {
        const res = await this.run(worktreeShow(selector));
        const parsed = parseJsonOrThrow(res.stdout);
        const result = parsed.result ?? parsed;
        return (result.worktree ?? result);
    }
    async removeWorktree(selector) {
        await this.run(worktreeRemove(selector));
    }
    async relaunchAgent(worktree, prompt) {
        await this.run(agentLaunch({ worktree, prompt }));
    }
    async run(argv) {
        const res = await this.runner.run(argv);
        if (res.code !== 0) {
            throw new Error(`orca:command-failed(${argv[0]} ${argv[1]}): code=${res.code} ${res.stderr.slice(0, 300)}`);
        }
        return res;
    }
    writeMeta(ctx, extra) {
        const dir = join(this.workersDir, ctx.ticket.id);
        mkdirSync(dir, { recursive: true });
        const metaPath = join(dir, 'meta.json');
        const meta = {
            ticketId: ctx.ticket.id,
            assignmentId: ctx.assignment.id,
            handle: extra.handle,
            workdir: extra.workdir,
            statePath: extra.statePath,
            eventsPath: extra.eventsPath,
            repo: extra.repo,
            branch: extra.branch,
            runtime: this.id,
            startedAt: new Date().toISOString(),
        };
        writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
        if (!existsSync(extra.eventsPath))
            writeFileSync(extra.eventsPath, '', 'utf8');
        mkdirSync(dirname(metaPath), { recursive: true });
    }
}
function sanitize(value) {
    return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60);
}
/**
 * 投递时带上输入 id：worker 只有看到 id 才能写进 acked_inputs，Router 才不会重投。
 */
export function renderInput(input) {
    return `【Router 输入 ${input.id}】\n${input.text}`;
}
function renderContext(items) {
    const lines = [];
    for (const item of items) {
        if (item.kind === 'system-prompt')
            lines.push(item.text);
        else if (item.kind === 'file')
            lines.push(`# 文件 ${item.path}\n${item.content}`);
        else if (item.kind === 'env')
            lines.push(`${item.key}=${item.value}`);
        else
            lines.push(`# 目录 ${item.path}`);
    }
    return lines.join('\n\n');
}
function parseJsonOrThrow(stdout) {
    try {
        return JSON.parse(stdout);
    }
    catch {
        throw new Error(`orca:invalid-json: ${stdout.slice(0, 200)}`);
    }
}
function extractTerminals(parsed) {
    const root = parsed;
    const result = root.result ?? root;
    const list = result.terminals ?? result.rows ?? result.items ?? (Array.isArray(result) ? result : []);
    return Array.isArray(list) ? list : [];
}
function normalizeTerminal(raw) {
    return {
        handle: String(raw.handle ?? ''),
        connected: Boolean(raw.connected),
        writable: Boolean(raw.writable),
        orphaned: Boolean(raw.orphaned),
        lastOutputAt: toIsoTime(raw.lastOutputAt),
        worktreePath: String(raw.worktreePath ?? ''),
        branch: String(raw.branch ?? ''),
    };
}
/** Orca 的 lastOutputAt 实测是毫秒时间戳数字，也兼容 ISO 字符串与秒级时间戳。 */
export function toIsoTime(value) {
    if (value === null || value === undefined || value === '')
        return '';
    if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
        const n = Number(value);
        const ms = n > 1e12 ? n : n > 1e9 ? n * 1000 : 0;
        return ms > 0 ? new Date(ms).toISOString() : '';
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}
//# sourceMappingURL=index.js.map