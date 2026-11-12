/**
 * Web 面板「日志」页的智能问题排查助手。
 *
 * 排障的第一入口是日志，但日志本身只说「发生了什么」，不说「这意味着什么」。
 * 这里做两件事：
 *
 * 1. **挑证据**：从最近的服务日志里按用户问题挑出相关条目（错误 / 警告优先）；
 * 2. **给结论**：优先让配置的模型总结；模型没配或调用失败时，退回内置的
 *    「事件名 → 症状」知识库做规则式判断，保证助手永远有话说。
 *
 * 规则式降级不是摆设：现场机器经常还没配好模型，但日志事件名是固定的，
 * 靠知识库照样能指出「消息被 allowed 规则丢掉了」这类结论。
 */
import { preview } from '../core/events.js'
import { noopLogger, errorMessage, type Logger } from '../infra/logger.js'
import { createChatClient, type ChatClient, type ChatMessage, type ChatModelConfig } from '../infra/chat.js'
import { extractJsonObject } from './model-config.js'
import { readLogs, type LogEntry } from './log-tail.js'
import { toolSpecs, type DiagnosisTool } from './diagnosis-tools.js'

/** 一次排查最多带多少条证据给模型。 */
export const MAX_ASSISTANT_EVIDENCE = 40
/** 读取日志时一次回看的行数上限。 */
const READ_LIMIT = 500
/** 用户问题的字符上限，超出部分截断。 */
const MAX_QUESTION_CHARS = 2_000

export interface LogAssistantQuestion {
  /** 用户描述的问题。 */
  question: string
  /** 面板上的级别过滤（all / info / warn / error）。 */
  level?: string
  /** 面板上的关键字过滤。 */
  keyword?: string
}

export interface LogEvidence {
  at: string
  level: string
  /** 事件名（域:动作）。 */
  message: string
  /** 事件里的关键字段摘要。 */
  detail?: string
  /** 事件里的原始字段；发给模型前按 key 脱敏。 */
  data?: Record<string, unknown>
}

export interface LogCause {
  /** 结论标题。 */
  title: string
  /** 为什么得出这个结论。 */
  detail: string
  /** 支撑这个结论的日志事件名。 */
  events: string[]
  /** 模型给出的处置分类：config = 用户自己能改；defect = 应上报。 */
  category?: 'config' | 'defect'
}

export interface LogDiagnosis {
  /** 一句话结论。 */
  summary: string
  /** 可能的原因。 */
  causes: LogCause[]
  /** 建议的下一步。 */
  actions: string[]
  /** 证据日志。 */
  evidence: LogEvidence[]
  /** llm = 模型总结；rules = 规则降级。 */
  source: 'llm' | 'rules'
  /** 降级原因；正常总结时为空。 */
  degraded?: string
  /** 助手用到的工具，让用户知道结论是基于什么得出的。 */
  toolsUsed?: string[]
  /** 处置建议：配置类引导去改配置，缺陷类引导一键上报 issue。 */
  next?: LogNextStep[]
}

/** 处置建议。 */
export interface LogNextStep {
  /** config = 引导去改配置；issue = 一键上报 GitHub issue。 */
  kind: 'config' | 'issue'
  /** 按钮文案。 */
  label: string
  /** kind=config 时：配置页的 section id（sec-<id>），留空表示只跳到配置页。 */
  section?: string
  /** kind=issue 时：建议的 issue 标题。 */
  issueTitle?: string
}

/** 面板上的常见问题入口。 */
export interface LogSuggestion {
  id: string
  title: string
  /** 填进输入框的示例问题。 */
  example: string
}

export interface LogAssistant {
  diagnose(question: LogAssistantQuestion): Promise<LogDiagnosis>
  /** 面板展示的常见问题。 */
  suggestions(): LogSuggestion[]
  /** 模型是否配齐（决定面板提示「去配置模型」还是「模型总结」）。 */
  llmConfigured(): boolean
}

