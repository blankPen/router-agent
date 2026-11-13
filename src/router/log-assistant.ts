/**
 * Web 面板的智能问题排查助手。
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
 *
 * 结论面向普通用户，所以输出是**结构化**的（结论 / 引导动作 / 补充细节），
 * 由前端渲染：原始日志与专业术语都放进折叠的补充信息里，
 * 主交互语句只留「发生了什么」与「现在该做什么」。
 */
import { preview } from '#core/events.js'
import { noopLogger, errorMessage, type Logger } from '#infra/logger.js'
import { createChatClient, type ChatClient, type ChatMessage, type ChatModelConfig } from '#infra/chat.js'
import { extractJsonObject } from './model-config.js'
import { readLogTail, type LogEntry } from './log-tail.js'
import { filterByWindow, logWindow, type LogWindow } from './log-window.js'
import { toolSpecs, type DiagnosisTool } from './diagnosis-tools.js'

/** 一次排查最多带多少条证据给模型。 */
export const MAX_ASSISTANT_EVIDENCE = 40
/**
 * 读取日志时一次回看的行数上限。
 *
 * 取 5000 而不是 500：服务繁忙时一小时内能写几千行日志，
 * 只看最后 500 行的话，早先的 error 会被 info 挤出去——
 * 排查助手给出的证据里一条错误都没有，用户上报 issue 时正文也就没有错误日志。
 */
const READ_LIMIT = 5_000
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
  /** 结论标题（人话，不带事件名）。 */
  title: string
  /** 为什么得出这个结论；属于补充细节，主界面默认折叠。 */
  detail: string
  /** 支撑这个结论的日志事件名；属于补充细节。 */
  events: string[]
  /** 模型给出的处置分类：config = 用户自己能改；defect = 应上报。 */
  category?: 'config' | 'defect'
}

/**
 * 一条排查结论。
 *
 * 分三段对应普通用户的三件事：
 * - `summary`：发生了什么（人话）；
 * - `actions`：现在该做什么（可执行的动作）；
 * - `details`：原始日志与专业术语（折叠起来，不打扰主流程）。
 */
