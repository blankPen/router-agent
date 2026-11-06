import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { policyOf } from '../config.js';
import { noopSink, preview } from '../core/events.js';
export async function createApiServer(opts) {
    const clock = opts.clock ?? { now: () => new Date().toISOString() };
    const config = opts.config;
    const onEvent = opts.onEvent ?? noopSink;
    const server = createServer((req, res) => {
        handle(req, res).catch(error => {
            respond(res, 500, { error: 'internal', message: error instanceof Error ? error.message : String(error) });
        });
    });
    async function handle(req, res) {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;
        if (path === '/api/status' && req.method === 'GET') {
            const tickets = opts.store.listTickets({ limit: 500 });
            return respond(res, 200, {
                stage: 'running',
                backend: config.backend.default,
                tickets: {
                    open: tickets.filter(t => t.stage !== 'closed').length,
                    closed: tickets.filter(t => t.stage === 'closed').length,
                    byStage: groupByStage(tickets.map(t => t.stage)),
                },
                policy: { version: opts.engine.policy().version, acceptMode: opts.engine.policy().acceptMode },
                now: clock.now(),
            });
        }
        if (path === '/api/tickets' && req.method === 'GET') {
            const stage = url.searchParams.get('stage') ?? undefined;
            const limit = Number(url.searchParams.get('limit') ?? 200);
            return respond(res, 200, { tickets: opts.store.listTickets({ ...(stage ? { stage: stage } : {}), limit }) });
        }
        const detail = path.match(/^\/api\/tickets\/([^/]+)$/);
        if (detail && req.method === 'GET') {
            const ticket = opts.store.getTicket(detail[1]);
            if (!ticket)
                return respond(res, 404, { error: 'ticket-not-found' });
            return respond(res, 200, {
                ticket,
                mandate: opts.store.getMandate(ticket.mandateId),
                assignment: opts.store.latestAssignment(ticket.id),
                reports: opts.store.listReports(ticket.id, 20),
                inputs: opts.store.listInputs(ticket.id),
                attention: opts.store.getAttention(ticket.id),
            });
        }
        const action = path.match(/^\/api\/tickets\/([^/]+)\/(input|stop|assignment)$/);
        if (action) {
            const ticketId = action[1];
            const what = action[2];
            const body = req.method === 'POST' ? await readJson(req) : {};
            const ticket = opts.store.getTicket(ticketId);
            if (!ticket)
                return respond(res, 404, { error: 'ticket-not-found' });
            if (what === 'input' && req.method === 'POST') {
                const text = String(body.text ?? '').trim();
                if (!text)
                    return respond(res, 400, { error: 'text-required' });
                const kind = String(body.kind ?? 'followup');
                try {
                    const input = opts.engine.deliverInput(ticketId, { kind, text });
                    onEvent({ event: 'api:input', ticketId, inputId: input.id, kind, text: preview(text) });
                    return respond(res, 201, { input });
                }
                catch (error) {
                    return respond(res, 409, { error: error instanceof Error ? error.message : String(error) });
                }
            }
            if (what === 'stop' && req.method === 'POST') {
                const reason = String(body.reason ?? '面板停止');
                const stopped = opts.engine.stopTicket(ticketId, reason);
                onEvent({ event: 'api:stop', ticketId, reason: preview(reason) });
                opts.store.enqueueEffect({
                    id: `ef_stop_${ticketId}_${Date.now()}`,
                    key: `stop:${ticketId}`,
                    kind: 'stop-worker',
                    payload: { ticketId },
                    now: clock.now(),
                });
                return respond(res, 200, { ticket: stopped });
            }
            if (what === 'assignment' && req.method === 'POST') {
                const handle = String(body.handle ?? '');
                const workdir = String(body.workdir ?? '');
                if (!handle)
                    return respond(res, 400, { error: 'handle-required' });
                const assignment = opts.engine.startAssignment(ticketId, { backendId: config.backend.default, handle, workdir });
                return respond(res, 201, { assignment });
            }
            return respond(res, 405, { error: 'method-not-allowed' });
        }
        if (path === '/api/reports' && req.method === 'POST') {
            if (!opts.onReport)
                return respond(res, 501, { error: 'report-not-supported' });
            const body = (await readJson(req));
            const ticketId = String(body.ticketId ?? body.ticket_id ?? '');
            const ticket = opts.store.getTicket(ticketId);
            if (!ticket)
                return respond(res, 404, { error: 'ticket-not-found' });
            const assignment = (body.assignmentId ? opts.store.getAssignment(String(body.assignmentId)) : null) ?? opts.store.latestAssignment(ticketId);
            if (!assignment)
                return respond(res, 409, { error: 'no-assignment' });
            const state = String(body.state ?? '');
            if (!['progress', 'ready', 'blocked', 'failed', 'dropped', 'waiting'].includes(state)) {
                return respond(res, 400, { error: 'invalid-state' });
            }
            const summary = String(body.summary ?? '').trim();
            if (!summary)
                return respond(res, 400, { error: 'summary-required' });
            // worker 不传 turn 时按已有序号自增，避免同一 turn 的多次回答被幂等键吞掉。
            const latest = opts.store.latestReport(ticketId);
            const requestedTurn = Number(body.turn);
            const turn = Number.isFinite(requestedTurn) && requestedTurn >= 0 ? requestedTurn : (latest?.turn ?? 0) + 1;
            const reply = String(body.reply ?? legacyReply(body.deliverable) ?? '').trim();
            const payload = {
                ticketId,
                assignmentId: assignment.id,
                turn,
                state: state,
                summary,
                ...(body.humanAction ? { humanAction: String(body.humanAction) } : {}),
                prNumber: Number(body.prNumber ?? 0) || 0,
                prUrl: String(body.prUrl ?? ''),
                ...(reply ? { reply } : {}),
                ackedInputs: Array.isArray(body.ackedInputs) ? body.ackedInputs.map(String) : [],
                updatedAt: String(body.updatedAt ?? clock.now()),
            };
            await opts.onReport(payload);
            onEvent({ event: 'api:report', ticketId, state, turn, replyChars: reply.length });
            return respond(res, 201, { ok: true, ticketId, assignmentId: assignment.id, turn, state, reply: Boolean(reply) });
        }
        if (path === '/api/sources/feishu/chats' && req.method === 'GET') {
            return respond(res, 200, {
                chats: config.feishu.chats,
                directMessages: config.feishu.directMessages,
                allowed: config.feishu.allowed,
            });
        }
        if (path === '/api/policy') {
            if (req.method === 'GET') {
                return respond(res, 200, { policy: opts.engine.policy(), config: config.policy });
            }
            if (req.method === 'PUT') {
                const body = (await readJson(req));
                const acceptMode = body.acceptMode;
                if (acceptMode !== undefined && !['off', 'observe', 'auto'].includes(String(acceptMode))) {
                    return respond(res, 400, { error: 'invalid-acceptMode' });
                }
                const maxWorkers = body.maxWorkers === undefined ? undefined : Number(body.maxWorkers);
                if (maxWorkers !== undefined && (!Number.isFinite(maxWorkers) || maxWorkers < 1)) {
                    return respond(res, 400, { error: 'invalid-maxWorkers' });
                }
                if (acceptMode !== undefined)
                    config.policy.acceptMode = acceptMode;
                if (maxWorkers !== undefined)
                    config.policy.maxWorkers = maxWorkers;
                if (body.admission && typeof body.admission === 'object') {
                    config.policy.admission = { ...config.policy.admission, ...body.admission };
                }
                const policy = opts.engine.updatePolicy(policyOf(config));
                onEvent({ event: 'api:policy', acceptMode: policy.acceptMode, maxWorkers: policy.maxWorkers, version: policy.version });
                await opts.onPolicyChange?.(config);
                return respond(res, 200, { policy, config: config.policy });
            }
            return respond(res, 405, { error: 'method-not-allowed' });
        }
        if (path.startsWith('/api/'))
            return respond(res, 404, { error: 'not-found' });
        return serveStatic(res, path, opts.webRoot);
    }
    const port = opts.port ?? 0;
    await new Promise((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            server.off('error', reject);
            resolvePromise();
        });
    });
    return {
        server,
        close: () => new Promise(resolvePromise => {
            server.close(() => resolvePromise());
        }),
    };
}
function respond(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
}
function readJson(req) {
    return new Promise((resolvePromise, reject) => {
        let data = '';
        req.on('data', chunk => {
            data += String(chunk);
            if (data.length > 1_000_000) {
                reject(new Error('body-too-large'));
                req.destroy();
            }
        });
        req.on('end', () => {
            if (!data.trim())
                return resolvePromise({});
            try {
                resolvePromise(JSON.parse(data));
            }
            catch {
                reject(new Error('invalid-json'));
            }
        });
        req.on('error', reject);
    });
}
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
};
function serveStatic(res, path, webRoot) {
    if (!webRoot)
        return respond(res, 404, { error: 'not-found' });
    const root = resolve(webRoot);
    const candidate = normalize(join(root, path === '/' ? 'index.html' : path));
    if (!candidate.startsWith(root) || !existsSync(candidate) || !statSync(candidate).isFile()) {
        const index = join(root, 'index.html');
        if (existsSync(index)) {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(readFileSync(index));
            return;
        }
        return respond(res, 404, { error: 'not-found' });
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(candidate)] ?? 'application/octet-stream' });
    res.end(readFileSync(candidate));
}
function groupByStage(stages) {
    const out = {};
    for (const stage of stages)
        out[stage] = (out[stage] ?? 0) + 1;
    return out;
}
/** 兼容旧版 deliverable：内容 + 链接拼成纯回复。 */
function legacyReply(raw) {
    if (!raw || typeof raw !== 'object')
        return '';
    const value = raw;
    return [String(value.content ?? '').trim(), String(value.url ?? '').trim()].filter(Boolean).join('\n\n');
}
//# sourceMappingURL=api.js.map