export interface LogAssistantOptions {
  /** 服务日志路径。 */
  logPath: string
  /** 研判模型配置；缺省时只走规则式降级。 */
  model?: ChatModelConfig | null
  /** 助手的只读工具（读配置 / 读本地代码）；缺省时模型只能看日志。 */
  tools?: DiagnosisTool[]
  logger?: Logger
  /** 测试注入点。 */
  fetchImpl?: typeof fetch
  /** 模型请求超时，默认 60s。 */
  timeoutMs?: number
}

/**
 * 常见问题模式：事件名 → 人话结论。
 *
 * 事件名取自 docs/OPERATIONS.md 的日志事件表；新增事件时同步补这里，
 * 规则式排查才能跟上日志的演进。
 */
const SYMPTOMS: Array<{
  id: string
  title: string
  /** 面板快捷入口里预填的示例问题。 */
  example: string
  /**
   * 处置方向：config = 引导去改配置；defect = 缺陷 / 体验问题，适合一键上报 issue。
   */
  kind: 'config' | 'defect'
  /** kind=config 时的引导目标：配置页的 section id（留空表示只跳到配置页）。 */
  section?: string
  /** kind=config 时给用户的按钮文案。 */
  fixLabel?: string
  events: string[]
  keywords: string[]
  advice: string[]
}> = [
  {
    id: 'message-ignored',
    title: '消息进来了但被过滤 / 机器人没反应',
    example: '飞书里发消息机器人完全没反应，日志里能看到消息吗？',
    kind: 'config',
    section: 'feishu',
    fixLabel: '去修改「飞书消息 · 允许名单」',
    events: [
      'trigger:dropped', 'trigger:duplicate', 'feishu:bot-identity-failed',
      'feishu:allowlist-empty', 'feishu:chat-allowlist-empty', 'identity:resolve-failed',
      'identity:refresh-failed', 'identity:retry-exhausted', 'identity:retry-deferred',
      'config:identity-invalid', 'feishu:consumer-start-failed', 'feishu:reconnecting',
    ],
    keywords: ['没反应', '不理我', '不回', '没收到', '消息丢了', '不响应'],
    advice: [
      '看 trigger:dropped 的 reason 字段：allowed 规则挡掉、身份没识别、还是消息类型不支持。',
      '确认允许名单里的邮箱 / open_id 都能解析成 open_id（identity:resolve-failed / identity:retry-exhausted 表示有人没解析出来）。',
      '群聊需要 @ 机器人时，检查 feishu:bot-identity-failed：机器人身份没识别出来会丢掉整群消息。',
      'trigger:duplicate 是去重命中，不是消息丢失。',
    ],
  },
  {
    id: 'config-not-effective',
    title: '配置改了不生效',
    example: '我在面板上改了配置，保存成功了但行为没变，为什么？',
    kind: 'config',
    fixLabel: '去「配置」页逐项核对',
    events: [
      'config:parse-failed', 'config:patch-rejected', 'config:write-failed',
      'config:legacy-backend', 'config:invalid-security-override',
      'identity:refresh-failed', 'config:identity-invalid',
    ],
    keywords: ['不生效', '没生效', '配置', '保存', '重启'],
    advice: [
      '看 api:config 的 restartRequired：策略类配置立即生效，其余要重启服务（daemon 热重启）后才生效。',
      'config:parse-failed 说明 config.yaml 解析失败，服务已降级用默认配置启动，配置等于没加载。',
      'config:patch-rejected / config:write-failed 是保存被拒或落盘失败，面板上的「保存成功」不代表写进去了。',
      '允许名单类改动看 identity:refresh-failed：保存成功但重新解析失败，新名单暂未生效。',
    ],
  },
  {
    id: 'ticket-not-created',
    title: '消息没有变成工单 / 没派工',
    example: '消息被收到了但没有建工单，也没有派工出去，排查一下。',
    kind: 'config',
    section: 'policy',
    fixLabel: '去检查「准入策略 · 接单模式」',
    events: [
      'decision:engine-failed', 'loop:trigger-failed', 'chat:reply-failed',
    ],
    keywords: ['工单', '派工', '没开始', '没建', '没派'],
    advice: [
      '先确认 trigger:ingested 出现过：没有这条说明消息根本没进系统，问题在接入层不在研判层。',
      'router:decision 的 decision 字段说明研判结论；ask 之外的决定都要在工单页复核。',
      'decision:engine-failed 表示研判模型调用失败，这一轮按不可用处理。',
      'chat:reply-failed 只是回复生成失败退回固定话术，不影响已经建好的工单。',
    ],
  },
  {
    id: 'worker-stuck',
    title: 'Worker 卡住 / 执行失败',
    example: '工单里的 worker 好像卡住了，一直没有进展，帮我看看。',
    kind: 'defect',
    events: [
      'worker:status-failed', 'codex:turn-failed', 'codex:process-exit', 'codex:resume-failed',
      'codex:launch-failed', 'effect:failed', 'worker:event-log-failed',
      'idle:stale', 'codex:error',
    ],
    keywords: ['卡住', '不动', 'worker', '超时', '没进展', '执行失败'],
    advice: [
      'worker:status-failed 是活性查询失败，先按「状态未知」处理，别当成 worker 死了。',
      'codex:turn-failed 表示这一轮执行失败，会转人工；detail 里有失败原因。',
      'codex:process-exit 是 app-server 子进程退出，通常伴随 codex:turn-failed 一起出现。',
      'effect:failed 说明派工 / 停止 / 清理这类内部动作没执行成功，error 字段是原因。',
    ],
  },
  {
    id: 'service-error',
    title: '服务自身报错 / 面板打不开',
    example: '面板打不开或者服务在报错，帮我定位一下。',
    kind: 'defect',
    events: [
      'api:request-failed', 'config:parse-failed', 'session:migration-required',
      'session:migration-incomplete', 'feishu:consumer-start-failed', 'update:upgrade-failed',
      'update:service-stop-failed', 'config:invalid-security-override',
    ],
    keywords: ['服务', '启动不了', '报错', '500', '打不开', '崩溃'],
    advice: [
      'api:request-failed 带 method / path / detail，先定位是哪个接口挂的。',
      'session:migration-required 表示还有没迁移的历史 sessionKey，服务会拒绝启动，按提示执行迁移。',
      'config:parse-failed 会让服务带着默认配置启动，先修 config.yaml 的 YAML 语法。',
      'feishu:consumer-start-failed 是飞书事件消费者没起来，机器人会完全收不到消息。',
    ],
  },
  {
    id: 'reply-not-sent',
    title: '回复 / 通知没发出去',
    example: '工单处理完了，但飞书那边没有收到回复，消息发出去了吗？',
    kind: 'defect',
    events: [
      'outbox:failed', 'channel:not-registered', 'feishu:card-fallback',
      'chat:reply-failed', 'channel:ack-failed',
    ],
    keywords: ['没发出去', '没回复', '发送失败', '通知'],
    advice: [
      'outbox:failed 带 error 字段，是对外投递失败的最终结果。',
      'channel:not-registered 表示 Outbox 里的通道没注册（历史脏数据），不会卡住队列。',
      'feishu:card-fallback 是互动卡片发不出去降级成富文本，消息仍然送达。',
      'progress:dedup 只是进展内容重复被跳过，不是丢消息。',
    ],
  },
  {
    id: 'pr-tracking',
    title: 'PR / MR 状态查不到',
    example: '工单关联的 PR 状态一直查不到，帮我看看为什么。',
    kind: 'defect',
    events: [
      'pr:track-failed', 'pr:inspect-failed', 'pr:repo-slug-failed',
      'report:evidence-missing', 'report:evidence-unverified', 'report:ingest-failed',
    ],
    keywords: ['pr', 'mr', '合并', '状态', '证据'],
    advice: [
      'pr:inspect-failed / pr:repo-slug-failed 是取 PR 线索失败，服务会等 gh 兜底。',
      'report:evidence-missing 说明 UI 改动没交 Before / After 证据，enforce 档会被打回。',
      'report:ingest-failed 表示上报没被兜底通道正常吞下，看 message 字段。',
    ],
  },
]

