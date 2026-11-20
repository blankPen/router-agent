import type { LogEntry } from '../log-tail.js'
import type { LogEvidence } from './types.js'
import { MAX_ASSISTANT_EVIDENCE } from './types.js'

// ---------------------------------------------------------------------------
// 证据挑选
// ---------------------------------------------------------------------------

interface SelectionInput {
  question: string
  level?: string
  keyword?: string
}

/**
 * 按面板上的级别与关键字过滤日志。
 *
 * 助手与日志页共用同一套过滤：用户看到的范围就是排查范围，
 * 结论里引用的事件也一定在这个范围里。
 */
export function filterEntries(entries: LogEntry[], input: { level?: string; keyword?: string }): LogEntry[] {
  const level = (input.level ?? 'all').trim()
  const keyword = (input.keyword ?? '').trim().toLowerCase()
  return entries
    .filter(entry => level === 'all' || entry.level === level)
    .filter(entry => !keyword || haystack(entry).includes(keyword))
}

/**
 * 从日志里挑出与问题相关的条目。
 *
 * 顺序是「分诊顺序」：错误 → 警告 → 普通信息，同级里越新越靠前。
 * 相关度（与问题关键词的重合）只决定「挑哪 40 条」，不参与排序——
 * 否则一条无关的报错会盖掉真正相关的那条链路。
 */
export function selectEvidence(entries: LogEntry[], input: SelectionInput): LogEvidence[] {
  const tokens = tokenize(input.question)
  const filtered = filterEntries(entries, input)
  const total = Math.max(filtered.length, 1)

  const scored = filtered
    .map((entry, index) => {
      const text = haystack(entry)
      const hits = tokens.reduce((sum, token) => (text.includes(token) ? sum + 1 : sum), 0)
      // recency 用下标近似：日志按时间递增写入，越靠后越新。
      const recency = (index / total) * 4
      return { entry, score: levelWeight(entry.level) * 10 + hits * 3 + recency }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ASSISTANT_EVIDENCE)

  return sortEvidence(scored.map(item => toEvidence(item.entry)))
}

/** 分诊排序：错误 → 警告 → 普通信息；同级里越新越靠前。 */
export function sortEvidence(items: LogEvidence[]): LogEvidence[] {
  return [...items].sort((a, b) => {
    const rank = levelWeight(b.level) - levelWeight(a.level)
    if (rank !== 0) return rank
    if (a.at && b.at) return a.at < b.at ? 1 : a.at > b.at ? -1 : 0
    return 0
  })
}

function levelWeight(level: string): number {
  if (level === 'error') return 4
  if (level === 'warn') return 3
  if (level === 'raw') return 2
  if (level === 'info') return 1
  return 0
}

function haystack(entry: LogEntry): string {
  return `${entry.message} ${JSON.stringify(evidenceData(entry))}`.toLowerCase()
}

/**
 * 证据里的字段：结构维度 + 业务字段。
 *
 * 群、发起人、运行时这些已经单独成列，但排查时它们恰恰是最关键的证据，
 * 不能因为分了列就从证据里丢掉。
 */
export function evidenceData(entry: LogEntry): Record<string, unknown> {
  return {
    ...(entry.chat ? { chat: entry.chat } : {}),
    ...(entry.chatName ? { chatName: entry.chatName } : {}),
    ...(entry.actor ? { actor: entry.actor } : {}),
    ...(entry.actorName ? { actorName: entry.actorName } : {}),
    ...(entry.actorType ? { actorType: entry.actorType } : {}),
    ...(entry.runtime ? { runtime: entry.runtime } : {}),
    ...(entry.ticket ? { ticket: entry.ticket } : {}),
    ...(entry.trace ? { trace: entry.trace } : {}),
    ...(entry.data ?? {}),
  }
}

export function toEvidence(entry: LogEntry): LogEvidence {
  const data = evidenceData(entry)
  const detail = Object.entries(data)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(' ')
  return {
    at: entry.at,
    level: entry.level,
    message: entry.message,
    ...(detail ? { detail } : {}),
    ...(Object.keys(data).length > 0 ? { data } : {}),
  }
}

/**
 * 发给模型前抹掉正文类字段。
 *
 * 日志里有 `input:queued.text`、`outbox:sent.text` 这类带用户消息正文的字段，
 * 排查并不需要它们，但把它们原样发给外部模型就是泄露用户内容。
 * 按 key 脱敏而不是按字符串猜：字段值里可能有空格，猜不准就会漏。
 */
export function redactFields(data: Record<string, unknown> | undefined): string {
  if (!data) return ''
  return Object.entries(data)
    .map(([key, value]) => `${key}=${REDACT_KEYS.has(key) ? '（内容已省略）' : formatValue(value)}`)
    .join(' ')
}

const REDACT_KEYS = new Set(['text', 'reply', 'summary', 'preview', 'content', 'body', 'prompt'])

export function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/**
 * 把问题拆成关键词。
 *
 * 中文按二元组切（避免整句匹配不到），英文与数字按整词切；常见虚词二元组丢掉。
 */
export function tokenize(question: string): string[] {
  const text = question.toLowerCase()
  const tokens = new Set<string>()
  const latin = text.match(/[a-z0-9_]{2,}/g) ?? []
  for (const word of latin) tokens.add(word)

  for (const run of text.match(/[一-龥]+/g) ?? []) {
    if (run.length === 1) {
      tokens.add(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i += 1) {
      const gram = run.slice(i, i + 2)
      if (!STOP_GRAMS.has(gram)) tokens.add(gram)
    }
  }
  return [...tokens]
}

const STOP_GRAMS = new Set([
  '什么', '怎么', '为什', '么办', '如何', '这个', '那个', '可以', '不能',
  '没有', '一下', '请问', '帮忙', '还是', '但是', '所以', '因为', '已经',
  '现在', '一直', '突然', '一直', '不太', '有点', '现在',
])