export interface LogDiagnosis {
  /** 一句话结论：面向用户说明当前发生了什么。 */
  summary: string
  /** 可能的原因；每条都带人话标题，detail / events 属于补充细节。 */
  causes: LogCause[]
  /** 建议的下一步：用户照着做就行。 */
  actions: string[]
  /** 证据日志；属于补充细节。 */
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

/**
 * 面板打开时先展示的「当前状态摘要」。
 *
 * 不用等用户点「分析」：面板一打开就把当前存在的异常、配置错误与配置遗漏摆出来，
 * 用户看完再决定要不要发起一次分析。
 */
export interface LogAssistantOverview {
  /** 窗口内的错误日志条数。 */
  errorCount: number
  /** 窗口内的警告日志条数。 */
  warnCount: number
  /** 窗口内最值得看的错误（人话摘要），同一类问题只列一条。 */
  issues: LogOverviewIssue[]
  /** 配置自检结果里不通过的项目。 */
  configIssues: LogOverviewConfigIssue[]
  /** 窗口说明：当前看的是哪段时间、哪个版本。 */
  window: { since: string; version: string }
}

/** 一条异常摘要：给人看的错误说明。 */
export interface LogOverviewIssue {
  /** 事件名。 */
  event: string
  /** 人话说明：这个错误意味着什么。 */
  title: string
  /** 补充细节：错误详情。 */
  detail?: string
  /** 发生时间。 */
  at: string
  /** 建议动作：用户下一步该做什么。 */
  action?: string
}

/** 一条配置问题：缺什么、去哪改。 */
export interface LogOverviewConfigIssue {
  /** 检查项名称。 */
  name: string
  /** 缺什么 / 错在哪。 */
  detail: string
  /** 改法。 */
  hint?: string
  /** 面板配置页分组 id；用户点「去修改」直接跳过去。 */
  section?: string
  /** 缺的具体配置项。 */
  items?: string[]
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

export interface LogAssistant {
  diagnose(question: LogAssistantQuestion): Promise<LogDiagnosis>
  /** 面板打开时展示的当前状态摘要。 */
  overview(): LogAssistantOverview
  /** 模型是否配齐（决定面板提示「去配置模型」还是「模型总结」）。 */
  llmConfigured(): boolean
}

export interface LogAssistantOptions {
  /** 服务日志路径。 */
  logPath: string
  /** 当前版本号；用于判断日志是不是当前版本还在报。 */
  version?: string
  /** 配置自检结果（不联网的那部分）；面板用它指出配置遗漏。 */
  configChecks?: () => { name: string; status: 'ok' | 'warn' | 'fail'; detail: string; hint?: string; section?: string; items?: string[] }[]
  /** 研判模型配置；缺省时只走规则式降级。 */
  model?: ChatModelConfig | null
  /** 助手的只读工具（读配置 / 读本地代码）；缺省时模型只能看日志。 */
  tools?: DiagnosisTool[]
  logger?: Logger
  /** 测试注入点。 */
  fetchImpl?: typeof fetch
  /** 模型请求超时，默认 60s。 */
  timeoutMs?: number
  /** 时钟；测试可注入。 */
  now?: () => string
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
  /**
   * 一句话结论：面向普通用户说明「现在是什么情况」。
   * 不带事件名与字段名——专业术语属于折叠的补充细节。
   */
  conclusion: string
  /**
   * 处置方向：config = 引导去改配置；defect = 缺陷 / 体验问题，适合一键上报 issue。
   */
  kind: 'config' | 'defect'
  /**
   * kind=config 时的引导目标：配置页的分组 id（见 `src/web/client/fields.ts` 的 CONFIG_GROUPS）。
   * 留空表示只跳到配置页。
   */
  section?: string
  /** kind=config 时给用户的按钮文案。 */
  fixLabel?: string
  events: string[]
  keywords: string[]
  /**
   * 用户该做的事：说清「改哪一项、去哪改」。
   * 是主界面上的行动指引，不是技术细节。
   */
  steps: string[]
  /**
   * 技术细节：事件名、字段名、排查手法。
   * 只作为折叠的补充信息出现，不当主交互语句。
   */
  advice: string[]
}> = [
  {
    id: 'message-ignored',
    title: '消息进来了但被过滤 / 机器人没反应',
    conclusion: '消息收到了，但没通过「谁可以让机器人干活」这一关，所以机器人一直没回你。',
    kind: 'config',
    section: 'channels',
    fixLabel: '去改「允许名单」',
    events: [
      'trigger:dropped', 'trigger:duplicate', 'feishu:bot-identity-failed',
      'feishu:allowlist-empty', 'feishu:chat-allowlist-empty', 'identity:resolve-failed',
      'identity:refresh-failed', 'identity:retry-exhausted', 'identity:retry-deferred',
      'config:identity-invalid', 'feishu:consumer-start-failed', 'feishu:reconnecting',
    ],
    keywords: ['没反应', '不理我', '不回', '没收到', '消息丢了', '不响应'],
    steps: [
      '打开面板「配置 → 渠道配置 → 飞书 → 接收范围」，确认你的账号在「允许名单」里。',
      '名单里填邮箱最省事：填上邮箱保存后，系统会自动认出这是谁。',
      '群聊里需要 @ 机器人：如果连群里的消息也收不到，检查机器人是否在这个群里。',
    ],
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
    conclusion: '你改的配置没有真正生效：要么没写进配置文件，要么这类改动要重启服务后才生效。',
    kind: 'config',
    fixLabel: '去「配置」页逐项核对',
    events: [
      'config:parse-failed', 'config:patch-rejected', 'config:write-failed',
      'config:legacy-backend', 'config:invalid-security-override',
      'identity:refresh-failed', 'config:identity-invalid',
    ],
    keywords: ['不生效', '没生效', '配置', '保存', '重启'],
    steps: [
      '在「配置」页改完后点「保存并重启服务」，大多数设置要重启才生效。',
      '只有「接单方式」「允许名单」这类是保存即生效，不用重启。',
      '如果保存时报错，按面板上给出的原因改掉再保存——保存失败等于没改。',
    ],
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
    conclusion: '消息收到了，但没有开工单——多半是「接单方式」设成了只观察，或者这条消息还被当成闲聊。',
    kind: 'config',
    section: 'admission',
    fixLabel: '去改「接单方式」',
    events: [
      'decision:engine-failed', 'loop:trigger-failed', 'chat:reply-failed',
    ],
    keywords: ['工单', '派工', '没开始', '没建', '没派'],
    steps: [
      '打开面板「配置 → 消息准入 → 接单方式」，确认不是「只记录」或「只研判」。',
      '要让它自动开工单，把接单方式改成「直接接单」。',
      '如果只是想看看它怎么判断，先保持「只研判」，在「工单」页确认判断是否合理。',
    ],
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
    conclusion: '正在干活的那个执行进程出问题了，这一轮没做完——这是系统侧的问题，需要我们修。',
    kind: 'defect',
    events: [
      'worker:status-failed', 'codex:turn-failed', 'codex:process-exit', 'codex:resume-failed',
      'codex:launch-failed', 'effect:failed', 'worker:event-log-failed',
      'idle:stale', 'codex:error',
    ],
    keywords: ['卡住', '不动', 'worker', '超时', '没进展', '执行失败'],
    steps: [
      '点下面的「上报 GitHub issue」，把这次的日志和结论一起发给我们。',
      '同时可以在「工单」页停止这张工单，重新发一次同样的话让它重来。',
    ],
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
    conclusion: '服务自己报错了，不是你的配置问题——需要我们修。',
    kind: 'defect',
    events: [
      'api:request-failed', 'config:parse-failed', 'session:migration-required',
      'session:migration-incomplete', 'feishu:consumer-start-failed', 'update:upgrade-failed',
      'update:service-stop-failed', 'config:invalid-security-override',
    ],
    keywords: ['服务', '启动不了', '报错', '500', '打不开', '崩溃'],
    steps: [
      '点下面的「上报 GitHub issue」，把这次的日志和结论一起发给我们。',
      '如果连面板都打不开，在终端运行 ra logs 看最后几行，把输出一起贴给我们。',
    ],
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
    conclusion: '活已经干完了，但结果没发回飞书——投递这一步出了问题，需要我们修。',
    kind: 'defect',
    events: [
      'outbox:failed', 'channel:not-registered', 'feishu:card-fallback',
      'chat:reply-failed', 'channel:ack-failed',
    ],
    keywords: ['没发出去', '没回复', '发送失败', '通知'],
    steps: [
      '点下面的「上报 GitHub issue」，把这次的日志和结论一起发给我们。',
      '临时想看结果，可以直接看「工单」页里的进展记录。',
    ],
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
    conclusion: '关联的代码改动查不到状态——多半是没关联上仓库或凭据失效了。',
    kind: 'defect',
    events: [
      'pr:track-failed', 'pr:inspect-failed', 'pr:repo-slug-failed',
      'report:evidence-missing', 'report:evidence-unverified', 'report:ingest-failed',
    ],
    keywords: ['pr', 'mr', '合并', '状态', '证据'],
    steps: [
      '先确认工单关联的仓库地址写对了：面板「配置 → 项目清单」里的仓库路径。',
      '然后点下面的「上报 GitHub issue」，把这次的日志和结论一起发给我们。',
    ],
    advice: [
      'pr:inspect-failed / pr:repo-slug-failed 是取 PR 线索失败，服务会等 gh 兜底。',
      'report:evidence-missing 说明 UI 改动没交 Before / After 证据，enforce 档会被打回。',
      'report:ingest-failed 表示上报没被兜底通道正常吞下，看 message 字段。',
    ],
  },
]

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