/** 常见问题的快捷入口，直接取自知识库，保证面板与后端同步。 */
export function logSuggestions(): LogSuggestion[] {
  return SYMPTOMS.map(item => ({ id: item.id, title: item.title, example: item.example }))
}

/** 创建日志排查助手。 */
export function createLogAssistant(opts: LogAssistantOptions): LogAssistant {
  const logger = opts.logger ?? noopLogger
  const model = opts.model ?? null
  const llmReady = Boolean(model && model.baseUrl && model.apiKey && model.model)

  let client: ChatClient | null = null
  if (llmReady && model) {
    client = createChatClient(model, {
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    })
  }

  // 串行化：面板并发点「分析」时排队，避免一次风暴把模型打爆。
  let queue: Promise<unknown> = Promise.resolve()

  const run = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task)
    // 队列本身吞掉异常，避免一次失败卡住后面的请求。
    queue = next.catch(() => undefined)
    return next
  }

  return {
    llmConfigured(): boolean {
      return llmReady
    },

    suggestions(): LogSuggestion[] {
      return logSuggestions()
    },

    diagnose(question: LogAssistantQuestion): Promise<LogDiagnosis> {
      return run(async () => {
        const text = question.question.trim().slice(0, MAX_QUESTION_CHARS)
        const read = readLogs(opts.logPath, { limit: READ_LIMIT })
        const entries = read.entries
        // 助手与日志页共用同一套过滤：用户看到的范围就是排查范围。
        const scoped = filterEntries(entries, {
          ...(question.level ? { level: question.level } : {}),
          ...(question.keyword ? { keyword: question.keyword } : {}),
        })
        const hits = matchSymptoms(scoped)
        const evidence = selectEvidence(scoped, { question: text })
        // 结论里提到的事件必须在证据里看得见，否则用户无法自行核对。
        const withEvidence = ensureEvidence(evidence, scoped, hits.flatMap(hit => hit.events))

        if (client) {
          try {
            const answer = await askModel(client, text, withEvidence, opts.tools ?? [])
            logger.info('logs:assistant-answered', {
              question: preview(text, 120),
              evidence: withEvidence.length,
              source: 'llm',
              ...(answer.toolsUsed?.length ? { tools: answer.toolsUsed.join(',') } : {}),
            })
            return answer
          } catch (error) {
            const reason = errorMessage(error)
            logger.warn('logs:assistant-model-failed', {
              question: preview(text, 120),
              detail: preview(reason, 200),
            })
            return {
              ...ruleDiagnosis(text, withEvidence, hits),
              degraded: `模型总结失败，已退回规则排查：${reason}`,
            }
          }
        }

        const diagnosis = ruleDiagnosis(text, withEvidence, hits)
        logger.info('logs:assistant-answered', {
          question: preview(text, 120),
          evidence: withEvidence.length,
          source: 'rules',
        })
        return diagnosis
      })
    },
  }
}

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
function sortEvidence(items: LogEvidence[]): LogEvidence[] {
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
  return `${entry.message} ${entry.data ? JSON.stringify(entry.data) : ''}`.toLowerCase()
}

