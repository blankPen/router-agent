import type { AgentStatus } from './port.js'

/** 状态分类：所有调用点只消费这个结果，避免各自解释 provider 字段。 */
export type AgentVerdict = 'keep' | 'lost' | 'transfer' | 'unknown'

export function classifyAgentStatus(status: AgentStatus | null): AgentVerdict {
  if (!status) return 'unknown'
  if (status.phase === 'lost') return 'lost'
  if (status.phase === 'exited') return status.acceptingInput ? 'keep' : 'transfer'
  if (status.phase === 'blocked') return 'keep'
  if (status.phase === 'unknown') return 'unknown'
  return 'keep' // starting / running
}

/** 是否属于「进程还活着」的 keep 状态（blocked 也算活着）。 */
export function isAliveStatus(status: AgentStatus | null): boolean {
  return Boolean(status && status.alive && (status.phase === 'running' || status.phase === 'blocked' || status.phase === 'starting'))
}