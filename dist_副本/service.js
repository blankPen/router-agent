import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AgentLoop } from './router/agent-loop.js';
import { dispatchSettingsOf } from './router/dispatch.js';
import { ReportPoller, appendEvent, judgeIdle } from './worker/orca/report-poller.js';
import { EffectsProcessor } from './core/effects.js';
import { preview } from './core/events.js';
const noopLogger = { info: () => { }, warn: () => { }, error: () => { } };
/**
 * 服务编排：把 AgentLoop、上报轮询、Effects、PR 跟踪与 WorkerBackend 接在一起。
 * 本身不持有终端状态；重启后靠 recover() 与 Orca 对账。
 */
export class RouterService {
    store;
    engine;
    loop;
    config;
    backend;
    clock;
    logger;
    poller;
    effects;
    prTracker;
    sender;
    timers = [];
    running = false;
    idleAfterMs;
    staleAfterMs;
    idle = new Map();
    ticking = false;
    backfill;
    constructor(opts) {
        this.store = opts.store;
        this.engine = opts.engine;
        this.config = opts.config;
        this.backend = opts.backend;
        this.clock = opts.clock ?? { now: () => new Date().toISOString() };
        this.logger = opts.logger ?? noopLogger;
        this.prTracker = opts.prTracker;
        this.idleAfterMs = opts.idleAfterMs ?? 120_000;
        this.staleAfterMs = opts.staleAfterMs ?? 300_000;
        this.backfill = opts.backfill;
        this.loop = new AgentLoop({
            engine: opts.engine,
            llm: opts.llm,
            clock: this.clock,
            batchWindowMs: opts.agentLoopOptions?.batchWindowMs ?? 8000,
            maxToolRounds: opts.agentLoopOptions?.maxToolRounds ?? 3,
            dispatch: dispatchSettingsOf(opts.config),
        });
        this.poller = opts.poller ?? new ReportPoller({
            workersDir: join(opts.config.home, 'workers'),
            onState: (state, meta) => this.onWorkerState(state, meta ?? undefined),
            onError: (ticketId, error) => this.logger.error('report:invalid', { ticketId, message: error.message }),
        });
        this.sender = opts.sender ?? { send: async () => { } };
        this.effects = opts.effects ?? new EffectsProcessor({
            store: opts.store,
            sender: this.sender,
            clock: this.clock,
        });
        this.bindEffects(this.effects);
    }
    /** 把停止、派工与结果投递能力接到 EffectsProcessor 上（内部与 CLI 共用）。 */
    bindEffects(effects) {
        effects.register('stop-worker', async (payload) => {
            const ticketId = String(payload.ticketId ?? '');
            const assignment = this.store.latestAssignment(ticketId);
            if (!assignment?.handle)
                return;
            await this.backend.stop(assignment.handle, 'ticket-stopped');
            this.log('worker:stopped', ticketId, { handle: assignment.handle });
        });
        effects.register('launch-worker', async (payload) => {
            const ticket = this.store.getTicket(String(payload.ticketId ?? ''));
            if (!ticket || ticket.stage === 'closed')
                return;
            await this.launch(ticket);
        });
    }
    /** 一个完整周期：研判 → 上报 → Effects → 派工 → 投递。周期之间串行，避免重叠。 */
    async runOnce() {
        if (this.ticking)
            return;
        this.ticking = true;
        try {
            await this.runCycle();
        }
        finally {
            this.ticking = false;
        }
    }
    async runCycle() {
        await this.loop.tick();
        this.poller.scan();
        await this.effects.tick();
        await this.launchPending();
        await this.deliverPendingInputs();
    }
    async start() {
        if (this.running)
            return;
        this.running = true;
        await this.recover();
        if (this.backfill) {
            try {
                const triggers = await this.backfill();
                for (const trigger of triggers)
                    this.engine.ingest(trigger);
                if (triggers.length > 0)
                    this.logger.info('backfill:done', { count: triggers.length });
            }
            catch (error) {
                this.logger.warn('backfill:failed', { message: error instanceof Error ? error.message : String(error) });
            }
        }
        const every = (ms, fn) => {
            const timer = setInterval(() => {
                Promise.resolve(fn()).catch(error => this.logger.error('loop:error', { message: error instanceof Error ? error.message : String(error) }));
            }, ms);
            timer.unref?.();
            this.timers.push(timer);
        };
        every(1000, () => this.runOnce());
        every(5000, () => this.trackPullRequests());
        every(15_000, () => this.checkIdle());
    }
    stop() {
        for (const timer of this.timers)
            clearInterval(timer);
        this.timers = [];
        this.running = false;
    }
    // ---------- 派工 ----------
    /** 把所有 accepted 阶段、且还有并发额度的工单派出去。 */
    async launchPending() {
        const launched = [];
        let capacity = this.config.policy.maxWorkers - this.activeWorkers();
        if (capacity <= 0)
            return launched;
        for (const ticket of this.store.listOpenTickets()) {
            if (capacity <= 0)
                break;
            if (ticket.stage !== 'accepted')
                continue;
            const latest = this.store.latestAssignment(ticket.id);
            if (latest && latest.status !== 'ended')
                continue;
            try {
                await this.launch(ticket);
                launched.push(ticket);
                capacity -= 1;
            }
            catch (error) {
                this.logger.error('launch:failed', { ticketId: ticket.id, message: error instanceof Error ? error.message : String(error) });
            }
        }
        return launched;
    }
    async launch(ticket) {
        const assignment = this.engine.startAssignment(ticket.id, {
            backendId: this.backend.id,
            handle: '',
            workdir: '',
        });
        const ctx = { ticket, assignment, workdir: '' };
        try {
            const { handle, workdir } = await this.backend.start(ctx);
            const updated = { ...assignment, handle, workdir: workdir ?? '' };
            this.store.updateAssignment(updated);
            this.engine.refreshStage(ticket.id);
            this.log('launch', ticket.id, { handle, workdir });
            return updated;
        }
        catch (error) {
            this.store.updateAssignment({ ...assignment, status: 'ended', endedAt: this.clock.now() });
            throw error;
        }
    }
    activeWorkers() {
        return this.store.listOpenTickets().filter(t => t.stage === 'assigned' || t.stage === 'running').length;
    }
    async deliverPendingInputs() {
        for (const ticket of this.store.listOpenTickets()) {
            const assignment = this.store.latestAssignment(ticket.id);
            if (!assignment || assignment.status === 'ended' || !assignment.handle)
                continue;
            const pending = this.store.pendingInputs(ticket.id);
            if (pending.length === 0)
                continue;
            // 下次唤醒时把上次已投递但没 ack 的输入一并重发，靠 id 去重。
            const unacked = this.store.unackedInputs(ticket.id);
            const batch = [...unacked, ...pending];
            try {
                // 用 input.id（而不是 assignmentId:seq）作为投递 id：worker 会原样写进 acked_inputs。
                await this.backend.deliver(assignment.handle, batch.map(input => ({ id: input.id, kind: input.kind, text: input.text })));
                this.store.markInputsDelivered(ticket.id, this.clock.now());
                this.log('input:delivered', ticket.id, {
                    count: batch.length,
                    redelivered: unacked.length,
                    text: preview(batch.map(item => item.text).join(' / ')),
                });
            }
            catch (error) {
                // 终端被删掉时 send 会一直失败；先确认会话是否还在，别每秒重试。
                if (await this.workerGone(assignment.handle)) {
                    this.handleLostWorker(ticket, 'input-deliver-failed');
                    continue;
                }
                this.logger.warn('input:deliver-failed', { ticketId: ticket.id, message: error instanceof Error ? error.message : String(error) });
            }
        }
    }
    // ---------- 空闲与失联 ----------
    /**
     * 用 Orca 的结构化字段判断 worker 是否空闲：
     * 长时间无输出 → 主动发 `status?` 唤醒；仍然无响应 → 标 stale 并通知人。
     */
    async checkIdle(nowMs = Date.parse(this.clock.now())) {
        if (!this.backend.inspect)
            return;
        for (const ticket of this.store.listOpenTickets()) {
            if (ticket.stage !== 'running' && ticket.stage !== 'assigned')
                continue;
            const assignment = this.store.latestAssignment(ticket.id);
            if (!assignment?.handle || assignment.status === 'ended')
                continue;
            let info;
            try {
                info = (await this.backend.inspect(assignment.handle));
            }
            catch {
                // Orca 暂时不可用，下一轮再看。
                continue;
            }
            if (!info || !info.connected) {
                this.handleLostWorker(ticket, 'inspect-dead');
                continue;
            }
            const turn = this.store.latestReport(ticket.id)?.turn ?? 0;
            const state = this.idle.get(ticket.id);
            if (!state) {
                this.idle.set(ticket.id, { turn, nudgedAt: null, stale: false });
            }
            else if (state.turn !== turn) {
                this.idle.set(ticket.id, { turn, nudgedAt: null, stale: false });
                continue;
            }
            const current = this.idle.get(ticket.id);
            const verdict = judgeIdle({ info, turn, lastTurn: turn, now: nowMs, idleAfterMs: this.idleAfterMs });
            if (verdict !== 'idle')
                continue;
            if (!current.nudgedAt) {
                await this.backend.deliver(assignment.handle, [{ id: `${assignment.id}:status-check`, kind: 'retry', text: 'status?' }]);
                current.nudgedAt = nowMs;
                this.log('idle:nudge', ticket.id, { handle: assignment.handle });
                continue;
            }
            if (!current.stale && nowMs - current.nudgedAt > this.staleAfterMs) {
                current.stale = true;
                this.engine.setAttention(ticket.id, 'worker 无响应：长时间没有新的 state.json 上报，已标记 stale，请人工确认');
                this.notify(ticket, `工单「${ticket.title}」的 worker 无响应，已标记 stale，请到 Orca 终端确认。`, `stale:${ticket.id}`);
                this.log('idle:stale', ticket.id, {});
            }
        }
    }
    // ---------- 上报 ----------
    /** Worker 通过 state.json 上报；poller 与测试都走这里。 */
    onWorkerState(state, meta) {
        const ticket = this.store.getTicket(state.ticketId);
        if (!ticket) {
            this.logger.warn('report:unknown-ticket', { ticketId: state.ticketId });
            return;
        }
        const assignment = (state.assignmentId ? this.store.getAssignment(state.assignmentId) : null) ?? this.store.latestAssignment(ticket.id);
        if (!assignment) {
            this.logger.warn('report:no-assignment', { ticketId: ticket.id });
            return;
        }
        // 上报有 HTTP 与 state.json 两条通道；重启后 poller 会重读旧文件，
        // 用「上报时间早于最后一条已入库报告」把它挡掉，避免旧内容被重复投递。
        const latestReport = this.store.latestReport(ticket.id);
        const incomingAt = Date.parse(state.updatedAt);
        if (latestReport && Number.isFinite(incomingAt) && Date.parse(latestReport.at) > incomingAt) {
            this.logger.info('report:stale-ignored', { ticketId: ticket.id, incoming: state.updatedAt, latest: latestReport.at });
            return;
        }
        const reply = state.reply?.trim() ?? '';
        this.engine.report(assignment.id, {
            ticketId: ticket.id,
            turn: state.turn,
            state: state.state,
            summary: state.summary,
            ...(state.humanAction ? { humanAction: state.humanAction } : {}),
            ...(state.prNumber ? { prNumber: state.prNumber } : {}),
            ...(state.prUrl ? { prUrl: state.prUrl } : {}),
            ...(reply ? { reply } : {}),
            ackedInputs: state.ackedInputs,
        });
        this.appendEventLog(ticket.id, { kind: 'report', state: state.state, turn: state.turn, at: state.updatedAt });
        this.log('report', ticket.id, {
            state: state.state,
            turn: state.turn,
            summary: preview(state.summary),
            ...(state.humanAction ? { humanAction: preview(state.humanAction) } : {}),
            ...(state.prNumber ? { pr: state.prNumber } : {}),
            ...(reply ? { replyChars: reply.length } : {}),
        });
        const reportKey = `${state.turn}:${state.updatedAt}`;
        if (reply) {
            // Worker 给了完整回复就原样发；正文里带文档链接 / PR 链接都照发，Router 不改写。
            const text = state.prUrl && !reply.includes(state.prUrl) ? `${reply}\n\nPR：${state.prUrl}` : reply;
            this.queueLong(ticket, '', text, `reply:${ticket.id}:${reportKey}`);
        }
        else if (state.state === 'ready') {
            const key = `ready:${ticket.id}:${reportKey}`;
            const base = `工单「${ticket.title}」已完成：${state.prUrl || state.summary}`;
            this.queue(ticket, state.prUrl ? base : `${base}\n\n（worker 只回了一句话，未提供完整回复；如需完整内容请在本话题继续追问）`, key);
        }
        if (state.state === 'blocked' && !reply) {
            this.notify(ticket, `工单「${ticket.title}」卡住了：${state.humanAction ?? state.summary}`, `blocked:${ticket.id}:${reportKey}`);
        }
    }
    // ---------- 停止 ----------
    stopTicket(ticketId, reason) {
        const ticket = this.engine.stopTicket(ticketId, reason);
        this.store.enqueueEffect({ id: `ef_stop_${ticketId}_${Date.now()}`, key: `stop:${ticketId}`, kind: 'stop-worker', payload: { ticketId }, now: this.clock.now() });
        return ticket;
    }
    // ---------- PR 闭环 ----------
    async trackPullRequests() {
        for (const ticket of this.store.listOpenTickets()) {
            // 每张工单自带仓库，不再有全局 repo 兜底。
            const repo = ticket.repo;
            let prNumber = ticket.prNumber;
            let prUrl = ticket.prUrl;
            // 双保险之一：Orca worktree 自带的 linkedPR / linkedGitLabMR。
            if (!prNumber && this.backend.inspectWorktree) {
                const assignment = this.store.latestAssignment(ticket.id);
                // 派工已结束或 worktree 被删时 Orca 会返回 selector_not_found，静默跳过，不要每 5 秒刷错误。
                if (assignment?.workdir && assignment.status !== 'ended') {
                    try {
                        const worktree = (await this.backend.inspectWorktree(`path:${assignment.workdir}`));
                        const linked = worktree?.linkedPR ?? worktree?.linkedGitLabMR ?? worktree?.worktree?.linkedPR;
                        const number = Number(linked?.number ?? linked?.iid ?? 0);
                        if (number > 0) {
                            prNumber = number;
                            prUrl = String(linked.url ?? linked.webUrl ?? prUrl);
                            this.engine.updatePr(ticket.id, { number: prNumber, url: prUrl, state: 'open' });
                            this.log('pr:linked', ticket.id, { number: prNumber, source: 'orca' });
                        }
                    }
                    catch {
                        // worktree 不在了：等 gh 兜底或人工处理
                    }
                }
            }
            // 双保险之二：gh pr view。
            if (!prNumber || !repo)
                continue;
            const info = await this.prTracker.view(repo, prNumber);
            if (!info)
                continue;
            const before = ticket.prState;
            const updated = this.engine.updatePr(ticket.id, { number: info.number, url: info.url || ticket.prUrl, state: info.state });
            if (before !== info.state)
                this.log('pr:state', ticket.id, { from: before, to: info.state });
            if ((info.state === 'merged' || info.state === 'closed') && updated.stage !== 'closed') {
                const closed = this.engine.closeTicket(ticket.id, `pr:${info.state}`);
                appendEvent(join(this.config.home, 'workers', ticket.id, 'events.log'), { kind: 'pr', state: info.state, at: this.clock.now() });
                const label = info.state === 'merged' ? '已合并' : '已关闭';
                this.notify(closed, `工单「${closed.title}」的 PR ${info.url} ${label}，工单闭环。`, `pr:${ticket.id}:${info.state}`);
            }
        }
    }
    // ---------- 重启对账 ----------
    async recover() {
        for (const ticket of this.store.listOpenTickets()) {
            const assignment = this.store.latestAssignment(ticket.id);
            if (assignment && assignment.status !== 'ended' && assignment.handle && this.backend.inspect) {
                let info;
                try {
                    info = (await this.backend.inspect(assignment.handle));
                }
                catch {
                    // Orca 暂时不可用：保持现状，不要误判成会话丢失。
                    continue;
                }
                // 实测 CLI 创建的终端可能 orphaned=true 但依然 connected/writable；
                // 只有 connected=false 才说明终端真的没了。
                if (info && info.connected) {
                    if (info.orphaned)
                        this.logger.warn('recover:orphaned-but-alive', { ticketId: ticket.id, handle: assignment.handle });
                    else
                        this.log('recover:reuse', ticket.id, { handle: assignment.handle });
                    continue;
                }
                // 会话没了就不再偷偷重开一个没有上下文的新 worker，直接转人工。
                this.handleLostWorker(ticket, 'recover');
                continue;
            }
            if (ticket.stage !== 'closed' && (!assignment || assignment.status === 'ended')) {
                if (ticket.stage === 'accepted' || ticket.stage === 'assigned' || ticket.stage === 'running') {
                    try {
                        await this.launch(ticket);
                        this.log('recover:relaunch', ticket.id, {});
                    }
                    catch (error) {
                        this.logger.error('recover:relaunch-failed', { ticketId: ticket.id, message: error instanceof Error ? error.message : String(error) });
                    }
                }
            }
        }
        this.poller.reset?.();
    }
    // ---------- 内部 ----------
    /** 只把「终端确实不存在」判为丢失；Orca 短暂不可用不误杀。 */
    async workerGone(handle) {
        if (!this.backend.inspect)
            return false;
        try {
            const info = (await this.backend.inspect(handle));
            return info === null || info.connected === false;
        }
        catch {
            return false;
        }
    }
    /**
     * Worker 会话被意外删除：结束派工、转人工、取消线程订阅，只通知一次。
     * 不自动重开新 worker——新会话没有原上下文，重跑等于从头再来。
     */
    handleLostWorker(ticket, reason) {
        const assignment = this.store.latestAssignment(ticket.id);
        if (assignment && assignment.status !== 'ended') {
            this.store.updateAssignment({ ...assignment, status: 'ended', endedAt: this.clock.now() });
        }
        this.engine.setAttention(ticket.id, '执行会话意外删除，已经找不到了');
        this.engine.unsubscribe(ticket.threadId, ticket.id);
        this.notify(ticket, `工单「${ticket.title}」的执行会话意外删除，已经找不到了，无法继续执行。如果还需要继续，请在本话题里说明，我会重新开一张工单。`, `worker-lost:${ticket.id}`);
        this.log('worker:lost', ticket.id, { handle: assignment?.handle ?? '', reason });
    }
    /** 长内容按行切块并顺序进入 outbox，避免超过飞书单条消息长度。 */
    queueLong(ticket, header, content, key) {
        const body = header ? `${header}\n\n${content}` : content;
        const chunks = splitMessage(body, 3500);
        const base = Date.parse(this.clock.now());
        chunks.forEach((chunk, index) => {
            const suffix = chunks.length > 1 ? `\n\n(${index + 1}/${chunks.length})` : '';
            this.store.enqueueOutbox({
                id: `ob_${`${key}:${index}`.replace(/[^a-zA-Z0-9:_-]/g, '_')}`,
                key: `${key}:${index}`,
                channelKind: 'feishu',
                channelId: ticket.chatId,
                threadId: ticket.threadId.split(':').at(-1) ?? '',
                text: `${chunk}${suffix}`,
                now: Number.isFinite(base) ? new Date(base + index).toISOString() : this.clock.now(),
            });
        });
    }
    queue(ticket, text, key) {
        this.store.enqueueOutbox({
            id: `ob_${key.replace(/[^a-zA-Z0-9:_-]/g, '_')}`,
            key,
            channelKind: 'feishu',
            channelId: ticket.chatId,
            threadId: ticket.threadId.split(':').at(-1) ?? '',
            text,
            now: this.clock.now(),
        });
    }
    notify(ticket, text, key) {
        this.queue(ticket, text, key);
    }
    appendEventLog(ticketId, event) {
        const dir = join(this.config.home, 'workers', ticketId);
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, 'events.log'), `${JSON.stringify(event)}\n`, 'utf8');
    }
    log(kind, ticketId, extra) {
        this.logger.info(kind, { ticketId, ...extra });
    }
}
/** 生产装配：用一个 CommandRunner 驱动 Orca 与 gh。 */
export function createEffectsSender(sender) {
    return {
        async send(item) {
            if (item.channelKind === 'feishu') {
                // 统一走互动卡片，Markdown 交给飞书渲染；卡片失败时 Sender 内部降级为 post。
                if (item.threadId)
                    await sender.replyCard(item.threadId, item.text, item.key);
                else
                    await sender.sendCard(item.channelId, item.text, item.key);
            }
        },
    };
}
/** 按行切成不超过 limit 的消息块，保证长回复不会被截断。 */
export function splitMessage(text, limit = 3500) {
    const chunks = [];
    let rest = text;
    while (rest.length > limit) {
        let cut = rest.lastIndexOf('\n', limit);
        if (cut < limit * 0.5)
            cut = limit;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n+/, '');
    }
    if (rest)
        chunks.push(rest);
    return chunks;
}
//# sourceMappingURL=service.js.map