function toEvidence(entry: LogEntry): LogEvidence {
  const data = entry.data ?? {}
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

function formatValue(value: unknown): string {
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

// ---------------------------------------------------------------------------
// 规则式结论
// ---------------------------------------------------------------------------

/**
 * 不依赖模型的结论：靠事件名命中已知问题模式。
 *
 * 排序兼顾「与问题的相关度」与「命中的事件数量」：用户问的是哪一类，
 * 就先把那一类放前面；日志里同时存在的其它已知模式只作为补充。
 */
export function ruleDiagnosis(question: string, evidence: LogEvidence[], hits: SymptomHit[]): LogDiagnosis {
  const ranked = [...hits].sort((a, b) => hitScore(question, b) - hitScore(question, a))
  const primary = ranked[0]
  const shown = ranked.slice(0, 3)

  const causes: LogCause[] = shown.map(item => ({
    title: item.symptom.title,
    detail: `日志里出现了 ${item.events.join('、')}。`,
    events: item.events,
  }))

  const actions: string[] = []
  for (const item of shown) {
    for (const advice of item.symptom.advice) {
      if (!actions.includes(advice)) actions.push(advice)
    }
  }

  // 问题描述命中的模式即使日志里没有对应事件，也给一条「该往哪看」的方向。
  for (const symptom of SYMPTOMS) {
    if (hits.some(item => item.symptom.id === symptom.id)) continue
    if (!symptom.keywords.some(keyword => question.includes(keyword))) continue
    const advice = `你描述的现象属于「${symptom.title}」，但当前日志里没有对应事件，可以确认日志范围是否覆盖了出问题的时间段。`
    if (!actions.includes(advice)) actions.push(advice)
  }

  const summary = causes.length === 0
    ? evidence.length > 0
      ? `最近 ${evidence.length} 条日志里没有命中已知问题模式，需要人工判断。`
      : '当前筛选范围内没有可用日志，无法给出结论；放宽级别或关键字过滤再试。'
    : primary && matchesQuestion(question, primary.symptom)
      ? `最可能是「${primary.symptom.title}」：日志里出现了 ${primary.events.join('、')}。`
        + (ranked.length > 1 ? `另外还命中 ${ranked.length - 1} 类已知问题模式，见下方。` : '')
      : `命中 ${causes.length} 类已知问题模式：${causes.map(cause => cause.title).join('；')}。`

  return {
    summary,
    causes,
    actions: actions.slice(0, 8),
    evidence,
    source: 'rules',
    next: nextStepsFor(ranked, question),
  }
}

/**
 * 由命中的问题模式推导处置建议。
 *
 * 动作按**最可能的那一类**排在前面：用户要的是一个判断——配置类去改配置，
 * 缺陷 / 体验类去上报 issue。
 *
 * 但两类都命中时**两个入口都给**：日志里同时出现「配置没生效」和「Worker 卡住」，
 * 只给配置按钮的话，缺陷就永远报不上去——上报 issue 的入口必须是可达的。
 */
export function nextStepsFor(hits: SymptomHit[], question: string): LogNextStep[] {
  const primary = hits[0]
  if (primary) {
    if (primary.symptom.kind === 'config') {
      const steps: LogNextStep[] = [{
        kind: 'config',
        label: primary.symptom.fixLabel ?? `去「配置」页检查与「${primary.symptom.title}」相关的设置`,
        ...(primary.symptom.section ? { section: primary.symptom.section } : {}),
      }]
      const defect = hits.find(item => item.symptom.kind === 'defect')
      if (defect) steps.push(issueStepOf(defect))
      return steps
    }
    return [issueStepOf(primary)]
  }
  // 日志里没有命中事件，但问题描述点名了配置类现象：给一条配置引导。
  for (const symptom of SYMPTOMS) {
    if (symptom.kind !== 'config') continue
    if (!symptom.keywords.some(keyword => question.includes(keyword))) continue
    return [{
      kind: 'config',
      label: symptom.fixLabel ?? `去「配置」页检查与「${symptom.title}」相关的设置`,
      ...(symptom.section ? { section: symptom.section } : {}),
    }]
  }
  return []
}

/** 缺陷类症状对应的「上报 issue」入口。 */
function issueStepOf(hit: SymptomHit): LogNextStep {
  return {
    kind: 'issue',
    label: '一键上报 GitHub issue',
    issueTitle: `[排查助手] ${hit.symptom.title}`,
  }
}

/** 问题里是否点名了这一类症状。 */
function matchesQuestion(question: string, symptom: (typeof SYMPTOMS)[number]): boolean {
  return symptom.keywords.some(keyword => question.includes(keyword))
}

/**
 * 命中的排序分：问题点名的关键词越多越靠前，其次看命中的事件数量。
 *
 * 按命中的关键词个数而不是「有没有命中」计分：用户问「工单里的 worker 卡住了」
 * 同时点了两类症状，worker 类命中「worker」「卡住」两个词才不会被工单类抢走。
 */
function hitScore(question: string, hit: SymptomHit): number {
  const keywords = hit.symptom.keywords.filter(keyword => question.includes(keyword)).length
  return keywords * 10 + hit.events.length
}

/** 命中的问题模式。 */
export interface SymptomHit {
  symptom: (typeof SYMPTOMS)[number]
  /** 命中的日志事件名。 */
  events: string[]
}

/** 按事件名匹配已知问题模式；命中的事件越多越可能是根因。 */
export function matchSymptoms(entries: LogEntry[]): SymptomHit[] {
  const seen = new Set<string>()
  for (const entry of entries) seen.add(entry.message)
  return SYMPTOMS
    .map(symptom => ({ symptom, events: symptom.events.filter(event => seen.has(event)) }))
    .filter(item => item.events.length > 0)
    .sort((a, b) => b.events.length - a.events.length)
}

/**
 * 把命中事件的原始条目补进证据。
 *
 * 结论里引用的事件名如果不在证据列表里，用户就没法自己核对，
 * 这里保证「结论提到的 = 证据里看得见的」。
 */
export function ensureEvidence(evidence: LogEvidence[], entries: LogEntry[], events: string[]): LogEvidence[] {
  const missing = new Set(events)
  for (const item of evidence) missing.delete(item.message)
  if (missing.size === 0) return evidence

  const merged = [...evidence]
  for (const entry of entries) {
    if (!missing.has(entry.message)) continue
    missing.delete(entry.message)
    merged.push(toEvidence(entry))
    if (merged.length >= MAX_ASSISTANT_EVIDENCE) break
  }
  return sortEvidence(merged)
}

// ---------------------------------------------------------------------------
// 模型总结
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  '你是 router-agent（飞书消息 → 研判 → 派工到 worker 的双层 Agent 系统）的运维排查助手。',
  '用户会给出遇到的问题和相关的服务日志（每行一条 JSON 事件，事件名形如 域:动作）。',
  '请只依据给出的日志判断，不要编造日志里没有的事实；信息不足时明确说「日志里看不到」。',
  '可以调用工具查看本机的 router-agent 配置与安装目录下的代码来核实判断；工具是只读的，只能读不能改。',
  '输出严格的 JSON，不要加解释性文字或代码块围栏：',
  '{"summary":"一句话结论","causes":[{"title":"可能原因","detail":"为什么","events":["支撑的事件名"],"category":"config|defect"}],"actions":["建议的下一步操作"]}',
  'causes 最多 3 条，actions 最多 5 条；没有证据支撑的原因不要写。',
  'category 填 config 表示这是配置问题、用户自己能改，填 defect 表示这是缺陷或体验问题、应该上报。',
].join('\n')

/** 模型最多能连着调几轮工具。 */
const MAX_TOOL_ROUNDS = 6

/**
 * 让模型基于证据总结结论；解析失败会抛错，由调用方降级到规则式判断。
 *
 * 模型可以要求调用只读工具（读配置 / 读本地代码），工具结果回灌给它继续判断，
 * 最多 MAX_TOOL_ROUNDS 轮，避免无限循环。
 */
export async function askModel(
  client: ChatClient,
  question: string,
  evidence: LogEvidence[],
  tools: DiagnosisTool[] = [],
): Promise<LogDiagnosis> {
  const lines = evidence.map(item => {
    const fields = item.data ? redactFields(item.data) : (item.detail ?? '')
    return `${item.at || '-'} ${item.level.toUpperCase()} ${item.message}${fields ? ` ${fields}` : ''}`
  })
  const user = [
    `问题：${question || '（用户没有描述具体问题，请总结最近日志里最值得关注的事）'}`,
    '',
    `相关日志（共 ${lines.length} 条）：`,
    ...(lines.length > 0 ? lines : ['（没有匹配到日志条目）']),
    '',
    '已知问题模式（事件名 → 症状）：',
    ...SYMPTOMS.map(symptom => `- ${symptom.id}：${symptom.title}（相关事件：${symptom.events.slice(0, 6).join('、')}）`),
  ].join('\n')

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]
  const specs = toolSpecs(tools)
  const toolsUsed = new Set<string>()

  let raw = ''
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const turn = await client.complete(messages, specs.length > 0 ? { tools: specs } : {})
    raw = turn.content
    if (turn.toolCalls.length === 0 || tools.length === 0) break

    messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls })
    for (const call of turn.toolCalls) {
      const tool = tools.find(item => item.spec.name === call.name)
      const output = tool
        ? safeRunTool(tool, call.arguments)
        : `没有这个工具：${call.name}。可用工具：${tools.map(item => item.spec.name).join('、')}。`
      toolsUsed.add(call.name)
      messages.push({ role: 'tool', content: output, toolCallId: call.id })
    }
    if (round === MAX_TOOL_ROUNDS) break
  }

  const parsed = extractJsonObject(raw)
  if (!parsed) throw new Error('assistant:model-invalid-json')

  const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
    ? parsed.summary.trim()
    : '模型没有给出结论摘要。'
  const causes = Array.isArray(parsed.causes)
    ? parsed.causes.slice(0, 3).map(item => {
      const record = (item ?? {}) as Record<string, unknown>
      const category: 'config' | 'defect' | undefined =
        record.category === 'config' || record.category === 'defect' ? record.category : undefined
      return {
        title: String(record.title ?? '可能原因'),
        detail: String(record.detail ?? ''),
        events: Array.isArray(record.events) ? (record.events as unknown[]).map(event => String(event)) : [],
        ...(category ? { category } : {}),
      }
    })
    : []
  const actions = Array.isArray(parsed.actions)
    ? parsed.actions.slice(0, 5).map(item => String(item))
    : []

  const next = nextStepsFromCauses(causes)

  return {
    summary,
    causes,
    actions,
    evidence,
    source: 'llm',
    ...(toolsUsed.size > 0 ? { toolsUsed: [...toolsUsed] } : {}),
    ...(next.length > 0 ? { next } : {}),
  }
}

