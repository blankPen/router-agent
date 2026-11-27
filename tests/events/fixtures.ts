/**
 * 事件测试的共用夹具。
 *
 * 订阅取代了原来的「决策规则」：测试里要造的是一条订阅，
 * 不是一条规则 —— 判定依据从规则改成订阅（§2.2）。
 */
import type { ResolvedSubscription } from '../../src/events/subscriptions.js'

/** 造一条订阅；只写关心的字段。 */
export function subscription(over: Partial<ResolvedSubscription> = {}): ResolvedSubscription {
  return {
    id: 'auto_test',
    taskName: '测试任务',
    source: 'github',
    types: ['github.issues.opened'],
    params: { repo: 'blankPen/router-agent' },
    filter: { keywords: [], semantic: '' },
    mode: 'auto',
    project: 'router-agent',
    skill: 'bug-triage',
    prompt: '分析并修复这个问题。',
    notifyTo: '',
    enabled: true,
    ...over,
  }
}