  const now = opts.now ?? (() => new Date().toISOString())
  // 没传版本号时不按版本过滤：拿一个猜不到的版本去比，只会把日志全滤光。
  const version = opts.version ?? ''

  /** 当前排查窗口：最近 3 小时 + 当前版本。 */
  const currentWindow = (): LogWindow => logWindow({ version, now: now() })

  /** 读日志并按窗口收敛：窗口外与旧版本的日志一律不纳入排查。 */
  const scopedEntries = (): LogEntry[] => {
    const entries = readLogTail(opts.logPath, { lines: READ_LIMIT })
    return filterByWindow(entries, currentWindow())
  }

  /** 上一次的概览计数：只在变化时记日志，避免面板每次打开都刷一条。 */
  let lastOverview = ''

  return {
    llmConfigured(): boolean {
      return llmReady
    },

    overview(): LogAssistantOverview {
      const window = currentWindow()
      const entries = scopedEntries()
      const errors = entries.filter(entry => entry.level === 'error')
      const warns = entries.filter(entry => entry.level === 'warn')
      // 同一个问题重复报了很多次时只列一条：用户要的是「有哪几类问题」，不是日志条数。
      const issues = distinctIssues(errors)
      const configIssues = (opts.configChecks?.() ?? [])
        .filter(check => check.status !== 'ok')
        .map(check => ({
          name: check.name,
          detail: check.detail,
          ...(check.hint ? { hint: check.hint } : {}),
          ...(check.section ? { section: check.section } : {}),
          ...(check.items ? { items: check.items } : {}),
        }))
      // 高频路径降噪：同一组计数只记一次，变化时才再记一条。
      const fingerprint = `${errors.length}/${warns.length}/${configIssues.length}/${window.version}`
      if (fingerprint !== lastOverview) {
        lastOverview = fingerprint
        logger.info('logs:assistant-overview', {
          errors: errors.length,
          warns: warns.length,
          configIssues: configIssues.length,
          since: window.since,
          version: window.version,
        })
      }
      return {
        errorCount: errors.length,
        warnCount: warns.length,
        issues,
        configIssues,
        window: { since: window.since, version: window.version },
      }
    },

    diagnose(question: LogAssistantQuestion): Promise<LogDiagnosis> {
      return run(async () => {
        const text = question.question.trim().slice(0, MAX_QUESTION_CHARS)
        // 只看窗口内的日志：3 小时前或旧版本报的错不算「现在的问题」。
        const entries = scopedEntries()
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
              errors: withEvidence.filter(item => item.level === 'error').length,
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
          errors: withEvidence.filter(item => item.level === 'error').length,
        })
        return diagnosis
      })
    },
  }
}

