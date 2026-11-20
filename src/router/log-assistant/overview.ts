

import { evidenceData, formatValue } from './evidence.js'

import type { LogEntry } from '../log-tail.js'
import type { LogOverviewIssue } from './types.js'
import { matchSymptoms } from './symptoms.js'

export function distinctIssues(errors: LogEntry[]): LogOverviewIssue[] {
  const byProblem = new Map<string, LogEntry>()
  for (const entry of errors) {
    // 命中已知模式时按模式去重，没命中时按事件名去重。
    const key = matchSymptoms([entry])[0]?.symptom.id ?? entry.message
    const existing = byProblem.get(key)
    // 日志按时间递增写入，后来的更新：只保留最新那条。
    if (!existing || Date.parse(entry.at) >= Date.parse(existing.at)) {
      byProblem.set(key, entry)
    }
  }
  return [...byProblem.values()]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 5)
    .map(entry => overviewIssueOf(entry))
}

/**
 * 把一条错误日志翻成人话摘要。
 *
 * 命中已知问题模式时用知识库的说法（这是用户能懂的话）；
 * 没命中就给事件名与详情，不编造原因。
 */
export function overviewIssueOf(entry: LogEntry): LogOverviewIssue {
  const hit = matchSymptoms([entry])[0]
  const symptom = hit?.symptom
  const fields = evidenceData(entry)
  const detail = Object.entries(fields).map(([key, value]) => `${key}=${formatValue(value)}`).join(' ')
  return {
    event: entry.message,
    // 标题说「这是什么情况」，不是内部的知识库分类名。
    title: symptom ? symptom.conclusion : `出现了一个错误：${entry.message}`,
    ...(detail ? { detail: detail.slice(0, 300) } : {}),
    at: entry.at,
    // 行动指引取「用户该做的事」，不是技术细节：事件名与字段名属于补充信息。
    ...(symptom?.steps[0] ? { action: symptom.steps[0] } : {}),
  }
}
