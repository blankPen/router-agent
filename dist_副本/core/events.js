/** 截断长文本，日志里保留可读的片段而不刷屏。 */
export function preview(value, max = 160) {
    const text = typeof value === 'string' ? value : String(value ?? '');
    const single = text.replace(/\s+/g, ' ').trim();
    return single.length > max ? `${single.slice(0, max)}…` : single;
}
export function noopSink(_event) {
    // 未注入日志实现时什么都不做
}
//# sourceMappingURL=events.js.map