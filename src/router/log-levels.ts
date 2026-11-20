/** 失败类事件必须落到 warn/error，不能因为统一走 EventSink 就全记成 info。 */
const LEVELS: Record<string, 'warn' | 'error'> = {
  'outbox:failed': 'warn',
  'effect:failed': 'warn',
  'worker:lost': 'warn',
  'idle:stale': 'warn',
  'idle:transfer': 'warn',
  'channel:not-registered': 'warn',
  'feishu:card-fallback': 'warn',
  'input:redeliver-giveup': 'warn',
  'event:attempts-exceeded': 'error',
}

export function logLevelOf(event: string): 'info' | 'warn' | 'error' {
  return LEVELS[event] ?? 'info'
}
