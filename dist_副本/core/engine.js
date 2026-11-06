import { negotiateAcceptance } from './policy.js';
import { computeStage } from './stage.js';
import { noopSink, preview } from './events.js';
const defaultClock = { now: () => new Date().toISOString() };
const defaultIds = { next: prefix => `${prefix}_${crypto.randomUUID()}` };
/**
 * 领域内核的唯一状态写入口。
 * Router、Worker、面板都不直接写 SQLite，全部经由这里。
 */
export class Engine {
    store;
    clock;
    ids;
    currentPolicy;
    onEvent;
    constructor(deps) {
        this.store = deps.store;
        this.clock = deps.clock ?? defaultClock;
        this.ids = deps.ids ?? defaultIds;
        this.currentPolicy = deps.policy;
        this.onEvent = deps.onEvent ?? noopSink;
        if (!this.store.getPolicy())
            this.store.setPolicy(deps.policy);
    }
    policy() {
        return this.currentPolicy;
    }
    updatePolicy(policy) {
        this.currentPolicy = policy;
        this.store.setPolicy(policy);
        return policy;
    }
    /** 幂等写入一条 Trigger；重复的 Source 事件不会入库。 */
    ingest(trigger) {
        this.store.upsertThread({
            id: trigger.threadId,
            source: trigger.source,
            rootId: trigger.threadId.split(':').at(-1) ?? trigger.threadId,
            chatId: trigger.chatId,
            createdAt: trigger.receivedAt,
        });
        return this.store.insertTrigger(trigger);
    }
    /** 记录一个 Decision；accept 时同时创建 Mandate 与 Ticket。 */
    decide(input) {
        const trigger = this.store.getTrigger(input.triggerId);
        if (!trigger)
            throw new Error('trigger:not-found');
        const acceptance = negotiateAcceptance(input.decision, input.strength, this.currentPolicy.acceptMode);
        const now = this.clock.now();
        const record = {
            id: this.ids.next('dec'),
            triggerId: trigger.id,
            threadId: trigger.threadId,
            decision: acceptance.decision,
            strength: input.strength,
            reason: input.reason,
            policyVersion: this.currentPolicy.version,
            wouldAccept: acceptance.wouldAccept,
            createdAt: now,
        };
        this.store.insertDecision(record);
        this.store.setTriggerDisposition(trigger.id, 'evaluated', record.id);
        if (acceptance.decision !== 'accept') {
            this.onEvent({
                event: 'router:decision',
                triggerId: trigger.id,
                decision: record.decision,
                strength: record.strength,
                wouldAccept: record.wouldAccept,
                reason: preview(input.reason),
                text: preview(trigger.text, 120),
            });
            return { decision: record, acceptance };
        }
        const ticket = {
            id: this.ids.next('tk'),
            title: input.title?.trim() || deriveTitle(trigger.text),
            threadId: trigger.threadId,
            source: trigger.source,
            chatId: trigger.chatId,
            mandateId: this.ids.next('md'),
            stage: 'accepted',
            repo: input.repo?.trim() ?? '',
            branch: input.branch?.trim() ?? '',
            prNumber: 0,
            prUrl: '',
            prState: 'none',
            createdAt: now,
            updatedAt: now,
        };
        const mandate = {
            id: ticket.mandateId,
            ticketId: ticket.id,
            policyVersion: this.currentPolicy.version,
            strength: input.strength,
            scope: input.scope?.trim() || `完成：${ticket.title}`,
            rules: input.rules ?? [],
            actorId: trigger.actorId,
            actorName: trigger.actorName,
            source: trigger.source,
            chatId: trigger.chatId,
            threadId: trigger.threadId,
            createdAt: now,
        };
        this.store.insertMandate(mandate);
        this.store.insertTicket(ticket);
        this.store.subscribe({ threadId: trigger.threadId, ticketId: ticket.id, contextOnly: false, createdAt: now });
        this.onEvent({
            event: 'router:decision',
            triggerId: trigger.id,
            decision: record.decision,
            strength: record.strength,
            wouldAccept: record.wouldAccept,
            reason: preview(input.reason),
            ticketId: ticket.id,
            title: ticket.title,
            scope: preview(mandate.scope, 120),
            text: preview(trigger.text, 120),
        });
        return { decision: record, acceptance, ticket, mandate };
    }
    startAssignment(ticketId, opts) {
        this.requireTicket(ticketId);
        const now = this.clock.now();
        const assignment = {
            id: this.ids.next('as'),
            ticketId,
            backendId: opts.backendId,
            handle: opts.handle,
            workdir: opts.workdir,
            status: 'pending',
            startedAt: now,
        };
        this.store.insertAssignment(assignment);
        this.store.rebindInputs(ticketId, assignment.id);
        this.refreshStage(ticketId);
        return assignment;
    }
    /** 记录 worker 上报，并在同一事务语义内刷新阶段、PR 与待答问题。 */
    report(assignmentId, state) {
        const assignment = this.store.getAssignment(assignmentId);
        if (!assignment)
            throw new Error('assignment:not-found');
        const ticket = this.requireTicket(assignment.ticketId);
        const now = this.clock.now();
        const report = {
            id: this.ids.next('rp'),
            ticketId: ticket.id,
            assignmentId,
            turn: state.turn,
            state: state.state,
            summary: state.summary,
            ...(state.humanAction ? { humanAction: state.humanAction } : {}),
            ...(state.prNumber && state.prNumber > 0 ? { prNumber: state.prNumber } : {}),
            ...(state.prUrl ? { prUrl: state.prUrl } : {}),
            ...(state.reply ? { reply: state.reply } : {}),
            ackedInputs: state.ackedInputs ?? [],
            at: now,
        };
        this.store.insertReport(report);
        this.store.ackInputs(assignmentId, report.ackedInputs, now);
        if (assignment.status === 'pending') {
            this.store.updateAssignment({ ...assignment, status: 'running' });
        }
        let updated = ticket;
        if (state.prNumber && state.prNumber > 0) {
            updated = { ...updated, prNumber: state.prNumber, prUrl: state.prUrl ?? updated.prUrl, prState: updated.prState === 'none' ? 'open' : updated.prState, updatedAt: now };
        }
        this.store.updateTicket(updated);
        if (state.state === 'blocked' && state.humanAction)
            this.store.setAttention(ticket.id, state.humanAction, now);
        if (state.state === 'ready' || state.state === 'progress' || state.state === 'waiting')
            this.store.clearAttention(ticket.id);
        if (state.state === 'ready') {
            this.store.subscribe({ threadId: ticket.threadId, ticketId: ticket.id, contextOnly: false, createdAt: now });
        }
        this.refreshStage(ticket.id);
        return report;
    }
    deliverInput(ticketId, opts) {
        const ticket = this.requireTicket(ticketId);
        if (ticket.stage === 'closed')
            throw new Error('ticket:closed');
        // 工单已接但还没派工时先挂起，派工后由 startAssignment 重新绑定。
        const assignment = opts.assignmentId ?? this.store.latestAssignment(ticketId)?.id ?? '';
        const input = {
            id: this.ids.next('in'),
            ticketId,
            assignmentId: assignment,
            seq: this.store.nextInputSeq(ticketId),
            kind: opts.kind,
            text: opts.text,
            status: 'pending',
            createdAt: this.clock.now(),
        };
        this.store.insertInput(input);
        this.onEvent({ event: 'input:queued', ticketId, inputId: input.id, seq: input.seq, kind: input.kind, text: preview(input.text) });
        return input;
    }
    ackInputs(ticketId, ids) {
        const assignment = this.store.latestAssignment(ticketId);
        if (!assignment)
            return;
        this.store.ackInputs(assignment.id, ids, this.clock.now());
    }
    /** 订阅扇出：把某条 Trigger 投给订阅了该 Thread 的所有未关闭工单。 */
    fanOut(triggerId) {
        const trigger = this.store.getTrigger(triggerId);
        if (!trigger)
            throw new Error('trigger:not-found');
        // 已被本轮 tick 领取（evaluating）或尚未处理的都可以扇出。
        if (trigger.disposition !== 'pending' && trigger.disposition !== 'evaluating')
            return [];
        const subscriptions = this.store.listSubscriptions(trigger.threadId);
        const delivered = [];
        for (const sub of subscriptions) {
            const ticket = this.store.getTicket(sub.ticketId);
            if (!ticket || ticket.stage === 'closed' || ticket.stage === 'draft')
                continue;
            this.deliverInput(ticket.id, { kind: 'followup', text: trigger.text });
            delivered.push(ticket);
        }
        this.store.setTriggerDisposition(trigger.id, delivered.length > 0 ? 'fanned_out' : 'pending');
        return delivered;
    }
    updatePr(ticketId, pr) {
        const ticket = this.requireTicket(ticketId);
        const updated = { ...ticket, prNumber: pr.number, prUrl: pr.url, prState: pr.state, updatedAt: this.clock.now() };
        this.store.updateTicket(updated);
        this.refreshStage(ticketId);
        return this.store.getTicket(ticketId);
    }
    /** 结束工单：PR 仍开时拒绝，避免提前闭环。 */
    closeTicket(ticketId, reason) {
        const ticket = this.requireTicket(ticketId);
        if (ticket.prState === 'open')
            throw new Error('pr:open');
        const now = this.clock.now();
        const updated = { ...ticket, stage: 'closed', closedAt: now, updatedAt: now };
        this.store.updateTicket(updated);
        this.store.clearAttention(ticketId);
        const assignment = this.store.latestAssignment(ticketId);
        if (assignment && assignment.status !== 'ended') {
            this.store.updateAssignment({ ...assignment, status: 'ended', endedAt: now });
        }
        this.onEvent({ event: 'ticket:closed', ticketId, by: 'close', reason: preview(reason), stage: updated.stage });
        return updated;
    }
    /** 人工停止：立刻结束工单，worker 停止由 Router 通过 Effects 执行。 */
    stopTicket(ticketId, reason) {
        const ticket = this.requireTicket(ticketId);
        const now = this.clock.now();
        const updated = { ...ticket, stage: 'closed', closedAt: now, updatedAt: now };
        this.store.updateTicket(updated);
        this.store.clearAttention(ticketId);
        const assignment = this.store.latestAssignment(ticketId);
        if (assignment && assignment.status !== 'ended') {
            this.store.updateAssignment({ ...assignment, status: 'ended', endedAt: now });
        }
        this.onEvent({ event: 'ticket:closed', ticketId, by: 'stop', reason: preview(reason), stage: updated.stage });
        return updated;
    }
    subscribe(threadId, ticketId, contextOnly = false) {
        this.store.subscribe({ threadId, ticketId, contextOnly, createdAt: this.clock.now() });
    }
    unsubscribe(threadId, ticketId) {
        this.store.unsubscribe(threadId, ticketId);
    }
    setAttention(ticketId, question) {
        this.requireTicket(ticketId);
        this.store.setAttention(ticketId, question, this.clock.now());
        this.refreshStage(ticketId);
    }
    /** 重新推导阶段并落库。 */
    refreshStage(ticketId) {
        const ticket = this.requireTicket(ticketId);
        const assignment = this.store.latestAssignment(ticketId);
        const latestReport = this.store.latestReport(ticketId);
        const hasAttention = Boolean(this.store.getAttention(ticketId));
        const stage = computeStage({ ticket, assignment, latestReport, hasAttention });
        if (stage !== ticket.stage) {
            this.store.updateTicket({ ...ticket, stage, updatedAt: this.clock.now() });
        }
        return stage;
    }
    listActiveAssignments() {
        return this.store.listOpenTickets()
            .map(t => this.store.latestAssignment(t.id))
            .filter((a) => Boolean(a) && a.status === 'running');
    }
    requireTicket(ticketId) {
        const ticket = this.store.getTicket(ticketId);
        if (!ticket)
            throw new Error('ticket:not-found');
        return ticket;
    }
}
export function deriveTitle(text) {
    const line = text.trim().split('\n')[0]?.trim() ?? '';
    if (!line)
        return '未命名工单';
    return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}
//# sourceMappingURL=engine.js.map