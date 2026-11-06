import { existsSync, readFileSync, writeFileSync } from 'node:fs';
/** 群名目录：定期从 lark-cli 拉取并缓存，用于面板与通知里的可读名称。 */
export class ChatDirectory {
    file;
    names = new Map();
    constructor(file) {
        this.file = file;
        this.load();
    }
    nameOf(chatId) {
        return this.names.get(chatId) ?? '';
    }
    entries() {
        return [...this.names.entries()].map(([chatId, name]) => ({ chatId, name }));
    }
    /** 用 lark-cli 的真实返回刷新缓存；失败保留旧值。 */
    async refresh(runner) {
        const res = await runner.run(['im', '+chat-list', '--as', 'bot', '--format', 'json']);
        if (res.code !== 0)
            return 0;
        const parsed = parseChatList(res.stdout);
        for (const entry of parsed)
            this.names.set(entry.chatId, entry.name);
        this.save();
        return parsed.length;
    }
    load() {
        if (!existsSync(this.file))
            return;
        try {
            const doc = JSON.parse(readFileSync(this.file, 'utf8'));
            for (const entry of doc.chats ?? [])
                this.names.set(entry.chatId, entry.name);
        }
        catch {
            // 缓存损坏时当作空
        }
    }
    save() {
        writeFileSync(this.file, `${JSON.stringify({ chats: this.entries() }, null, 2)}\n`, 'utf8');
    }
}
/** 兼容 `{data:{chats:[...]}}` / `{data:{items:[...]}}` / 裸数组。 */
export function parseChatList(stdout) {
    let json;
    try {
        json = JSON.parse(stdout);
    }
    catch {
        return [];
    }
    if (Array.isArray(json))
        return normalize(json);
    const root = json;
    const data = root?.data ?? root;
    const list = data?.chats ?? data?.items ?? [];
    return Array.isArray(list) ? normalize(list) : [];
}
function normalize(list) {
    const out = [];
    for (const raw of list) {
        const chatId = String(raw.chat_id ?? raw.chatId ?? '');
        const name = String(raw.name ?? raw.chat_name ?? '');
        if (chatId)
            out.push({ chatId, name });
    }
    return out;
}
//# sourceMappingURL=feishu-directory.js.map