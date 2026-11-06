import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
/** 注入给 worker 的完整手册（prompt 模式）或简短指令（agent 模式）。 */
export function buildWorkerPrompt(input) {
    const file = input.mode === 'agent' ? 'agent-mode.md' : 'prompt-mode.md';
    const template = readSpec(file);
    return render(template, {
        ticketId: input.ticket.id,
        title: input.ticket.title,
        scope: input.mandateScope,
        statePath: input.statePath,
        eventsPath: input.eventsPath,
        repo: input.repo,
        branch: input.branch ?? input.ticket.branch ?? '(仓库默认分支)',
        workdir: input.workdir ?? '(由 Orca 决定)',
    });
}
function readSpec(file) {
    return readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8');
}
function render(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, (_m, key) => vars[key] ?? '');
}
/** agent 模式的全局规范文件内容，供 `ra init` 写入 ~/.claude/agents/。 */
export function agentSpecDocument() {
    return `---
name: router-agent-worker
description: router-agent 派出的工单 worker；按 router-agent 的状态上报协议工作
tools: Read, Write, Edit, Bash, Glob, Grep
---

${readSpec('prompt-mode.md')}
`;
}
//# sourceMappingURL=index.js.map