/**
 * 由模型给出的处置分类推导按钮。
 *
 * 模型给 causes 标了 config / defect 时，页面才有「去改配置」或「上报 issue」的入口；
 * 没标就不硬塞按钮，避免给错方向。
 *
 * 分类不一致时两个入口都给：只看第一条的话，排在后面的缺陷会被吞掉，
 * 用户想反馈问题时页面上找不到上报入口。
 */
export function nextStepsFromCauses(causes: LogCause[]): LogNextStep[] {
  // 与规则式排查一致：只按最可能的那条原因给动作。
  const primary = causes.find(cause => cause.category)
  if (!primary?.category) return []
  const steps: LogNextStep[] = []
  if (primary.category === 'config') {
    steps.push({ kind: 'config', label: '去「配置」页按建议修改' })
    // 还有缺陷类原因就一并给上报入口，别让缺陷被配置引导挡住。
    if (causes.some(cause => cause.category === 'defect')) {
      steps.push({ kind: 'issue', label: '一键上报 GitHub issue' })
    }
    return steps
  }
  steps.push({ kind: 'issue', label: '一键上报 GitHub issue' })
  return steps
}

/** 工具执行出错不该拖垮整次排查：把错误当工具结果回给模型。 */
function safeRunTool(tool: DiagnosisTool, args: Record<string, unknown>): string {
  try {
    return tool.run(args)
  } catch (error) {
    return `工具执行失败：${error instanceof Error ? error.message : String(error)}`
  }
}