/**
 * 把错误压成「有哪几类问题」。
 *
 * 同一条错误反复出现（重试、轮询失败）时只保留最新的一条；
 * 不同事件但命中同一个问题模式时也只留一条——
 * 否则面板上会是同一句话重复十遍，那不是摘要，是噪音。
 */
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
  const detail = entry.data
    ? Object.entries(entry.data).map(([key, value]) => `${key}=${formatValue(value)}`).join(' ')
    : ''
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

  // 行动指引只取「用户该做的事」：技术细节（advice）另作折叠的补充信息。
  // 最可能那类的问题给完整步骤，其余每类只给一条——主区不是清单仓库。
  const actions: string[] = []
  for (const [index, item] of shown.entries()) {
    const steps = index === 0 ? item.symptom.steps : item.symptom.steps.slice(0, 1)
    for (const step of steps) {
      if (!actions.includes(step)) actions.push(step)
    }
  }

  // 问题描述命中的模式即使日志里没有对应事件，也给一条「该往哪看」的方向。
  for (const symptom of SYMPTOMS) {
    if (hits.some(item => item.symptom.id === symptom.id)) continue
    if (!symptom.keywords.some(keyword => question.includes(keyword))) continue
    const step = `你描述的现象属于「${symptom.title}」，但当前日志里没有对应记录；先按下面这条排查：${symptom.steps[0] ?? ''}`
    if (!actions.includes(step)) actions.push(step)
  }

  const others = ranked.length > 1 ? `另外还有 ${ranked.length - 1} 个问题，展开下面的补充细节能看到。` : ''
  const summary = !primary
    ? evidence.length > 0
      ? `最近 ${evidence.length} 条日志里没有找到已知的问题模式，暂时看不出明显故障。`
      : '最近这段时间的日志里没有可用记录，暂时看不出明显故障。'
    : primary.symptom.conclusion + others

  return {
    summary,
    causes,
    // 行动指引最多 5 条：最可能那类的问题的步骤排在前面。
    actions: actions.slice(0, 5),
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
    label: '上报 GitHub issue',
    issueTitle: `[排查助手] ${hit.symptom.title}`,
  }
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
  '回答的对象是普通用户，不是运维工程师：他们只知道「机器人没反应」，不知道 open_id、worktree、事件名。',
  '用户会给出相关的服务日志（每行一条 JSON 事件，事件名形如 域:动作）。',
  '请只依据给出的日志判断，不要编造日志里没有的事实；信息不足时明确说「日志里看不到」。',
  '可以调用工具查看本机的 router-agent 配置与安装目录下的代码来核实判断；工具是只读的，只能读不能改。',
  '写给用户看的话要像客服说明，不要像日志分析报告：不要出现事件名、字段名、代码标识符。',
  '输出严格的 JSON，不要加解释性文字或代码块围栏：',
  '{"summary":"一句话结论","causes":[{"title":"可能原因","detail":"为什么","events":["支撑的事件名"],"category":"config|defect"}],"actions":["建议的下一步操作"]}',
  'causes 最多 3 条，actions 最多 5 条；没有证据支撑的原因不要写。',
  'category 填 config 表示这是配置问题、用户自己能改，填 defect 表示这是缺陷或体验问题、应该上报。',
  'summary 用一句普通话说清「现在是什么情况、要不要紧」，例如「机器人收不到消息是因为允许名单里少了两个人」。',
  'causes[].title 是人话原因；causes[].detail 与 events 是补充细节，可以出现事件名。',
  'actions 每条都是用户能直接照做的动作，写清「改哪一项、去哪改」；不要写「查看日志」这种没有落点的动作。',
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
      steps.push({ kind: 'issue', label: '上报 GitHub issue' })
    }
    return steps
  }
  steps.push({ kind: 'issue', label: '上报 GitHub issue' })
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
