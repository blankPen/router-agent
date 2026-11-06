import { deriveTitle } from '../core/engine.js';
import { activeDraft, resolveDispatch } from './dispatch.js';
export const ROUTER_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'router_read',
            description: '读取一条 Trigger、它的 Thread 上下文，或某个工单的完整状态。做决定前可先调用。',
            parameters: {
                type: 'object',
                properties: {
                    trigger_id: { type: 'string', description: '要读取的 Trigger ID' },
                    ticket_id: { type: 'string', description: '要读取的工单 ID' },
                    thread_id: { type: 'string', description: '要读取的线程 ID' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'router_decide',
            description: '对一条 Trigger 给出决定。accept 会创建工单并派工；ignore 表示不需要开工；unavailable 表示研判没完成。',
            parameters: {
                type: 'object',
                required: ['trigger_id', 'decision', 'reason'],
                properties: {
                    trigger_id: { type: 'string' },
                    decision: { type: 'string', enum: ['accept', 'stop', 'ignore', 'unavailable'] },
                    strength: { type: 'string', enum: ['explicit', 'inferred'] },
                    reason: { type: 'string', description: '一句话理由，写给人看' },
                    title: { type: 'string', description: 'accept 时工单标题' },
                    scope: { type: 'string', description: 'accept 时授权范围，说明允许改什么、不允许改什么' },
                    repo: { type: 'string', description: 'accept 时必填：项目名或仓库选择器。判断不了就留空，系统会替你追问用户' },
                    branch: { type: 'string', description: 'accept 时必填：worktree 的起始分支。判断不了就留空，系统会替你追问用户' },
                    rules: { type: 'array', items: { type: 'string' }, description: '命中的策略规则名' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'router_reply',
            description: '回到飞书会话里说一句话。只用于 ack 与最终通知，不要闲聊。',
            parameters: {
                type: 'object',
                required: ['chat_id', 'text'],
                properties: {
                    chat_id: { type: 'string' },
                    thread_id: { type: 'string', description: '根消息 ID，用于话题回复' },
                    text: { type: 'string' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'router_ticket',
            description: '查询工单：给 ticket_id 取详情，或按 stage 列表。',
            parameters: {
                type: 'object',
                properties: {
                    ticket_id: { type: 'string' },
                    stage: { type: 'string' },
                    limit: { type: 'number' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'router_subscribe',
            description: '订阅或退订一个 Thread。订阅后该线程的新消息直接作为上下文投给工单，不再经过研判。',
            parameters: {
                type: 'object',
                required: ['thread_id', 'ticket_id', 'action'],
                properties: {
                    thread_id: { type: 'string' },
                    ticket_id: { type: 'string' },
                    action: { type: 'string', enum: ['subscribe', 'unsubscribe'] },
                    context_only: { type: 'boolean' },
                },
            },
        },
    },
];
/** 执行模型发来的工具调用。所有写操作仍然经过 Engine。 */
export class RouterToolbox {
    engine;
    store;
    clock;
    dispatch;
    constructor(deps) {
        this.engine = deps.engine;
        this.store = deps.store;
        this.clock = deps.clock;
        this.dispatch = deps.dispatch;
    }
    async call(name, rawArgs, defaults = {}) {
        let args;
        try {
            args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
        }
        catch {
            return { applied: false, result: { error: 'invalid-json-arguments' } };
        }
        switch (name) {
            case 'router_read':
                return { applied: false, result: this.read(args) };
            case 'router_decide':
                return { applied: true, result: this.decide(args, defaults) };
            case 'router_reply':
                return { applied: false, result: this.reply(args) };
            case 'router_ticket':
                return { applied: false, result: this.ticket(args) };
            case 'router_subscribe':
                return { applied: false, result: this.subscribe(args) };
            default:
                return { applied: false, result: { error: `unknown-tool:${name}` } };
        }
    }
    read(args) {
        if (args.ticket_id) {
            const ticket = this.store.getTicket(String(args.ticket_id));
            if (!ticket)
                return { error: 'ticket:not-found' };
            return {
                ticket,
                mandate: this.store.getMandate(ticket.mandateId),
                assignment: this.store.latestAssignment(ticket.id),
                reports: this.store.listReports(ticket.id, 5),
                inputs: this.store.listInputs(ticket.id),
            };
        }
        if (args.trigger_id) {
            const trigger = this.store.getTrigger(String(args.trigger_id));
            if (!trigger)
                return { error: 'trigger:not-found' };
            return {
                trigger,
                thread: this.store.listTriggersByThread(trigger.threadId, 20),
                tickets: this.store.listSubscriptions(trigger.threadId).map(s => this.store.getTicket(s.ticketId)).filter(Boolean),
            };
        }
        if (args.thread_id) {
            return {
                triggers: this.store.listTriggersByThread(String(args.thread_id), 20),
                subscriptions: this.store.listSubscriptions(String(args.thread_id)),
            };
        }
        return { error: 'router_read:missing-args' };
    }
    decide(args, defaults = {}) {
        const triggerId = String(args.trigger_id ?? '');
        if (!triggerId)
            return { error: 'router_decide:missing-trigger_id' };
        const decision = String(args.decision ?? '');
        if (!['accept', 'stop', 'ignore', 'unavailable'].includes(decision))
            return { error: 'router_decide:invalid-decision' };
        const strength = defaults.strength ?? (args.strength === 'explicit' ? 'explicit' : 'inferred');
        let repo = args.repo === undefined ? '' : String(args.repo).trim();
        let branch = args.branch === undefined ? '' : String(args.branch).trim();
        // accept 必须先明确「哪个项目 + 哪个起始分支」；缺了就交给 Router 追问，不开单。
        if (decision === 'accept' && this.dispatch) {
            const trigger = this.store.getTrigger(triggerId);
            if (!trigger)
                return { error: 'trigger:not-found' };
            const draft = activeDraft(this.store, trigger.chatId, trigger.actorId, this.clock.now());
            const resolution = resolveDispatch({ settings: this.dispatch, chatId: trigger.chatId, draft, repo, branch });
            if (resolution.missing.length > 0 || resolution.rejectedRepo || resolution.rejectedBranch) {
                return {
                    error: 'dispatch:needs-info',
                    missing: resolution.missing,
                    repo: resolution.repo,
                    branch: resolution.branch,
                    ...(resolution.rejectedRepo ? { rejected_repo: resolution.rejectedRepo } : {}),
                    ...(resolution.rejectedBranch ? { rejected_branch: resolution.rejectedBranch } : {}),
                    draft_task: draft?.task ?? trigger.text,
                    projects: this.dispatch.projects.map(project => ({
                        name: project.name,
                        repo: project.repo,
                        defaultBranch: project.defaultBranch,
                        branches: project.branches,
                    })),
                    ...(resolution.binding ? { bound: resolution.binding } : {}),
                };
            }
            repo = resolution.repo;
            branch = resolution.branch;
        }
        try {
            const outcome = this.engine.decide({
                triggerId,
                decision,
                strength,
                reason: String(args.reason ?? ''),
                title: args.title === undefined ? undefined : String(args.title),
                scope: args.scope === undefined ? undefined : String(args.scope),
                ...(repo ? { repo } : {}),
                ...(branch ? { branch } : {}),
                rules: Array.isArray(args.rules) ? args.rules.map(String) : [],
            });
            return {
                decision_id: outcome.decision.id,
                decision: outcome.decision.decision,
                would_accept: outcome.decision.wouldAccept,
                ticket_id: outcome.ticket?.id ?? null,
                repo,
                branch,
            };
        }
        catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
    }
    reply(_args) {
        // 回复由系统自动发送（ack / 话题开场 / 礼貌回复），这里不再二次入队，避免重复消息。
        return { skipped: true, reason: 'replies are sent automatically by the router' };
    }
    ticket(args) {
        if (args.ticket_id)
            return this.store.getTicket(String(args.ticket_id)) ?? { error: 'ticket:not-found' };
        return this.store.listTickets({ stage: args.stage, limit: Number(args.limit ?? 50) });
    }
    subscribe(args) {
        const threadId = String(args.thread_id ?? '');
        const ticketId = String(args.ticket_id ?? '');
        if (!threadId || !ticketId)
            return { error: 'router_subscribe:missing-args' };
        if (args.action === 'unsubscribe') {
            this.engine.unsubscribe(threadId, ticketId);
            return { subscribed: false };
        }
        this.engine.subscribe(threadId, ticketId, Boolean(args.context_only));
        return { subscribed: true };
    }
}
/** 只接受真实飞书 om_ 消息 id；模型常把内部 id（feishu_om_xxx）传进来。 */
export function normalizeMessageId(value) {
    const raw = String(value ?? '').trim();
    if (!raw)
        return '';
    const stripped = raw.startsWith('feishu_') ? raw.slice('feishu_'.length) : raw;
    return /^om_[A-Za-z0-9]+$/.test(stripped) ? stripped : '';
}
/** 从模型决定里取标题时用；导出便于测试与复用。 */
export function titleFrom(args, triggerText) {
    const title = String(args.title ?? '').trim();
    return title || deriveTitle(triggerText);
}
function hash(input) {
    let h = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}
//# sourceMappingURL=tools.js.map